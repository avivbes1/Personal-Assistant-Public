#!/usr/bin/env python3
"""
M3: PDF form filler with per-field provenance.

Usage:
  python3 form-filler.py <input.pdf> <fields.json> <output.pdf> [--preview <preview.png>]

fields.json schema:
  {
    "fields": [
      { "label": "שם משפחה", "value": "בסינסקי", "source": "user answer on 2026-09-16" },
      ...
    ],
    "circles": [
      { "text": "פעמיים בשבוע", "color": [1,0,0] },
      ...
    ],
    "freetext": [
      { "x": 250, "y": 715, "value": "אלרגיה לדבורים", "source": "user answer" }
    ]
  }

The script:
1. Checks for AcroForm widgets first (uses them if present)
2. Falls back to coordinate-based overlay using TextWriter(right_to_left=True)
3. Produces a filled PDF + optional rasterized preview
4. Prints a JSON provenance report to stdout
"""

import sys
import json
import os
import pymupdf

HEBREW_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
DEFAULT_FONTSIZE = 10
PREVIEW_DPI = 150


def find_blank_regions(page):
    """Locate blank regions: underscore text tokens AND drawn horizontal lines."""
    words = page.get_text("words")
    blanks = []
    labels = []

    for w in words:
        x0, y0, x1, y1, text, block, line, word_n = w
        # O3: match any token containing underscores (not just ___)
        if "_" in text and text.replace("_", "").replace(" ", "") == "":
            blanks.append({"x0": x0, "y0": y0, "x1": x1, "y1": y1, "text": text})
        elif "___" in text:
            blanks.append({"x0": x0, "y0": y0, "x1": x1, "y1": y1, "text": text})
        else:
            labels.append({"x0": x0, "y0": y0, "x1": x1, "y1": y1, "text": text})

    # O3: also detect drawn horizontal lines as blank regions
    try:
        drawings = page.get_drawings()
        for d in drawings:
            for item in d.get("items", []):
                if item[0] == "l":  # line
                    p1, p2 = item[1], item[2]
                    if abs(p1.y - p2.y) < 2 and abs(p1.x - p2.x) > 20:
                        x0 = min(p1.x, p2.x)
                        x1 = max(p1.x, p2.x)
                        y_mid = (p1.y + p2.y) / 2
                        # Check this line isn't already covered by a text blank
                        already = any(abs(b["y0"] - y_mid) < 5 and
                                     abs(b["x0"] - x0) < 10 for b in blanks)
                        if not already:
                            blanks.append({"x0": x0, "y0": y_mid - 5,
                                          "x1": x1, "y1": y_mid + 5,
                                          "text": "[line]"})
    except Exception:
        pass  # get_drawings may not be available in all PyMuPDF versions

    return blanks, labels


def match_label_to_blank(label_text, blanks, labels):
    """Find the blank region immediately left of (or on the same line as) a label.
    
    Handles multi-word Hebrew labels by building line-level text and searching
    for the label substring within the reconstructed line.
    """
    # Group labels by line (y-coordinate, ±5 tolerance)
    lines = {}  # y_bucket → [word_dicts]
    for lb in labels:
        y_key = round(lb["y0"] / 5) * 5
        lines.setdefault(y_key, []).append(lb)

    # Search each line for the label text
    matching_line_y = None
    matching_label_x0 = None  # rightmost x of the matching label words

    for y_key, line_words in lines.items():
        # Sort RTL (right to left = descending x)
        sorted_words = sorted(line_words, key=lambda w: -w["x0"])
        line_text = " ".join(w["text"] for w in sorted_words)

        if label_text in line_text:
            matching_line_y = sorted_words[0]["y0"]
            # Find the exact position of the label in the line by matching
            # consecutive words that form the label text
            label_words = label_text.split()
            for i in range(len(sorted_words) - len(label_words) + 1):
                candidate = " ".join(sorted_words[i + j]["text"] for j in range(len(label_words)))
                if candidate == label_text:
                    # Use the rightmost word of this match (first in RTL order)
                    matching_label_x0 = sorted_words[i]["x0"]
                    break
            if matching_label_x0 is None:
                # Fallback: use the first word that matches any part
                for w in sorted_words:
                    if w["text"] in label_words:
                        matching_label_x0 = w["x0"]
                        break
            if matching_label_x0 is None:
                matching_label_x0 = sorted_words[0]["x0"]
            break

    # Also try single-word match as fallback
    if matching_line_y is None:
        for lb in labels:
            if label_text in lb["text"] or lb["text"].rstrip(":") == label_text:
                matching_line_y = lb["y0"]
                matching_label_x0 = lb["x0"]
                break

    if matching_line_y is None:
        return None

    # Find blanks on the same line (within ±8 y tolerance)
    same_line_blanks = [b for b in blanks if abs(b["y0"] - matching_line_y) < 8]

    if not same_line_blanks:
        return None

    # O4: For RTL, find the blank immediately left of the label,
    # bounded by the next label to the left (prevent cross-field stealing)
    if matching_label_x0 is not None:
        # Find words that are part of the matched label (to exclude from boundary)
        label_parts = set(label_text.split())
        same_line_labels = [lb for lb in labels if abs(lb["y0"] - matching_line_y) < 8]

        # The matched label occupies a range — find the leftmost part of it
        matched_label_words = [lb for lb in same_line_labels
                              if lb["text"].rstrip(":") in label_parts or lb["text"] == ":"]
        # Label's left edge = min x0 of its component words
        label_left_edge = matching_label_x0
        for mlw in matched_label_words:
            if mlw["x0"] < matching_label_x0 and mlw["x0"] > matching_label_x0 - 100:
                label_left_edge = min(label_left_edge, mlw["x0"])

        # Find the nearest OTHER label to the left
        left_boundary = 0  # page left edge
        for lb in same_line_labels:
            # Skip colons and words that are part of our label
            if lb["text"] == ":" or lb["text"].rstrip(":") in label_parts:
                continue
            if lb["x1"] < label_left_edge - 2:
                left_boundary = max(left_boundary, lb["x1"])

        left_blanks = [b for b in same_line_blanks
                      if b["x1"] <= label_left_edge + 5 and b["x0"] >= left_boundary - 5]
        if left_blanks:
            return max(left_blanks, key=lambda b: b["x0"])

    # No bounded blank found — do NOT fall back to "any blank on the same line"
    return None


