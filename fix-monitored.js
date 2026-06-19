const db = require('better-sqlite3')('./data/besinsky.db');

// Show current state
console.log('Current groups:');
db.prepare('SELECT id, name, related_to FROM groups').all().forEach(r => {
  console.log(`  [${r.related_to}] ${r.name}`);
});

// Mark ALL non-master groups as monitored
const result = db.prepare(
  "UPDATE groups SET related_to='monitored', configured=1 WHERE related_to != 'master' OR related_to IS NULL"
).run();
console.log(`\nUpdated ${result.changes} groups to monitored`);

console.log('\nAfter:');
db.prepare('SELECT id, name, related_to FROM groups').all().forEach(r => {
  console.log(`  [${r.related_to}] ${r.name}`);
});
