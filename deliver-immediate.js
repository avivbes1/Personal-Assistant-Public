#!/usr/bin/env node
'use strict';
/**
 * deliver-immediate.js — Thin launcher for the immediate drain (B1 / P-012).
 *
 * Invoked by OpenClaw cron every 5 minutes.
 * Sets TRIAGE_MODE=immediate and spawns triage-engine.js — the single process
 * that reads the notices queue and calls voiceSend (P-012). This file must
 * NOT read the notices queue and must NOT call voiceSend or POST /send-message.
 */

const { execFileSync } = require('child_process');
const path = require('path');

const triageScript = path.join(__dirname, 'src', 'triage-engine.js');

try {
  execFileSync(process.execPath, [triageScript], {
    env: { ...process.env, TRIAGE_MODE: 'immediate' },
    stdio: 'inherit',
    timeout: 60_000,
  });
  console.log('[deliver-immediate] Done');
} catch (err) {
  console.error('[deliver-immediate] Error:', err.message);
  process.exit(1);
}
