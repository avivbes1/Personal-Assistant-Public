const db = require('better-sqlite3')('./data/besinsky.db');

const descriptions = [
  { id: '120363282818641802@g.us', desc: 'קבוצת הבית של משפחת בסינסקי-רשפים — אדריכל, עבודות בית' },
  { id: '120363393831533060@g.us', desc: 'הורי מרכזון של נבו — ג׳-ד׳ תשפ״ו' },
  { id: '120363349099613757@g.us', desc: 'שיעורי מתמטיקה של שגב אצל נילי' },
  { id: '120363044434449780@g.us', desc: 'הורי כיתה ו׳2 של שגב אצל בני ודורית' },
  { id: '120363168238198071@g.us', desc: 'כיתת ג׳3 של נבו — תשפ״ו' },
  { id: '120363304480461484@g.us', desc: 'הורי גן גיל הרך' },
  { id: '120363421222455453@g.us', desc: 'הורי גן כוכב 2025/6' },
];

for (const { id, desc } of descriptions) {
  const r = db.prepare('UPDATE groups SET description = ? WHERE id = ? AND (description IS NULL OR description = \'\')').run(desc, id);
  if (r.changes) console.log('Updated:', id, '->', desc);
}

console.log('\nFinal state:');
db.prepare('SELECT name, description FROM groups ORDER BY added_at').all().forEach(g => {
  console.log(`  ${g.name}: ${g.description || '(none)'}`);
});
