/**
 * query-unposted-notices.js
 * Returns notices not yet posted to master group, filtered to relevant/actionable ones.
 * Usage: node query-unposted-notices.js [--days=2]
 * Output: JSON array of notice objects
 */
process.chdir(__dirname);
require('dotenv').config();

const { initDB, getDB } = require('./src/db');

initDB();
const db = getDB();

const daysAhead = parseInt((process.argv.find(a => a.startsWith('--days=')) || '--days=3').split('=')[1]);

const now = new Date();
const tzOffset = 3; // Israel (GMT+3)
const israelNow = new Date(now.getTime() + tzOffset * 60 * 60 * 1000);
const todayStr = israelNow.toISOString().slice(0, 10);

// Compute cutoff date
const cutoff = new Date(israelNow);
cutoff.setDate(cutoff.getDate() + daysAhead);
const cutoffStr = cutoff.toISOString().slice(0, 10);

const rows = db.prepare(`
  SELECT id, group_name, content, relevance_date, relevance_time, source_timestamp, created_at
  FROM notices
  WHERE dismissed = 0
    AND posted_to_master = 0
    AND relevance_date >= ?
    AND relevance_date <= ?
  ORDER BY relevance_date ASC, relevance_time ASC
`).all(todayStr, cutoffStr);

// Output as JSON for consumption by AI agent
console.log(JSON.stringify(rows, null, 2));
