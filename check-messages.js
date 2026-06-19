const db = require('better-sqlite3')('data/besinsky.db');

const counts = db.prepare(`
  SELECT g.name, COUNT(*) as cnt, MAX(m.timestamp) as last_ts
  FROM messages m
  LEFT JOIN groups g ON m.group_id = g.id
  GROUP BY m.group_id
  ORDER BY last_ts DESC
`).all();

console.log('=== Messages per group ===');
for (const r of counts) {
  const d = r.last_ts ? new Date(r.last_ts).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) : 'never';
  console.log(`[${r.name || 'unknown'}] ${r.cnt} msgs, last: ${d}`);
}

const last = db.prepare(`
  SELECT m.sender, m.body, m.timestamp, g.name
  FROM messages m
  LEFT JOIN groups g ON m.group_id = g.id
  ORDER BY m.timestamp DESC LIMIT 10
`).all();

console.log('\n=== Last 10 messages logged ===');
for (const r of last) {
  const d = new Date(r.timestamp).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  console.log(`[${r.name || '?'}] ${r.sender}: ${(r.body || '').substring(0, 60)} (${d})`);
}
