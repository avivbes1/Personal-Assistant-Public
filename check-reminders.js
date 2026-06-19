const db = require('better-sqlite3')('data/besinsky.db');
const rows = db.prepare("SELECT id, event_id, event_title, remind_at, label, owner, sent FROM reminders ORDER BY remind_at DESC LIMIT 30").all();
for (const r of rows) {
  const d = new Date(r.remind_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  console.log(`[${r.id}] ${r.event_title} | ${r.label} | owner=${r.owner} | sent=${r.sent} | ${d}`);
}
// Show duplicates
const dups = db.prepare("SELECT event_id, label, COUNT(*) as cnt FROM reminders GROUP BY event_id, label HAVING cnt > 1").all();
if (dups.length > 0) {
  console.log('\nDUPLICATES:', JSON.stringify(dups));
}
