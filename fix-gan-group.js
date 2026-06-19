const db = require('better-sqlite3')('./data/besinsky.db');
const r = db.prepare("UPDATE groups SET related_to='monitored', configured=1 WHERE id='120363421222455453@g.us'").run();
console.log('הורי גן כוכב 2025/6 → monitored:', r.changes, 'row(s)');
