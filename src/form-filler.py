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
    """Locate ___ blank runs and their adjacent labels."""
    words = page.get_text("words")
    blanks = []
    labels = []

    for w in words:
        x0, y0, x1, y1, text, block, line, word_n = w
        if "___" in text:
            blanks.append({"x0": x0, "y0": y0, "x1": x1, "y1": y1, "text": text})
        else:
            labels.append({"x0": x0, "y0": y0, "x1": x1, "y1": y1, "text": text})

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
            # Find the rightmost label word to anchor from
            for w in sorted_words:
                if any(part in w["text"] for part in label_text.split()):
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

    # For RTL: the blank to the LEFT of the label (lower x)
    if matching_label_x0 is not None:
        left_blanks = [b for b in same_line_blanks if b["x1"] <= matching_label_x0 + 5]
        if left_blanks:
            # Closest to the label
            return max(left_blanks, key=lambda b: b["x0"])

    # Fallback: any blank on the same line
    return same_line_blanks[0]


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
                mid_x = (blank["x0"] + blank["x1"]) / 2
                text_y = blank["y0"] + 2

                is_hebrew = any("\u0590" <= c <= "\u05FF" for c in value)
                fontsize = field_spec.get("fontsize", DEFAULT_FONTSIZE)

                try:
                    tw.append(
                        (mid_x, text_y), value, font=font,
                        fontsize=fontsize, right_to_left=is_hebrew
                    )
                    report["filled"].append({
                        "field": label, "value": value, "source": source,
                        "method": "overlay",
                        "position": {"x": round(mid_x, 1), "y": round(text_y, 1)}
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
