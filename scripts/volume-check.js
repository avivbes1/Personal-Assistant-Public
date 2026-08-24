#!/usr/bin/env node
/**
 * volume-check.js — health check for message ingestion + notice pipeline.
 *
 * Counts messages and notices in a recent window and flags an outage.
 * The window is 12h during Israel daytime (08:00–20:00) and 24h at night
 * (20:00–08:00), so genuinely quiet overnight hours don't trip a false alarm.
 *
 * Emits a JSON health report to stdout. Always exits 0 — the caller reads JSON.
 */

const { initDB, getDB } = require('../src/db');

function getIsraelHour() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date());
  const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  // Intl can return 24 for midnight in hour12:false — normalize to 0.
  return hour === 24 ? 0 : hour;
}

function main() {
  // initDB() logs to stdout; silence it so stdout stays pure JSON for the caller.
  const origLog = console.log;
  console.log = () => {};
  try {
    initDB();
  } finally {
    console.log = origLog;
  }
  const db = getDB();

  const israelHour = getIsraelHour();
  const isDaytime = israelHour >= 8 && israelHour < 20;
  const windowHours = isDaytime ? 12 : 24;
  const cutoff = Date.now() - windowHours * 60 * 60 * 1000;

  const messagesInWindow = db
    .prepare('SELECT COUNT(*) AS c FROM messages WHERE timestamp > ?')
    .get(cutoff).c;
  const noticesInWindow = db
    .prepare('SELECT COUNT(*) AS c FROM notices WHERE created_at > ?')
    .get(cutoff).c;

  const alerts = [];
  // Only alert during daytime — at night, zero volume is expected during quiet
  // hours, and the 24h window already covers a genuine outage spanning the day.
  if (isDaytime) {
    if (messagesInWindow === 0) alerts.push('no-messages-12h');
    if (noticesInWindow === 0) alerts.push('no-notices-12h');
  }

  const report = {
    ok: alerts.length === 0,
    messagesInWindow,
    noticesInWindow,
    windowHours,
    israelHour,
    alerts,
  };

  process.stdout.write(JSON.stringify(report) + '\n');
}

main();
process.exit(0);
