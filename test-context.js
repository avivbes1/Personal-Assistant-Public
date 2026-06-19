// Test buildContext output on server
require('dotenv').config();
const { initDB, getDB } = require('./src/db');
const config = require('./src/config');

initDB();
const db = getDB();

// Test 1: groups
console.log('\n--- GROUPS ---');
const groups = db.prepare("SELECT name, related_to, description FROM groups ORDER BY added_at").all();
groups.forEach(g => console.log(`[${g.related_to}] ${g.name}: ${g.description || '(none)'}`));

// Test 2: recent messages
console.log('\n--- RECENT MESSAGES (last 24h) ---');
const cutoff = Date.now() - 24 * 60 * 60 * 1000;
const msgs = db.prepare(`
  SELECT m.body, m.sender, m.timestamp, g.name as group_name
  FROM messages m
  LEFT JOIN groups g ON m.group_id = g.id
  WHERE m.timestamp > ?
  ORDER BY m.timestamp DESC
  LIMIT 10
`).all(cutoff);
console.log(`Found ${msgs.length} messages`);
msgs.forEach(m => {
  const t = new Date(m.timestamp).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
  console.log(`  [${m.group_name} ${t}] ${m.body.substring(0, 80)}`);
});

// Test 3: messages table total
const total = db.prepare('SELECT COUNT(*) as c FROM messages').get();
console.log(`\nTotal messages in DB: ${total.c}`);
