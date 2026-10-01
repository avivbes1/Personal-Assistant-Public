#!/usr/bin/env node
'use strict';
/**
 * lipa-canary.js — env-inheritance proof for the Lipa Bridge preflight.
 *
 * ── SAFETY ANALYSIS ──────────────────────────────────────────────────────────
 * This script proves that the agent's tool subprocess (poll.js) receives the
 * four bound env vars (LIPA_BRIDGE_BOUND, LIPA_BRIDGE_CLAIM_ID,
 * LIPA_BRIDGE_CLAIM_GEN, OPENCLAW_SESSION_ID) and the correct FAMILYBOT_DB_PATH
 * from the preflight launcher.
 *
 * DOUBLE SAFETY GATE (in poll.js):
 *   (a) The inbox row's command MUST be exactly 'canary'
 *   (b) FAMILYBOT_DB_PATH MUST start with '/tmp/'
 *   Both conditions must be true for the canary gate to fire. If EITHER fails,
 *   poll.js exits 1 (canary command on non-tmp DB) or falls through to normal
 *   processing (non-canary command).
 *
 * WHY PRODUCTION ROWS CAN NEVER TRIGGER THE CANARY GATE:
 *   - Production rows are created by lipaLane.js with command='email_response'
 *     or other real commands. No production code path ever sets command='canary'.
 *   - Even if a row somehow had command='canary', the production DB path is
 *     data/family.db (not under /tmp/), so poll.js refuses with exit 1.
 *   - The canary gate exits BEFORE respond.js runs, so no outbound dispatch
 *     (email, WhatsApp, calendar) is ever triggered from a canary row.
 *
 * WHY THE PRODUCTION DB IS NEVER TOUCHED:
 *   - This script creates a fresh temp DB under /tmp/ via mkdtemp.
 *   - It sets FAMILYBOT_DB_PATH to the temp path BEFORE importing any DB module.
 *   - If FAMILYBOT_DB_PATH is already set to something outside /tmp/, the script
 *     refuses to run (prevents accidental production contamination).
 *   - The production execution_hold is never read or written by this script.
 *
 * USAGE:
 *   node scripts/lipa-canary.js
 *   # Requires: openclaw CLI on PATH, gateway running
 *   # Does NOT touch production DB, does NOT modify production hold
 *   # Exits 0 on success (all 4 bound values validated), 1 on failure
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── SAFETY CHECK: refuse if DB is already pointed at production ──────────────
const existingDb = process.env.FAMILYBOT_DB_PATH || '';
if (existingDb && !existingDb.startsWith('/tmp/')) {
  console.error('[Canary] REFUSED: FAMILYBOT_DB_PATH is set to a non-tmp path:', existingDb);
  console.error('[Canary] This script must use a disposable DB under /tmp/.');
  process.exit(1);
}

// ── Create disposable temp environment ───────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lipa-canary-'));
const tmpDb = path.join(tmpDir, 'canary.db');
const canaryLog = path.join(tmpDir, 'canary.log');

// Set env BEFORE any DB module import
process.env.FAMILYBOT_DB_PATH = tmpDb;
process.env.LIPA_CANARY_LOG = canaryLog;

// Load .env for non-DB config (but FAMILYBOT_DB_PATH is already overridden)
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
// Re-override in case .env set it
process.env.FAMILYBOT_DB_PATH = tmpDb;
process.env.LIPA_CANARY_LOG = canaryLog;

const { initDB, getDB } = require('../src/db');
const { ensureLipaTables } = require('../src/bridge/lipaLane');
const { runPreflight } = require('./lipa-bridge-preflight');

async function main() {
  console.log('[Canary] Temp dir:', tmpDir);
  console.log('[Canary] Temp DB:', tmpDb);
  console.log('[Canary] Canary log:', canaryLog);

  // Initialize the temp DB with full schema
  initDB();
  ensureLipaTables();
  const db = getDB();

  // Verify we're on the temp DB, not production
  const resolvedDb = fs.realpathSync(tmpDb);
  const prodDb = path.resolve(__dirname, '..', 'data', 'family.db');
  if (resolvedDb === prodDb || !resolvedDb.startsWith('/tmp/')) {
    console.error('[Canary] SAFETY ABORT: resolved DB path is production or not under /tmp:', resolvedDb);
    process.exit(1);
  }

  // ── Insert exactly one canary row ──────────────────────────────────────────
  const now = Date.now();
  const requestId = `canary-${now}`;
  const res = db.prepare(
    `INSERT INTO bridge_lipa_inbox
       (request_id, command, args_json, from_addr, subject, created_at, status, attempts, available_at, updated_at)
     VALUES (?, 'canary', '{}', 'canary@test', 'Canary probe', ?, 'pending', 0, ?, ?)`
  ).run(requestId, now, now, now);
  const canaryRowId = res.lastInsertRowid;
  console.log('[Canary] Inserted canary row: id=' + canaryRowId + ', request_id=' + requestId);

  // Verify row
  const row = db.prepare('SELECT * FROM bridge_lipa_inbox WHERE id = ?').get(canaryRowId);
  if (!row || row.command !== 'canary') {
    console.error('[Canary] ABORT: canary row not found or wrong command');
    process.exit(1);
  }

  // ── Run preflight with the REAL launcher ───────────────────────────────────
  // The real defaultLauncher spawns `openclaw agent` which runs poll.js inside
  // the agent turn. poll.js sees LIPA_BRIDGE_BOUND=1, validates all 4 env vars,
  // detects command='canary' + /tmp/ DB, logs to LIPA_CANARY_LOG, exits 0.
  // No respond.js runs. No outbound dispatch.
  console.log('[Canary] Launching preflight with real defaultLauncher...');
  console.log('[Canary] (This spawns a real openclaw agent turn — one LLM call)');

  let result;
  try {
    result = await runPreflight({
      now,
      sessionId: `canary-${process.pid}-${now}`,
      timeoutMs: 120000, // 2 min — canary is lightweight
    });
  } catch (err) {
    console.error('[Canary] runPreflight threw:', err.message);
    cleanup(1);
    return;
  }

  console.log('[Canary] Preflight result:', JSON.stringify(result, null, 2));

  if (!result.launched) {
    console.error('[Canary] Preflight did not launch. Reason:', result.reason);
    if (result.reason === 'execution_hold') {
      console.error('[Canary] NOTE: The temp DB should NOT have a hold. If it does, the init is wrong.');
    }
    cleanup(1);
    return;
  }

  // ── Read back the canary log ───────────────────────────────────────────────
  if (!fs.existsSync(canaryLog)) {
    console.error('[Canary] FAIL: canary log was not written at', canaryLog);
    console.error('[Canary] This means poll.js did not execute or did not reach the canary gate.');
    // Check the result for clues
    if (result.reason === 'timeout') {
      console.error('[Canary] The agent turn timed out before poll.js could run.');
    } else if (result.reason === 'clean_exit_verification_failed') {
      console.error('[Canary] poll.js may have exited before writing (canary row stays claimed → verification fails).');
      console.error('[Canary] NOTE: The canary gate exits 0 but does NOT complete the claim.');
      console.error('[Canary] This is EXPECTED behavior — the preflight sets a hold because verification fails.');
      console.error('[Canary] What matters is whether the canary LOG was written, not the preflight exit status.');
    }
    cleanup(1);
    return;
  }

  let canaryData;
  try {
    canaryData = JSON.parse(fs.readFileSync(canaryLog, 'utf8'));
  } catch (err) {
    console.error('[Canary] FAIL: could not parse canary log:', err.message);
    cleanup(1);
    return;
  }

  console.log('\n[Canary] ═══════════════════════════════════════════════');
  console.log('[Canary] CANARY LOG CONTENTS:');
  console.log(JSON.stringify(canaryData, null, 2));
  console.log('[Canary] ═══════════════════════════════════════════════\n');

  // ── Validate the bound values ──────────────────────────────────────────────
  const bv = canaryData.bound_values || {};
  const errors = [];

  if (bv.LIPA_BRIDGE_BOUND !== '1') errors.push('LIPA_BRIDGE_BOUND: expected "1", got ' + JSON.stringify(bv.LIPA_BRIDGE_BOUND));
  if (bv.LIPA_BRIDGE_CLAIM_ID !== String(canaryRowId)) errors.push('LIPA_BRIDGE_CLAIM_ID: expected "' + canaryRowId + '", got ' + JSON.stringify(bv.LIPA_BRIDGE_CLAIM_ID));
  // claim_gen should be 1 (first claim of a fresh row)
  if (bv.LIPA_BRIDGE_CLAIM_GEN !== '1') errors.push('LIPA_BRIDGE_CLAIM_GEN: expected "1", got ' + JSON.stringify(bv.LIPA_BRIDGE_CLAIM_GEN));
  if (!bv.OPENCLAW_SESSION_ID || !bv.OPENCLAW_SESSION_ID.startsWith('canary-')) {
    errors.push('OPENCLAW_SESSION_ID: expected canary-*, got ' + JSON.stringify(bv.OPENCLAW_SESSION_ID));
  }

  // Validate DB path
  const reportedDb = canaryData.resolved_db_path || '';
  if (reportedDb !== tmpDb) {
    errors.push('resolved_db_path: expected ' + tmpDb + ', got ' + reportedDb);
  }

  if (!canaryData.all_four_validated) {
    errors.push('all_four_validated: poll.js did not confirm validation');
  }

  if (errors.length > 0) {
    console.error('[Canary] FAIL: validation errors:');
    for (const e of errors) console.error('  ✗', e);
    cleanup(1);
    return;
  }

  console.log('[Canary] ✓ LIPA_BRIDGE_BOUND = 1');
  console.log('[Canary] ✓ LIPA_BRIDGE_CLAIM_ID = ' + canaryRowId);
  console.log('[Canary] ✓ LIPA_BRIDGE_CLAIM_GEN = 1');
  console.log('[Canary] ✓ OPENCLAW_SESSION_ID = ' + bv.OPENCLAW_SESSION_ID);
  console.log('[Canary] ✓ resolved_db_path = ' + tmpDb);
  console.log('[Canary] ✓ all_four_validated = true');
  console.log('\n[Canary] SUCCESS: all bound values reached the agent tool subprocess.');

  // Note about the preflight hold: the canary gate exits poll.js before
  // respond.js, so the canary row stays 'claimed' and verification fails.
  // This causes the preflight to set a hold on the TEMP DB. This is expected
  // and harmless — the temp DB is deleted below.
  if (result.holdSet) {
    console.log('[Canary] NOTE: preflight set hold on temp DB (expected — canary row stays claimed).');
    console.log('[Canary]       This is harmless; the temp DB is about to be deleted.');
  }

  cleanup(0);
}

function cleanup(exitCode) {
  try {
    // Remove temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('[Canary] Cleaned up temp dir:', tmpDir);
  } catch (err) {
    console.error('[Canary] Cleanup warning:', err.message);
  }
  process.exit(exitCode);
}

main().catch(err => {
  console.error('[Canary] Unexpected error:', err);
  cleanup(1);
});
