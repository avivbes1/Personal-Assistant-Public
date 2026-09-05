/**
 * timeUtils.js — Israel timezone utilities.
 *
 * Single home for "what day/time is it in Israel" logic. Everything here is
 * built on `toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' })`
 * (which yields a clean YYYY-MM-DD) rather than the fragile en-US locale-string
 * round-trip (parse a Date back out of a localized string) that used to be
 * copy-pasted across the codebase. That round-trip only happens to work when
 * the host box is on UTC; these helpers are correct regardless of host TZ.
 */

const TZ = 'Asia/Jerusalem';

/**
 * Today's date in Israel as a YYYY-MM-DD string.
 * @param {Date} [now] instant to evaluate (defaults to real now)
 * @returns {string}
 */
function israelDateIso(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: TZ });
}

/**
 * Current wall-clock parts in Israel time.
 * @param {Date} [now]
 * @returns {{year:number, month:number, day:number, hours:number, minutes:number, seconds:number, dayOfWeek:number}}
 *          month is 1-12, dayOfWeek is 0 (Sun) … 6 (Sat).
 */
function israelNowParts(now = new Date()) {
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
  const [year, month, day] = dateStr.split('-').map(Number);
  // en-GB 24-hour clock → "HH:MM:SS"
  const timeStr = now.toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false });
  const [hours, minutes, seconds] = timeStr.split(':').map(Number);
  return { year, month, day, hours, minutes, seconds, dayOfWeek: israelWeekday(dateStr) };
}

/**
 * A Date object whose *local* fields (getDate/getDay/getFullYear/…) equal the
 * current Israel wall clock. This is the clean replacement for the old
 * en-US locale-string round-trip idiom that was used for date arithmetic.
 * @param {Date} [now]
 * @returns {Date}
 */
function israelNow(now = new Date()) {
  const p = israelNowParts(now);
  return new Date(p.year, p.month - 1, p.day, p.hours, p.minutes, p.seconds);
}

/**
 * Day of week (0 = Sunday … 6 = Saturday) for a YYYY-MM-DD date.
 * A calendar date's weekday is timezone-independent, so we anchor at noon UTC
 * (no DST/offset rollover) rather than round-tripping through a locale string.
 * @param {string} dateStr YYYY-MM-DD
 * @returns {number} 0-6
 */
function israelWeekday(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

/**
 * Add N days (may be negative) to a YYYY-MM-DD string, returning YYYY-MM-DD.
 * Anchors at noon UTC so a ±hour DST shift can never bump the calendar day,
 * then formats back with the Israel-timezone en-CA formatter.
 * @param {string} dateStr YYYY-MM-DD
 * @param {number} days
 * @returns {string} YYYY-MM-DD
 */
function addDaysIso(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return dt.toLocaleDateString('en-CA', { timeZone: TZ });
}

/**
 * Offset of Asia/Jerusalem from UTC (ms) at a given instant — DST aware.
 * Uses Intl.DateTimeFormat.formatToParts (NOT the toLocaleString round-trip):
 * we render the instant's Israel wall clock, read it back as if it were UTC,
 * and the difference from the true epoch is the offset.
 * @param {Date} [date]
 * @returns {number} ms east of UTC (e.g. +10800000 during IDT)
 */
function israelOffsetMs(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
  );
  return asUTC - date.getTime();
}

/**
 * Current hour (0-23) in Israel. Retained for the watchdog / health checks.
 * @param {number|Date} [now]
 * @returns {number}
 */
function getIsraelHour(now = Date.now()) {
  return israelNowParts(new Date(now)).hours;
}

module.exports = {
  israelDateIso,
  israelNowParts,
  israelNow,
  israelWeekday,
  addDaysIso,
  israelOffsetMs,
  getIsraelHour,
};
