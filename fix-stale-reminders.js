/**
 * Cancel all unsent reminders whose fire-time has already passed.
 * These are ghost reminders — they should have fired but didn't (bot was down),
 * or they belong to deleted events. Either way, cancel them now.
 */
require('dotenv').config();
const { initDB, getDB } = require('./src/db');
initDB();
const db = getDB();

const now = Date.now();

// Show all past unsent reminders
const past = db.prepare(`
  SELECT id, event_title, label, remind_at, owner, sent
  FROM reminders
  WHERE remind_at < ? AND sent = 0
  ORDER BY remind_at ASC
`).all(now);

if (past.length === 0) {
  console.log('No stale reminders found.');
} else {
  console.log(`Found ${past.length} stale unsent reminders (past due):`);
  for (const r of past) {
    const d = new Date(r.remind_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
    console.log(`  [${r.id}] "${r.event_title}" | ${r.label} | ${d}`);
  }

  const ids = past.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const result = db.prepare(`UPDATE reminders SET sent = 1 WHERE id IN (${placeholders})`).run(...ids);
  console.log(`\nCancelled ${result.changes} stale reminders.`);
}
