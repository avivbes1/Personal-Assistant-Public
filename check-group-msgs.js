/**
 * Check if bot is actually receiving messages from monitored groups.
 * Run while bot is connected: node check-group-msgs.js
 */
const { initDB, getDB } = require('./src/db');
initDB();

const db = getDB();

// Count messages per group
const counts = db.prepare(`
  SELECT g.name, g.related_to, COUNT(m.id) as msg_count, MAX(m.timestamp) as last_msg
  FROM groups g
  LEFT JOIN messages m ON m.group_id = g.id
  GROUP BY g.id
  ORDER BY g.related_to, msg_count DESC
`).all();

console.log('\n=== Messages per group in DB ===');
for (const r of counts) {
  const last = r.last_msg ? new Date(r.last_msg).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) : 'none';
  console.log(`[${r.related_to || 'unknown'}] ${r.name}: ${r.msg_count} msgs, last: ${last}`);
}

// Recent messages
const recent = db.prepare(`
  SELECT m.body, m.sender, m.timestamp, g.name, g.related_to
  FROM messages m
  LEFT JOIN groups g ON m.group_id = g.id
  ORDER BY m.timestamp DESC LIMIT 20
`).all();

console.log('\n=== 20 most recent messages ===');
for (const r of recent) {
  const d = new Date(r.timestamp).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  console.log(`[${r.related_to}/${r.name}] ${r.sender}: ${(r.body||'').substring(0,60)} (${d})`);
}
