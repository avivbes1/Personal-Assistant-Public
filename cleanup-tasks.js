const d = require('./src/db');
d.initDB();
const db = d.getDB();

// Mark duplicate Segev exam tasks (1-5) and noise task (6) as done
const result = db.prepare('UPDATE action_items SET done=1 WHERE id IN (1,2,3,4,5,6)').run();
console.log(`Marked ${result.changes} tasks as done`);

// Show what's left
const remaining = db.prepare('SELECT id, substr(description,1,80) as desc, due_date FROM action_items WHERE done=0').all();
console.log('Remaining open tasks:', JSON.stringify(remaining, null, 2));
