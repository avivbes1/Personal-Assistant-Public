/**
 * dateValidator.js
 * Deterministic, regex-based day/date mismatch detector.
 *
 * School WhatsApp messages sometimes state a weekday that doesn't match the
 * date they cite — e.g. "יום שני 14.7" when July 14 is actually a Tuesday.
 * This validator flags such mismatches so delivery can prepend a warning.
 *
 * WARN-ONLY: it NEVER mutates source content. It only reports.
 *
 * Conservative by design: a mismatch is flagged ONLY when a Hebrew weekday
 * name and a date appear together in the same sentence and close to each
 * other (~30 chars), so unrelated day names and dates aren't paired up.
 */

// Hebrew weekday name → JS getDay() index (0 = Sunday … 6 = Saturday)
const HEBREW_WEEKDAYS = {
  'ראשון': 0,
  'שני': 1,
  'שלישי': 2,
  'רביעי': 3,
  'חמישי': 4,
  'שישי': 5,
  'שבת': 6,
};

const WEEKDAY_DISPLAY = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// Israel standard offset used for the date→weekday calculation (UTC+3).
const ISRAEL_OFFSET_MS = 3 * 60 * 60 * 1000;

// Max character distance between a day name and a date to consider them related.
const PROXIMITY_CHARS = 30;

// Matches a Hebrew weekday, optionally prefixed with "יום".
// Capturing group 1 = the weekday word.
const DAY_NAME_RE = /(?:יום\s+)?(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/g;

// Matches DD.MM, DD.MM.YY, or DD.MM.YYYY (also tolerates / and - separators).
const DATE_RE = /(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?/g;

/**
 * Compute the weekday (0=Sun..6=Sat) for a given day/month/year in Israel time.
 * Uses a fixed UTC+3 offset (matches how the rest of the bot treats Israel time).
 */
function weekdayForDate(day, month, year) {
  // Build a UTC timestamp for local-Israel midnight, then read the weekday.
  const utcMs = Date.UTC(year, month - 1, day) - ISRAEL_OFFSET_MS;
  return new Date(utcMs + ISRAEL_OFFSET_MS).getUTCDay();
}

/**
 * Resolve a possibly-missing / 2-digit year to a full year.
 * When absent, assume the current Israel year.
 */
function resolveYear(rawYear) {
  if (rawYear === undefined) {
    const nowIsrael = new Date(Date.now() + ISRAEL_OFFSET_MS);
    return nowIsrael.getUTCFullYear();
  }
  const y = parseInt(rawYear, 10);
  if (y < 100) return 2000 + y;
  return y;
}

/**
 * Split text into sentence-ish segments. Hebrew notices rarely use rich
 * punctuation, so we split on newlines and common sentence terminators.
 */
function splitSentences(text) {
  // Split on newlines and sentence terminators. A period only terminates a
  // sentence when it is NOT between two digits — so dates like "14.7" stay
  // intact rather than being torn into "14" and "7".
  return text.split(/[\n\r!?;]+|(?<!\d)\.(?!\d)|\s{2,}/);
}

/**
 * Validate a notice's text for day/date mismatches.
 * @param {string} text
 * @returns {{ mismatch: boolean, notes: string|null }}
 */
function validateNoticeDate(text) {
  if (!text || typeof text !== 'string') {
    return { mismatch: false, notes: null };
  }

  const mismatches = [];
  const sentences = splitSentences(text);

  for (const sentence of sentences) {
    // Collect all day names with their positions.
    const dayHits = [];
    DAY_NAME_RE.lastIndex = 0;
    let m;
    while ((m = DAY_NAME_RE.exec(sentence)) !== null) {
      dayHits.push({ name: m[1], index: m.index, end: m.index + m[0].length });
    }
    if (dayHits.length === 0) continue;

    // Collect all dates with their positions.
    const dateHits = [];
    DATE_RE.lastIndex = 0;
    while ((m = DATE_RE.exec(sentence)) !== null) {
      const day = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      if (day < 1 || day > 31 || month < 1 || month > 12) continue;
      dateHits.push({
        day, month, rawYear: m[3],
        raw: m[0], index: m.index, end: m.index + m[0].length,
      });
    }
    if (dateHits.length === 0) continue;

    // Pair each day name with the nearest date within proximity.
    for (const dh of dayHits) {
      let nearest = null;
      let nearestDist = Infinity;
      for (const dt of dateHits) {
        // distance = gap between the two spans (0 if overlapping/adjacent)
        const dist = dh.index > dt.end
          ? dh.index - dt.end
          : dt.index > dh.end
            ? dt.index - dh.end
            : 0;
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = dt;
        }
      }
      if (!nearest || nearestDist > PROXIMITY_CHARS) continue;

      const statedIdx = HEBREW_WEEKDAYS[dh.name];
      const year = resolveYear(nearest.rawYear);
      const actualIdx = weekdayForDate(nearest.day, nearest.month, year);

      if (statedIdx !== actualIdx) {
        mismatches.push(
          `לתשומת לבך: במקור נכתב "יום ${dh.name}" עבור ${nearest.raw}, ` +
          `אך ${nearest.raw} חל בפועל ביום ${WEEKDAY_DISPLAY[actualIdx]}.`
        );
      }
    }
  }

  if (mismatches.length === 0) {
    return { mismatch: false, notes: null };
  }
  // Dedupe identical notes (same day/date can repeat across sentences).
  const unique = [...new Set(mismatches)];
  return { mismatch: true, notes: unique.join(' ') };
}

module.exports = { validateNoticeDate };