def find_text_region(page, search_text):
    """Find the bounding box of a text string on the page."""
    instances = page.search_for(search_text)
    if instances:
        return instances[0]  # First match
    return None


def fill_form(input_path, fields_json, output_path, preview_path=None):
    doc = pymupdf.open(input_path)
    page = doc[0]

    font = pymupdf.Font(fontfile=HEBREW_FONT)
    report = {"filled": [], "blank": [], "circles": [], "errors": []}

    # Step 1: Check for AcroForm widgets
    widgets = list(page.widgets())
    if widgets:
        report["method"] = "acroform"
        for field_spec in fields_json.get("fields", []):
            label = field_spec["label"]
            value = field_spec["value"]
            source = field_spec.get("source", "unknown")

            matched = False
            for w in widgets:
                if w.field_name and label.lower() in w.field_name.lower():
                    w.field_value = value
                    w.update()
                    report["filled"].append({
                        "field": label, "value": value, "source": source,
                        "method": "acroform", "widget": w.field_name
                    })
                    matched = True
                    break

            if not matched:
                report["blank"].append({
                    "field": label, "reason": f"no matching widget for '{label}'"
                })
    else:
        # Step 2: Coordinate-based overlay
        report["method"] = "overlay"
        blanks, labels = find_blank_regions(page)
        tw = pymupdf.TextWriter(page.rect)

        for field_spec in fields_json.get("fields", []):
            label = field_spec["label"]
            value = field_spec["value"]
            source = field_spec.get("source", "unknown")

            if not value:
                report["blank"].append({"field": label, "reason": "no value provided", "source": source})
                continue

            if not source or source == "unknown":
                report["blank"].append({"field": label, "reason": "no provenance — left blank", "value": value})
                continue

            blank = match_label_to_blank(label, blanks, labels)
            if blank:
                is_hebrew = any("\u0590" <= c <= "\u05FF" for c in value)
                fontsize = field_spec.get("fontsize", DEFAULT_FONTSIZE)

                # O1: anchor by direction — RTL from right edge, LTR from left edge
                if is_hebrew:
                    anchor_x = blank["x1"]  # right edge, text flows left
                else:
                    anchor_x = blank["x0"]  # left edge, text flows right

                # O2: use bottom of blank (baseline) instead of top
                text_y = blank["y1"] - 2

                # O5: check if text fits in blank width, shrink if needed
                text_width = font.text_length(value, fontsize)
                blank_width = blank["x1"] - blank["x0"]
                if text_width > blank_width and blank_width > 0:
                    fitted_size = fontsize * (blank_width / text_width) * 0.95
                    if fitted_size >= 6:
                        fontsize = fitted_size
                    else:
                        report["errors"].append({
                            "field": label, "error": f"text too wide ({text_width:.0f}pt) for blank ({blank_width:.0f}pt), min font would be <6pt"
                        })

                try:
                    tw.append(
                        (anchor_x, text_y), value, font=font,
                        fontsize=fontsize, right_to_left=is_hebrew
                    )
                    report["filled"].append({
                        "field": label, "value": value, "source": source,
                        "method": "overlay",
                        "position": {"x": round(anchor_x, 1), "y": round(text_y, 1)}
                    })
                except Exception as e:
                    report["errors"].append({
                        "field": label, "error": str(e)
                    })
            else:
                # Try explicit coordinates if provided
                if "x" in field_spec and "y" in field_spec:
                    is_hebrew = any("\u0590" <= c <= "\u05FF" for c in value)
                    try:
                        tw.append(
                            (field_spec["x"], field_spec["y"]), value, font=font,
                            fontsize=field_spec.get("fontsize", DEFAULT_FONTSIZE),
                            right_to_left=is_hebrew
                        )
                        report["filled"].append({
                            "field": label, "value": value, "source": source,
                            "method": "explicit_coords",
                            "position": {"x": field_spec["x"], "y": field_spec["y"]}
                        })
                    except Exception as e:
                        report["errors"].append({"field": label, "error": str(e)})
                else:
                    report["blank"].append({
                        "field": label, "reason": f"could not locate blank for '{label}'",
                        "value": value
                    })

        # Handle freetext entries (explicit coordinates)
        for ft in fields_json.get("freetext", []):
            value = ft["value"]
            source = ft.get("source", "unknown")
            if not source or source == "unknown":
                report["blank"].append({
                    "field": ft.get("label", "freetext"),
                    "reason": "no provenance — left blank", "value": value
                })
                continue
            is_hebrew = any("\u0590" <= c <= "\u05FF" for c in value)
            try:
                tw.append(
                    (ft["x"], ft["y"]), value, font=font,
                    fontsize=ft.get("fontsize", DEFAULT_FONTSIZE),
                    right_to_left=is_hebrew
                )
                report["filled"].append({
                    "field": ft.get("label", "freetext"),
                    "value": value, "source": source,
                    "method": "freetext",
                    "position": {"x": ft["x"], "y": ft["y"]}
                })
            except Exception as e:
                report["errors"].append({
                    "field": ft.get("label", "freetext"), "error": str(e)
                })

        # O5: collision detection — check overlaid text against existing page words
        original_words = page.get_text("words")
        original_bboxes = [pymupdf.Rect(w[0], w[1], w[2], w[3]) for w in original_words
                          if not ("_" in w[4] and w[4].replace("_", "").replace(" ", "") == "")]
        for entry in report["filled"]:
            if entry["method"] in ("overlay",):
                pos = entry.get("position", {})
                px, py = pos.get("x", 0), pos.get("y", 0)
                val = entry["value"]
                fs = DEFAULT_FONTSIZE
                tw_len = font.text_length(val, fs)
                # Approximate the text rect
                if any("\u0590" <= c <= "\u05FF" for c in val):
                    text_rect = pymupdf.Rect(px - tw_len, py - fs, px, py + 2)
                else:
                    text_rect = pymupdf.Rect(px, py - fs, px + tw_len, py + 2)
                for ob in original_bboxes:
                    if text_rect.intersects(ob):
                        # Find what word it collides with
                        colliding_word = next(
                            (w[4] for w in original_words
                             if abs(w[0] - ob.x0) < 1 and abs(w[1] - ob.y0) < 1),
                            "?"
                        )
                        report.setdefault("collisions", []).append({
                            "field": entry["field"],
                            "value": val,
                            "collides_with": colliding_word,
                            "text_rect": [round(text_rect.x0, 1), round(text_rect.y0, 1),
                                         round(text_rect.x1, 1), round(text_rect.y1, 1)],
                            "word_rect": [round(ob.x0, 1), round(ob.y0, 1),
                                         round(ob.x1, 1), round(ob.y1, 1)]
                        })
                        break

        tw.write_text(page)

    # Step 3: Draw circles (selections)
    for circle_spec in fields_json.get("circles", []):
        search = circle_spec.get("text", "")
        color = tuple(circle_spec.get("color", [1, 0, 0]))
        width = circle_spec.get("width", 1.5)
        padding = circle_spec.get("padding", 4)

        if "rect" in circle_spec:
            r = circle_spec["rect"]
            rect = pymupdf.Rect(r[0], r[1], r[2], r[3])
        elif search:
            region = find_text_region(page, search)
            if region:
                rect = pymupdf.Rect(
                    region.x0 - padding, region.y0 - padding,
                    region.x1 + padding, region.y1 + padding
                )
            else:
                report["errors"].append({"circle": search, "error": "text not found on page"})
                continue
        else:
            continue

        page.draw_oval(rect, color=color, width=width)
        report["circles"].append({"text": search, "rect": [rect.x0, rect.y0, rect.x1, rect.y1]})

    # Save
    doc.save(output_path)

    # Step 4: Preview
    if preview_path:
        pix = page.get_pixmap(dpi=PREVIEW_DPI)
        pix.save(preview_path)
        report["preview"] = preview_path

    doc.close()
    report["output"] = output_path
    return report


def main():
    if len(sys.argv) < 4:
        print("Usage: form-filler.py <input.pdf> <fields.json> <output.pdf> [--preview <img.png>]",
              file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    fields_path = sys.argv[2]
    output_path = sys.argv[3]

    preview_path = None
    if "--preview" in sys.argv:
        idx = sys.argv.index("--preview")
        if idx + 1 < len(sys.argv):
            preview_path = sys.argv[idx + 1]

    if not os.path.exists(input_path):
        print(json.dumps({"error": f"Input file not found: {input_path}"}))
        sys.exit(1)

    with open(fields_path, "r", encoding="utf-8") as f:
        fields_json = json.load(f)

    report = fill_form(input_path, fields_json, output_path, preview_path)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
