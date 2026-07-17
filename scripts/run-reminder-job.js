/**
 * run-reminder-job.js
 * Thin cron wrapper around the hallucination-safe reminder heartbeat.
 * Intended to be invoked periodically (e.g. every 15–30 min).
 */

const _log = console.log; console.log = () => {};
const { initDB } = require('../src/db');
initDB();
console.log = _log;

const { runReminderJob } = require('../src/heartbeat/reminderJob');

runReminderJob()
  .then(res => {
    console.log('[run-reminder-job] Done', JSON.stringify(res));
    process.exit(0);
  })
  .catch(err => {
    console.error('[run-reminder-job] Error:', err.message);
    process.exit(1);
  });
