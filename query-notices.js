/**
 * query-notices.js
 * Returns active (non-dismissed) notices whose relevance_date is today or future.
 * Used by the morning digest to get structured, timestamp-filtered notices
 * instead of re-scanning raw WhatsApp messages.
 *
 * Output: JSON { today, notices: [...] }
 */
const _log = console.log; console.log = () => {};
const { initDB, getActiveNotices } = require('./src/db');
initDB();
console.log = _log;

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); // YYYY-MM-DD

const notices = getActiveNotices(today);

console.log(JSON.stringify({ today, count: notices.length, notices }));
