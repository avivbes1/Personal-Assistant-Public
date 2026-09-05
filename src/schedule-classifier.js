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
  // Q5: additional schedule/logistics phrasings
  /באיזה שעה/,                                             // "באיזה שעה"
  /איפה (ה|יהיה)/,                                        // "איפה האירוע / איפה יהיה"
  /מה עם ה/,                                               // "מה עם המסיבה"
  /כמה עולה/,                                              // "כמה עולה"
  /מתי (מתחיל|מתחילה|מסתיים|מסתיימת)/,                    // "מתי מתחיל / מתי מסתיים"
  /צריך להביא/,                                            // "צריך להביא"
  /יש ל\S+ (חוג|אימון|שיעור)/,                            // "יש לנטע חוג"
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

  const { israelDateIso, addDaysIso } = require('./timeUtils');
  const todayIso = israelDateIso();

  let dateRange = null;
  let dateHint  = null;

  if (parsedDate && !parsedDate.inferred_from_weekday && !parsedDate.weekday_mismatch) {
    // Explicit, unambiguous date in message
    dateRange = { from: parsedDate.iso, to: parsedDate.iso };
    dateHint  = parsedDate.iso;
  } else if (/מחר/.test(text)) {
    const tIso = addDaysIso(todayIso, 1);
    dateRange = { from: tIso, to: tIso };
    dateHint  = 'tomorrow';
  } else if (/היום|הלילה/.test(text)) {
    dateRange = { from: todayIso, to: todayIso };
    dateHint  = 'today';
  } else if (/בשבוע הבא/.test(text)) {
    dateRange = { from: addDaysIso(todayIso, 7), to: addDaysIso(todayIso, 14) };
    dateHint  = 'next_week';
  } else if (/השבוע|בשבוע הזה/.test(text)) {
    dateRange = { from: todayIso, to: addDaysIso(todayIso, 7) };
    dateHint  = 'this_week';
  } else if (parsedDate) {
    // Inferred from weekday or mismatched — still use it as best effort
    dateRange = { from: parsedDate.iso, to: parsedDate.iso };
    dateHint  = parsedDate.iso;
  } else {
    // Default: next 7 days
    dateRange = { from: todayIso, to: addDaysIso(todayIso, 7) };
    dateHint  = 'next_7_days';
  }

  return { isScheduleQuery: true, childName, dateHint, dateRange };
}

/**
 * Q4: Pre-fetch the notices relevant to a schedule query and format them as an
 * LLM context block. This is the "primary path" described at the top of this
 * file — the caller injects the result into the prompt so the answer is grounded
 * in real notices instead of relying on the LLM to remember to call a lookup.
 *
 * It is a HINT, never a gate: when the text is not a schedule query, or nothing
 * matches, it returns '' and the caller's behaviour is unchanged. Notice ids are
 * included so the answering LLM can cite its source (G1).
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {object} [opts.repo]  Injectable NoticeRepository (for tests)
 * @returns {string}  context block, or '' when there is nothing to add
 */
function buildScheduleHint(text, opts = {}) {
  const cls = classifyScheduleQuery(text);
  if (!cls.isScheduleQuery) return '';

  let repo = opts.repo;
  if (!repo) {
    try {
      const { NoticeRepository } = require('./notices/repository');
      repo = new NoticeRepository();
    } catch (_) {
      return ''; // repository unavailable — degrade silently, never block the answer
    }
  }

  try {
    const range = cls.dateRange || {};
    let rows = repo.findUpcoming({
      from:      range.from,
      to:        range.to,
      childName: cls.childName || null,
    });
    // Widen to a content search when the date window turns up nothing.
    if (!rows || rows.length === 0) {
      rows = repo.findByContent({ childName: cls.childName || null });
    }
    if (!rows || rows.length === 0) return '';

    const lines = rows.slice(0, 12).map(r => {
      const date = r.relevance_date || 'ללא תאריך';
      const time = r.relevance_time ? ` ${r.relevance_time}` : '';
      const grp  = r.group_name ? ` [${r.group_name}]` : '';
      const body = (r.content || '').replace(/\s+/g, ' ').trim().substring(0, 160);
      return `• [notice:${r.id}] ${date}${time}${grp}: ${body}`;
    });

    return `\n## התראות רלוונטיות לשאלה (נשלפו מראש):\n${lines.join('\n')}\n`;
  } catch (e) {
    console.warn('[ScheduleClassifier] buildScheduleHint error:', e.message);
    return '';
  }
}

module.exports = { isScheduleQuery, classifyScheduleQuery, extractChildName, buildScheduleHint, CHILD_NAMES };
