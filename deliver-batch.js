#!/usr/bin/env node
'use strict';
/**
 * deliver-batch.js — Thin launcher for the digest drain (B1 / P-012).
 *
 * Invoked by OpenClaw cron at 07:00, 12:00, 16:00, 20:00 Israel time.
 * Sets TRIAGE_MODE=digest and spawns triage-engine.js — the single process
 * that reads the notices queue and calls voiceSend (P-012). This file must
 * NOT read the notices queue and must NOT call voiceSend or POST /send-message.
 */

const { execFileSync } = require('child_process');
const path = require('path');

const triageScript = path.join(__dirname, 'src', 'triage-engine.js');

try {
  execFileSync(process.execPath, [triageScript], {
    env: { ...process.env, TRIAGE_MODE: 'digest' },
    stdio: 'inherit',
    timeout: 120_000,
  });
  console.log('[deliver-batch] Done');
} catch (err) {
  // execFileSync throws on non-zero exit; the child already printed its error.
  console.error('[deliver-batch] Error:', err.message);
  process.exit(1);
}
