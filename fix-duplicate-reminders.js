/**
 * One-time cleanup: mark duplicate reminders as sent=1, keeping only the oldest per (event_title, remind_at, label).
 */
require('dotenv').config();
const { initDB, getDB } = require('./src/db');
initDB();
const db = getDB();

const dups = db.prepare(`
  SELECT event_title, remind_at, label, COUNT(*) as cnt, MIN(id) as keep_id
  FROM reminders
  WHERE sent = 0
  GROUP BY event_title, remind_at, label
  HAVING cnt > 1
`).all();

let total = 0;
for (const dup of dups) {
  const result = db.prepare(`
    UPDATE reminders SET sent = 1
    WHERE event_title = ? AND remind_at = ? AND label = ? AND id != ? AND sent = 0
  `).run(dup.event_title, dup.remind_at, dup.label, dup.keep_id);
  console.log(`Cleaned ${result.changes} duplicates for "${dup.event_title}" | ${dup.label}`);
  total += result.changes;
}

console.log(`\nTotal duplicates cancelled: ${total}`);
