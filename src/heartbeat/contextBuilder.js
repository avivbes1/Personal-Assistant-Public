'use strict';
/**
 * contextBuilder.js — assembles the grounded candidate list for the reminder
 * heartbeat. The LLM is ONLY ever shown events that come out of here, and can
 * only ever reference their real DB ids.
 *
 * getUpcomingEvents(hoursAhead) returns:
 *   { notice_events: [...], calendar_events: [...] }
 * where each item is { source_type, source_id, title, date, time, event_ms }.
 *
 * Schema note: the concrete calendar table is `calendar_intents` (there is no
 * `calendar_events` table). We keep the `calendar_events` key in the returned
 * object for the caller's convenience, but source_type is `calendar_intents`.
 */

const { getDB } = require('../db');

// Same Israel-time anchor convention used across the codebase.
function toIsraelMs(dateStr, timeStr) {
  if (!dateStr) return null;
  const hhmm = timeStr && /^\d{1,2}:\d{2}$/.test(timeStr) ? timeStr : '00:00';
  const [h, m] = hhmm.split(':').map(Number);
  const iso = `${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+03:00`;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function isSent(db, sourceType, sourceId) {
  return !!db.prepare(
    'SELECT 1 FROM sent_reminders WHERE source_type = ? AND source_id = ?'
  ).get(sourceType, sourceId);
}

/**
 * @param {number} hoursAhead - how far forward to look (default 6h)
 * @returns {{notice_events: Array, calendar_events: Array}}
 */
function getUpcomingEvents(hoursAhead = 6) {
  const db = getDB();
  const now = Date.now();
  const windowEnd = now + hoursAhead * 60 * 60 * 1000;
  // Small grace window into the recent past so an event that just started still
  // qualifies (mirrors the -2h edge of the validator).
  const windowStart = now - 2 * 60 * 60 * 1000;

  const notice_events = [];
  const todayIsrael = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const neRows = db.prepare(
    'SELECT id, event_date, event_time, event_title FROM notice_event WHERE event_date >= ? ORDER BY event_date ASC'
  ).all(todayIsrael);
  for (const r of neRows) {
    const ms = toIsraelMs(r.event_date, r.event_time);
    if (ms == null || ms < windowStart || ms > windowEnd) continue;
    if (isSent(db, 'notice_event', r.id)) continue;
    notice_events.push({
      source_type: 'notice_event',
      source_id: r.id,
      title: r.event_title,
      date: r.event_date,
      time: r.event_time || null,
      event_ms: ms,
    });
  }

  const calendar_events = [];
  const ciRows = db.prepare(
    `SELECT id, event_title, event_date, event_start FROM calendar_intents
     WHERE (event_date >= ? OR event_start IS NOT NULL) AND status != 'failed'
     ORDER BY event_date ASC`
  ).all(todayIsrael);
  for (const r of ciRows) {
    let ms = r.event_start ? new Date(r.event_start).getTime() : null;
    if (ms == null || Number.isNaN(ms)) ms = toIsraelMs(r.event_date, null);
    if (ms == null || Number.isNaN(ms) || ms < windowStart || ms > windowEnd) continue;
    if (isSent(db, 'calendar_intents', r.id)) continue;
    calendar_events.push({
      source_type: 'calendar_intents',
      source_id: r.id,
      title: r.event_title,
      date: r.event_date,
      time: null,
      event_ms: ms,
    });
  }

  return { notice_events, calendar_events };
}

module.exports = { getUpcomingEvents };
