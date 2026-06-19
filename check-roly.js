require('dotenv').config();
const { initDB, getDB } = require('./src/db');
initDB();
const db = getDB();

// All reminders for "רולי" (any sent state)
const rows = db.prepare("SELECT * FROM reminders WHERE event_title LIKE '%רולי%' OR event_title LIKE '%roly%' OR event_title LIKE '%trip%' ORDER BY remind_at").all();
console.log('=== Reminders for טיול עם רולי ===');
if (rows.length === 0) {
  console.log('None found.');
} else {
  for (const r of rows) {
    const d = new Date(r.remind_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
    console.log(`[${r.id}] "${r.event_title}" | ${r.label} | owner=${r.owner} | sent=${r.sent} | event_id=${r.event_id} | ${d}`);
  }
}

// All reminders with remind_at in the past 2 hours that are sent=0 or sent=1
const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
const recent = db.prepare("SELECT * FROM reminders WHERE remind_at > ? ORDER BY remind_at").all(twoHoursAgo);
console.log('\n=== Reminders in next 24h ===');
for (const r of recent) {
  const d = new Date(r.remind_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  console.log(`[${r.id}] "${r.event_title}" | ${r.label} | sent=${r.sent} | ${d}`);
}
