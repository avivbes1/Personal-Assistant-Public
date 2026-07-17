/**
 * normalizer.js
 * Deterministic best-effort replacement of relative Hebrew date words
 * with absolute dates in notice content.
 * Uses anchor date (message_sent_at) as reference point.
 */

const ISRAEL_TZ = 'Asia/Jerusalem';

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00+03:00`);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('en-CA', { timeZone: ISRAEL_TZ });
}

function formatDate(dateStr) {
  // YYYY-MM-DD -> DD.MM
  const m = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateStr;
  return `${parseInt(m[3])}.${parseInt(m[2])}`;
}

// Hebrew day name → offset from Sunday (Israel week starts Sunday)
const HE_DAY_OFFSET = {
  'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3,
  'חמישי': 4, 'שישי': 5, 'שבת': 6
};

function nextWeekday(anchorDateStr, hebrewDayName) {
  // Returns the date of hebrewDayName in the week AFTER anchor's week
  const anchor = new Date(`${anchorDateStr}T12:00:00+03:00`);
  const anchorDay = anchor.getDay(); // 0=Sun
  const targetDay = HE_DAY_OFFSET[hebrewDayName];
  if (targetDay === undefined) return null;
  // Days until next occurrence of targetDay, starting from next Sunday
  const daysUntilNextSunday = (7 - anchorDay) % 7 || 7;
  const daysFromAnchor = daysUntilNextSunday + targetDay;
  const result = new Date(anchor);
  result.setDate(result.getDate() + daysFromAnchor);
  return result.toLocaleDateString('en-CA', { timeZone: ISRAEL_TZ });
}

function thisWeekday(anchorDateStr, hebrewDayName) {
  // Returns the date of hebrewDayName in anchor's current week
  const anchor = new Date(`${anchorDateStr}T12:00:00+03:00`);
  const anchorDay = anchor.getDay(); // 0=Sun
  const targetDay = HE_DAY_OFFSET[hebrewDayName];
  if (targetDay === undefined) return null;
  const diff = targetDay - anchorDay;
  const result = new Date(anchor);
  result.setDate(result.getDate() + diff);
  return result.toLocaleDateString('en-CA', { timeZone: ISRAEL_TZ });
}

/**
 * Normalize relative date words in content using anchor date.
 * Returns { normalized: string, changed: boolean }
 */
function normalizeNoticeContent(content, anchorDateStr) {
  if (!content || !anchorDateStr) return { normalized: content, changed: false };

  let text = content;
  const tomorrow = addDays(anchorDateStr, 1);
  const dayAfterTomorrow = addDays(anchorDateStr, 2);

  // Replace "מחרתיים" before "מחר" to avoid partial match issues
  // Note: \b doesn't work with Hebrew; use Unicode lookaround on non-Hebrew chars
  text = text.replace(/(?<![\u05d0-\u05ea])מחרתיים(?![\u05d0-\u05ea])/g, `${formatDate(dayAfterTomorrow)}`);
  // Replace "מחר" (tomorrow) — but not "מחרתיים"
  text = text.replace(/(?<![\u05d0-\u05ea])מחר(?!תיים)(?![\u05d0-\u05ea])/g, `${formatDate(tomorrow)} (מחר לפי ${formatDate(anchorDateStr)})`);
  // Replace "היום"
  text = text.replace(/(?<![\u05d0-\u05ea])היום(?![\u05d0-\u05ea])/g, `${formatDate(anchorDateStr)}`);

  // Replace "שבוע הבא: <dayname>" patterns
  // e.g. "שבוע הבא: שני אימון, שלישי הפנינג סיום"
  text = text.replace(/שבוע הבא[:\s]+([^\n.]+)/gi, (match, rest) => {
    // Try to expand each day name in the rest
    // Note: \b doesn't work with Hebrew; use lookahead/lookbehind on spaces/punctuation
    let expanded = rest;
    for (const heName of Object.keys(HE_DAY_OFFSET)) {
      // Match day name as a whole token (surrounded by non-Hebrew or start/end)
      const re = new RegExp(`(?<=[\\s,;:^]|^)(${heName})(?=[\\s,;:]|$)`, 'gu');
      expanded = expanded.replace(re, (_, name) => {
        const d = nextWeekday(anchorDateStr, heName);
        return d ? `${name} ${formatDate(d)}` : name;
      });
    }
    return `שבוע הבא: ${expanded}`;
  });

  const changed = text !== content;
  return { normalized: text, changed };
}

module.exports = { normalizeNoticeContent };
