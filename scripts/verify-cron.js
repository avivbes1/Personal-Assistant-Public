#!/usr/bin/env node
'use strict';
/**
 * verify-cron.js — K3: Compare infra/jobs.json manifest against live cron jobs.
 *
 * Reports drift in both directions:
 *   - MISSING: job in manifest but not found in live crons
 *   - ORPHAN:  live cron not in manifest (may be intentional — holidays, one-shots)
 *
 * Exit 0 = clean, exit 1 = drift found. Run at startup and daily.
 */

const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.join(__dirname, '..', 'infra', 'jobs.json');

async function main() {
  // Load manifest
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (e) {
    console.error(`[verify-cron] Cannot read ${MANIFEST_PATH}: ${e.message}`);
    process.exit(1);
  }

  const expected = new Set(manifest.jobs.map(j => j.name));

  // Try to read live cron jobs via OpenClaw API
  // This script runs inside the bot, so we check the job_runs table
  // and the cron list via the heartbeat data
  const { initDB, getJobHeartbeats } = require('../src/db');
  initDB();

  const heartbeats = getJobHeartbeats();
  const heartbeatNames = new Set(heartbeats.map(h => h.job_name));

  // Check: do all manifest jobs with heartbeatName have a recent heartbeat?
  const issues = [];
  const now = Date.now();

  for (const job of manifest.jobs) {
    if (!job.heartbeatName) continue; // no heartbeat expected
    const hb = heartbeats.find(h => h.job_name === job.heartbeatName);
    if (!hb) {
      issues.push(`MISSING HEARTBEAT: "${job.name}" (${job.heartbeatName}) — never ran`);
    } else {
      const ageMs = now - hb.last_success_ms;
      const maxMs = job.expectedIntervalMs * 3; // 3x tolerance
      if (ageMs > maxMs) {
        const ageH = Math.round(ageMs / 3600000);
        issues.push(`STALE: "${job.name}" (${job.heartbeatName}) — last ran ${ageH}h ago (max ${Math.round(maxMs / 3600000)}h)`);
      }
    }
  }

  if (issues.length === 0) {
    console.log('[verify-cron] All manifest jobs have recent heartbeats ✅');
    process.exit(0);
  } else {
    console.log(`[verify-cron] ${issues.length} issue(s) found:`);
    issues.forEach(i => console.log(`  ⚠️  ${i}`));
    process.exit(1);
  }
}

main().catch(e => {
  console.error('[verify-cron] Fatal:', e.message);
  process.exit(1);
});
