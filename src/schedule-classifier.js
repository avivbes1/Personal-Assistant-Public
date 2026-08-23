'use strict';

/**
 * schedule-classifier.js
 *
 * Deterministic classifier for Hebrew schedule/event queries.
 * Returns structured metadata without any LLM involvement.
 *
 * Primary path: if isScheduleQuery() returns true, the caller should
 * query the NoticeRepository before calling the LLM, and inject results
 * as context. This eliminates "LLM forgot to call the tool" failures.
 *
 * Secondary path: the LLM still has a lookupEvents tool available as
 * fallback for queries the regex misses.
 */

const { parseDate } = require('./date-parse');

// Known children — loaded from family-context if available
let CHILD_NAMES = [];
try {
  // family-context exports getProfile() which returns the loaded profile
  const fc = require('./family-context');
  if (typeof fc.getProfile === 'function') {
    const profile = fc.getProfile();
    if (profile && profile.members) {
      CHILD_NAMES = Object.keys(profile.members);
    }
  }
} catch (_) {
  // family-context not loaded yet or doesn't export getProfile — use defaults
}

// Patterns that indicate a schedule / upcoming-events question
const SCHEDULE_PATTERNS = [
  /יש ל\S+ משהו/,                                          // "יש לנטע משהו"
  /מה (יש|קורה|מתוכנן|קורא)/,                             // "מה יש מחר"
  /ביום (ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/,         // "ביום שישי"
  /מחר|היום|הלילה|השבוע|בשבוע הבא|בשבוע הזה/,           // temporal keywords
  /לוח (זמנים|אירועים)/,                                   // "לוח זמנים"
  /אירועים? (קרוב|הקרוב|הבא)/,                            // "אירוע קרוב"
  /מה (ה)?תכנית/,                                           // "מה התכנית"
  /מתי (ה[^\s]+|יהיה|קורה)/,                              // "מתי האירוע"
  /יש (לנו|לי|ל\S+) (אירוע|אירועים|כלום|משהו|פעילות)/,  // "יש לנו אירוע"
  /עדכוני?(ם)? (ל|על|של|ב)/,                              // "עדכונים לשבוע"
  /מה (קורה|יש) (היום|מחר|בשבוע|השבוע)/,                // "מה קורה מחר"
  /יש (חוגים?|פעילות|טיול|מסיבה|אירוע)/,                // "יש טיול"
  /מה (נדרש|צריך|אמור) ל/,                                // "מה נדרש לשגב"
];

/**
 * Determine if a message is asking about upcoming events or schedule.
 * @param {string} text
 * @returns {boolean}
 */
function isScheduleQuery(text) {
  if (!text || typeof text !== 'string') return false;
  return SCHEDULE_PATTERNS.some(p => p.test(text));
}

/**
 * Extract a child name from text if present.
 * @param {string} text
 * @returns {string|null}
 */
function extractChildName(text) {
  if (!text) return null;
  for (const name of CHILD_NAMES) {
    if (text.includes(name)) return name;
  }
  return null;
}

/**
 * Classify a schedule query and extract structured date/child metadata.
 *
 * @param {string} text
 * @returns {{
 *   isScheduleQuery: boolean,
 *   childName: string|null,
 *   dateHint: string|null,
 *   dateRange: { from: string, to: string }|null
 * }}
 */
function classifyScheduleQuery(text) {
  const isSchedule = isScheduleQuery(text);
  if (!isSchedule) {
    return { isScheduleQuery: false, childName: null, dateHint: null, dateRange: null };
  }

  const childName  = extractChildName(text);
  const parsedDate = parseDate(text);

  const nowIL   = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const todayIso = nowIL.toISOString().slice(0, 10);

  let dateRange = null;
  let dateHint  = null;

  if (parsedDate && !parsedDate.inferred_from_weekday && !parsedDate.weekday_mismatch) {
    // Explicit, unambiguous date in message
    dateRange = { from: parsedDate.iso, to: parsedDate.iso };
    dateHint  = parsedDate.iso;
  } else if (/מחר/.test(text)) {
    const tomorrow = new Date(nowIL);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tIso = tomorrow.toISOString().slice(0, 10);
    dateRange = { from: tIso, to: tIso };
    dateHint  = 'tomorrow';
  } else if (/היום|הלילה/.test(text)) {
    dateRange = { from: todayIso, to: todayIso };
    dateHint  = 'today';
  } else if (/בשבוע הבא/.test(text)) {
    const start = new Date(nowIL);
    start.setDate(start.getDate() + 7);
    const end = new Date(nowIL);
    end.setDate(end.getDate() + 14);
    dateRange = { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
    dateHint  = 'next_week';
  } else if (/השבוע|בשבוע הזה/.test(text)) {
    const end = new Date(nowIL);
    end.setDate(end.getDate() + 7);
    dateRange = { from: todayIso, to: end.toISOString().slice(0, 10) };
    dateHint  = 'this_week';
  } else if (parsedDate) {
    // Inferred from weekday or mismatched — still use it as best effort
    dateRange = { from: parsedDate.iso, to: parsedDate.iso };
    dateHint  = parsedDate.iso;
  } else {
    // Default: next 7 days
    const end = new Date(nowIL);
    end.setDate(end.getDate() + 7);
    dateRange = { from: todayIso, to: end.toISOString().slice(0, 10) };
    dateHint  = 'next_7_days';
  }

  return { isScheduleQuery: true, childName, dateHint, dateRange };
}

module.exports = { isScheduleQuery, classifyScheduleQuery, extractChildName, CHILD_NAMES };
