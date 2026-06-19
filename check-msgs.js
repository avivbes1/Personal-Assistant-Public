// Suppress console.log during init to keep stdout clean JSON
const _log = console.log; console.log = () => {};
const { initDB, getDB } = require('./src/db');
initDB();
console.log = _log;

// Accept optional --since=<unix_ms> argument
const sinceArg = process.argv.find(a => a.startsWith('--since='));
const since = sinceArg ? parseInt(sinceArg.split('=')[1]) : Date.now() - 60 * 60 * 1000; // default: last 1h

const rows = getDB().prepare(`
  SELECT m.id, m.body, m.sender, m.timestamp, g.name as group_name, g.description as group_desc
  FROM messages m
  JOIN groups g ON m.group_id = g.id
  WHERE g.related_to = 'monitored'
    AND m.timestamp > ?
  ORDER BY m.timestamp ASC
`).all(since);

// Deduplicate by (group_name + truncated body)
const seen = new Set();
const unique = rows.filter(r => {
  const key = r.group_name + '|' + (r.body || '').substring(0, 60);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

console.log(JSON.stringify({ since, count: unique.length, messages: unique }));
