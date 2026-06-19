const db = require('better-sqlite3')('./data/besinsky.db');
const fus = db.prepare('SELECT id, event_title, event_start, owner, ask_at, status FROM follow_ups ORDER BY ask_at DESC LIMIT 10').all();
console.log('Follow-ups:', JSON.stringify(fus, null, 2));

const reminders = db.prepare("SELECT id, event_title, event_start, owner, remind_at, sent FROM reminders WHERE event_start LIKE '2026-05-04%' ORDER BY remind_at").all();
console.log('Today reminders:', JSON.stringify(reminders, null, 2));
