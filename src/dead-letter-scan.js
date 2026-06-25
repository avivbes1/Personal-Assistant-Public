'use strict';
/**
 * dead-letter-scan.js — Hourly check for notices stuck in send_now/send_update
 * without being delivered. Alerts via voice server (localhost:3001).
 *
 * ISSUE-017: P-007 — validate external output before state commit.
 * Run via system cron: 0 * * * * cd /home/ubuntu/familybot && node src/dead-letter-scan.js >> logs/dead-letter.log 2>&1
 */
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (_) {}

const { initDB, getDB } = require('./db');

const STUCK_THRESHOLD_MINUTES = 60; // alert if stuck >1h

function alertViaVoiceServer(message) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ message, to: process.env.OWNER_PHONE });
    const req = require('http').request({
      hostname: 'localhost',
      port: 3001,
      path: '/send-text',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', e => { console.error('[DeadLetter] Alert delivery failed:', e.message); resolve(null); });
    req.write(body);
    req.end();
  });
}

async function main() {
  initDB();
  const db = getDB();

  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000).toISOString();

  const stuck = db.prepare(`
    SELECT id, group_name, content, triage_decision, triaged_at, relevance_date
    FROM notices
    WHERE triage_decision IN ('send_now', 'send_update')
      AND posted_to_master = 0
      AND dismissed = 0
      AND triaged_at IS NOT NULL
      AND triaged_at < ?
  `).all(cutoff);

  if (stuck.length === 0) {
    console.log(`[DeadLetter] OK — no stuck notices at ${new Date().toISOString()}`);
    return;
  }

  const summary = stuck.map(n =>
    `#${n.id} (${n.triage_decision}) ${n.group_name}: ${n.content.substring(0, 60)}`
  ).join('\n');

  console.error(`[DeadLetter] ALERT: ${stuck.length} stuck notice(s):\n${summary}`);

  await alertViaVoiceServer(
    `⚠️ Dead-letter alert: ${stuck.length} notice(s) classified as send_now but never delivered (>${STUCK_THRESHOLD_MINUTES}min):\n${summary}\n\nCheck triage-engine logs.`
  );

  process.exit(1); // non-zero exit so cron can detect failures
}

main().catch(e => { console.error('[DeadLetter] Fatal:', e); process.exit(1); });
