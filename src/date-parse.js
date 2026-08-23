'use strict';

/**
 * date-parse.js — Hebrew-aware date parser for notice ingestion.
 *
 * Explicit dates (dd.mm.yy / dd.mm.yyyy / dd/mm etc.) take precedence
 * over weekday inference. When both are present and conflict, the explicit
 * date wins and weekday_mismatch is flagged.
 *
 * This fixes the RC-2 bug where "יום שישי, 21.8.26" was stored as 22.8
 * because weekday inference overwrote the explicit date.
 */

// Hebrew weekday name → JS Date.getDay() index (0 = Sunday … 6 = Saturday)
const WEEKDAYS_HE = {
  'ראשון': 0,
  'שני':   1,
  'שלישי': 2,
  'רביעי': 3,
  'חמישי': 4,
  'שישי':  5,
  'שבת':   6,
};

/**
 * Extract the first explicit dd.mm[.yy[yy]] or dd/mm[/yy[yy]] date from text.
 * @param {string} text
 * @returns {{ day, month, year, iso }|null}
 */
function extractExplicitDate(text) {
  if (!text) return null;
  // Matches: 21.8.26, 21.8.2026, 21/8/26, 21.8, 21/8
  // Requires day 1-31 and month 1-12 to be plausible
  const m = text.match(/(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/);
  if (!m) return null;

  let day = parseInt(m[1], 10);
  let month = parseInt(m[2], 10);
  let rawYear = m[3];

  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  let year;
  if (!rawYear) {
    // No year given — use current Israel year; if date already passed by >60 days, use next year
    const nowIL = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    year = nowIL.getFullYear();
    const candidate = new Date(year, month - 1, day);
    if (candidate < new Date(nowIL.getTime() - 60 * 86400000)) year++;
  } else {
    year = parseInt(rawYear, 10);
    if (year < 100) year += 2000;
  }

  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { day, month, year, iso };
}

/**
 * Extract the first Hebrew weekday name from text.
 * @param {string} text
 * @returns {number|null} 0=Sun … 6=Sat, or null if not found
 */
function extractHebrewWeekday(text) {
  if (!text) return null;
  for (const [name, idx] of Object.entries(WEEKDAYS_HE)) {
    if (text.includes(name)) return idx;
  }
  return null;
}

/**
 * Compute next occurrence of a weekday (Israel timezone).
 * Never returns today — always ≥1 day ahead.
 * @param {number} weekdayIdx 0=Sun … 6=Sat
 * @returns {{ day, month, year, iso }}
 */
function nextOccurrence(weekdayIdx) {
  const nowIL = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const diff = ((weekdayIdx - nowIL.getDay() + 7) % 7) || 7;
  const target = new Date(nowIL);
  target.setDate(target.getDate() + diff);
  const day = target.getDate();
  const month = target.getMonth() + 1;
  const year = target.getFullYear();
  return {
    day, month, year,
    iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

/**
 * Parse a date from Hebrew text with explicit-date-first precedence.
 *
 * @param {string} text
 * @returns {{
 *   day: number, month: number, year: number, iso: string,
 *   weekday_mismatch: boolean, inferred_from_weekday: boolean
 * }|null}
 */
function parseDate(text) {
  if (!text || typeof text !== 'string') return null;

  const explicit = extractExplicitDate(text);
  const weekday  = extractHebrewWeekday(text);

  if (explicit) {
    if (weekday !== null) {
      // Verify weekday matches explicit date
      const actual = new Date(explicit.year, explicit.month - 1, explicit.day).getDay();
      if (actual !== weekday) {
        console.warn(
          `[DateParse] Weekday mismatch: text implies weekday ${weekday}, ` +
          `but ${explicit.iso} is weekday ${actual}. Trusting explicit date.`
        );
        return { ...explicit, weekday_mismatch: true, inferred_from_weekday: false };
      }
    }
    return { ...explicit, weekday_mismatch: false, inferred_from_weekday: false };
  }

  if (weekday !== null) {
    return { ...nextOccurrence(weekday), weekday_mismatch: false, inferred_from_weekday: true };
  }

  return null;
}

module.exports = { parseDate, extractExplicitDate, extractHebrewWeekday, nextOccurrence };
