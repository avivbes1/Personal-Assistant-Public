const { initDB, getDB } = require('./src/db');
initDB();
// show table schema first
const schema = getDB().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='groups'").get();
console.log('schema:', schema && schema.sql);
const rows = getDB().prepare('SELECT * FROM groups LIMIT 20').all();
rows.forEach(r => console.log(JSON.stringify(r)));
