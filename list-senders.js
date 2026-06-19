const db = require('better-sqlite3')('./data/besinsky.db');
const rows = db.prepare('SELECT DISTINCT sender FROM messages').all();
console.log('Senders:', rows.map(r => r.sender));
process.exit(0);
