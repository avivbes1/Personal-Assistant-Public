const db = require('better-sqlite3')('./data/besinsky.db');

// כתה ו׳ רשפים — has context, mark as monitored
const r1 = db.prepare("UPDATE groups SET related_to='monitored', configured=1 WHERE id='972547860979-1599304865@g.us'").run();
console.log('כתה ו׳ רשפים → monitored:', r1.changes, 'row(s)');

// Verify final state
db.prepare('SELECT id, name, related_to, configured FROM groups ORDER BY added_at DESC').all().forEach(g => {
  console.log(`[${g.related_to}] ${g.name}`);
});
