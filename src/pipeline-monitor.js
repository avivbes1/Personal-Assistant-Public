/**
 * pipeline-monitor.js — P-008 stuck-message scanner
 * ISSUE-019: Every message must reach a terminal pipeline state within ~10 min.
 *
 * Runs via system cron every 5 minutes.
 * Cron entry: [star]/5 [star] [star] [star] [star] cd /home/ubuntu/familybot && node src/pipeline-monitor.js >> logs/pipeline-monitor.log 2>&1
 *
 * When a message is stuck:
 * 1. Warn at 5 min
 * 2. Mark FAILED + alert voice server at 30 min
 */

'use strict';

const { initDB, getDB, getStuckMessages, markMessageFailed, getPipelineStats } = require('./db');
const http = require('http');

const WARN_THRESHOLD_MS  = 5  * 60 * 1000;  //  5 min — log warning
const FAIL_THRESHOLD_MS  = 30 * 60 * 1000;  // 30 min — mark FAILED, alert

initDB();

function ts() { return new Date().toISOString(); }

function sendAlert(message) {
  const body = JSON.stringify({ to: process.env.AVIV_PHONE || '', message });
  const req = http.request({
    hostname: 'localhost',
    port: parseInt(process.env.VOICE_SERVER_PORT || '3001', 10),
    path: '/send-message',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => { res.resume(); });
  req.on('error', (e) => console.error('[PipelineMon] Alert send failed:', e.message));
  req.write(body);
  req.end();
}

async function run() {
  const now = Date.now();

  // --- Stuck message check ---
  const stuck = getStuckMessages(WARN_THRESHOLD_MS);
  if (stuck.length > 0) {
    for (const msg of stuck) {
      const ageMs = now - msg.processing_started_at;
      const ageMins = Math.round(ageMs / 60000);

      if (ageMs >= FAIL_THRESHOLD_MS) {
        // Escalate: mark FAILED and alert
        markMessageFailed(msg.id, JSON.stringify({ code: 'STUCK_TIMEOUT', detail: `${ageMins}min in PROCESSING` }));
        console.error(`[PipelineMon] ${ts()} CRITICAL: msg ${msg.id} stuck ${ageMins}min → marked FAILED`);
        sendAlert(`⚠️ Pipeline alert: message ${msg.id} was stuck for ${ageMins} minutes and has been marked FAILED. Check pm2 logs.`);
      } else {
        console.warn(`[PipelineMon] ${ts()} WARNING: msg ${msg.id} stuck ${ageMins}min in PROCESSING`);
      }
    }
  }

  // --- Hourly failure rate ---
  const stats = getPipelineStats(3600000);
  const byState = {};
  for (const row of stats) byState[row.pipeline_state] = row.cnt;
  const total   = Object.values(byState).reduce((s, v) => s + v, 0);
  const failed  = byState['FAILED'] || 0;
  const created = byState['NOTICE_CREATED'] || 0;
  const notAct  = byState['NOT_ACTIONABLE'] || 0;
  const processing = byState['PROCESSING'] || 0;

  if (total > 0) {
    const failRate = ((failed / total) * 100).toFixed(1);
    console.log(`[PipelineMon] ${ts()} stats(1h): total=${total} NOTICE_CREATED=${created} NOT_ACTIONABLE=${notAct} FAILED=${failed} PROCESSING=${processing} failure_rate=${failRate}%`);

    if (failed > 0 && parseFloat(failRate) > 20) {
      console.error(`[PipelineMon] ${ts()} HIGH FAILURE RATE: ${failRate}% in last hour (${failed}/${total})`);
      sendAlert(`⚠️ Pipeline: failure rate ${failRate}% in last hour (${failed}/${total} messages failed). Check logs.`);
    }
  }
}

run().catch(e => console.error('[PipelineMon] Fatal:', e.message));
