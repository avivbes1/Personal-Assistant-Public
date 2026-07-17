/**
 * query-notices.js
 * Returns active (non-dismissed) notices whose relevance_date is today or future.
 * Used by the morning digest to get structured, timestamp-filtered notices
 * instead of re-scanning raw WhatsApp messages.
 *
 * Output: JSON { today, notices: [...], today_events: [...] }
 *
 * today_events: flat list of notice_event rows for today and future dates only.
 * These are already date-filtered — the digest LLM should prefer these over the
 * raw notice content blob, which may contain past-dated bullet points.
 */
const _log = console.log; console.log = () => {};
const { initDB, getActiveNotices, markNoticesShownInDigest, getDB } = require('./src/db');
initDB();
console.log = _log;

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); // YYYY-MM-DD

const notices = getActiveNotices(today);

// For multi-day notices, fetch the per-day event rows for today and future only.
// This prevents the digest LLM from showing past-dated bullets from the raw content blob.
const todayEvents = getDB().prepare(
  `SELECT ne.notice_id, ne.event_date, ne.event_time, ne.event_title, n.group_name
   FROM notice_event ne
   JOIN notices n ON n.id = ne.notice_id
   WHERE ne.event_date >= ?
     AND ne.notice_id IN (${notices.map(() => '?').join(',')})
   ORDER BY ne.event_date ASC, ne.event_time ASC`
).all(today, ...notices.map(n => n.id));

if (notices.length > 0) {
  markNoticesShownInDigest(notices.map(n => n.id), Date.now());
}

console.log(JSON.stringify({ today, count: notices.length, notices, today_events: todayEvents }));
