const db = require('better-sqlite3')('./data/besinsky.db');
const groups = db.prepare('SELECT * FROM groups ORDER BY added_at DESC').all();
groups.forEach(g => {
  const date = new Date(g.added_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  console.log(`[${g.related_to}] ${g.name}`);
  console.log(`  id: ${g.id}`);
  console.log(`  configured: ${g.configured} | added: ${date}`);
});
