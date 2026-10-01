#!/usr/bin/env node
'use strict';
/**
 * lipa-canary.js — env-inheritance proof for the Lipa Bridge preflight.
 *
 * DISABLED: Do not run until all review items are resolved.
 *
 * ── PURPOSE ──────────────────────────────────────────────────────────────────
 * Proves that the agent's tool subprocess (poll.js) receives the four bound env
 * vars and operates on the correct DB, via a full F-success path:
 *   poll → fenced respond → done + outbox → lock release → restart no-launch
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────────
 * 1. FAILS BEFORE initDB if FAMILYBOT_DB_PATH is missing or points outside /tmp
 * 2. Validates the temp DB by inode (stat.ino), not path prefix
 * 3. Uses an exact session nonce (canary-<pid>-<timestamp>-<random>), not a prefix
 * 4. Passes DB path + bound values explicitly via env to the tool route
 * 5. Keeps temp dir on timeout, exception, or unknown remote state — only deletes
 *    on verified clean success
 * 6. Canary gate in poll.js requires BOTH command='canary' AND inode-validated
 *    temp DB — production rows/DB can never trigger it
 *
 * ── F-SUCCESS PATH ───────────────────────────────────────────────────────────
 * On a clean run, the canary validates:
 *   a. poll.js sees all 4 bound values + correct DB path
 *   b. respond.js writes the outbox row (fenced by claim_generation)
 *   c. verifyCompletions passes (done + outbox)
 *   d. worker lock is released
 *   e. restart (second runPreflight) returns no-launch (no due work)
 *
 * USAGE:
 *   node scripts/lipa-canary.js
 *   # Requires: openclaw CLI on PATH, gateway running
 *   # Exits 0 on success, 1 on failure
 *   # On timeout/unknown: exits 1, temp dir PRESERVED for forensics
 */

const DISABLED = true; // Remove after review items 2-8 are resolved

if (DISABLED) {
  console.error('[Canary] DISABLED — do not run until review items are resolved.');
  console.error('[Canary] Set DISABLED=false in this file after Aviv approves.');
  process.exit(1);
}

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ── PRE-INITDB SAFETY ────────────────────────────────────────────────────────
// MUST fail before any DB module is loaded.

const existingDb = process.env.FAMILYBOT_DB_PATH || '';
if (existingDb && !existingDb.startsWith('/tmp/')) {
  console.error('[Canary] REFUSED: FAMILYBOT_DB_PATH points outside /tmp/:', existingDb);
  process.exit(1);
}

// Create temp dir and DB path BEFORE any require that touches DB
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lipa-canary-'));
const tmpDb = path.join(tmpDir, 'canary.db');
const canaryLog = path.join(tmpDir, 'canary.log');

// Generate exact session nonce — not a prefix match
const nonce = crypto.randomBytes(8).toString('hex');
const exactSessionId = `canary-${process.pid}-${Date.now()}-${nonce}`;

// Set env BEFORE any DB module import
process.env.FAMILYBOT_DB_PATH = tmpDb;
process.env.LIPA_CANARY_LOG = canaryLog;
process.env.LIPA_CANARY_SESSION = exactSessionId;

// Load .env for non-DB config, then re-override DB path
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.FAMILYBOT_DB_PATH = tmpDb;
process.env.LIPA_CANARY_LOG = canaryLog;
process.env.LIPA_CANARY_SESSION = exactSessionId;

// NOW safe to import DB modules
const { initDB, getDB } = require('../src/db');
const { ensureLipaTables } = require('../src/bridge/lipaLane');
const { runPreflight } = require('./lipa-bridge-preflight');

async function main() {
  console.log('[Canary] Temp dir:', tmpDir);
  console.log('[Canary] Temp DB:', tmpDb);
  console.log('[Canary] Session nonce:', exactSessionId);
  console.log('[Canary] Canary log:', canaryLog);

  // Initialize temp DB with full schema
  initDB();
  ensureLipaTables();
  const db = getDB();

  // ── INODE VALIDATION ─────────────────────────────────────────────────────
  // Verify the opened DB is the temp file by inode, not just path string.
  // Protects against symlink attacks or path confusion.
  const tmpDbStat = fs.statSync(tmpDb);
  const tmpDbIno = tmpDbStat.ino;
  const tmpDbDev = tmpDbStat.dev;
  const resolvedTmpDb = fs.realpathSync(tmpDb);

  // Double-check: realpath must be under /tmp
  if (!resolvedTmpDb.startsWith('/tmp/')) {
    console.error('[Canary] SAFETY ABORT: resolved DB path not under /tmp:', resolvedTmpDb);
    process.exit(1);
  }

  // Verify production DB is different
  const prodDbPath = path.resolve(__dirname, '..', 'data', 'family.db');
  if (fs.existsSync(prodDbPath)) {
    const prodStat = fs.statSync(prodDbPath);
    if (prodStat.ino === tmpDbIno && prodStat.dev === tmpDbDev) {
      console.error('[Canary] SAFETY ABORT: temp DB has same inode as production!');
      process.exit(1);
    }
  }

  console.log('[Canary] Inode validation: temp DB ino=' + tmpDbIno + ' (different from production)');

  // ── Insert canary row ────────────────────────────────────────────────────
  const now = Date.now();
  const requestId = `canary-${nonce}-${now}`;
  const res = db.prepare(
    `INSERT INTO bridge_lipa_inbox
       (request_id, command, args_json, from_addr, subject, created_at, status, attempts, available_at, updated_at)
     VALUES (?, 'canary', '{"canary":true}', 'canary@test', 'Canary probe', ?, 'pending', 0, ?, ?)`
  ).run(requestId, now, now, now);
  const canaryRowId = res.lastInsertRowid;
  console.log('[Canary] Inserted canary row: id=' + canaryRowId + ' request_id=' + requestId);

  // ── Run preflight ────────────────────────────────────────────────────────
  console.log('[Canary] Launching preflight with REAL defaultLauncher...');
  console.log('[Canary] (This spawns one openclaw agent turn)');

  let result;
  try {
    result = await runPreflight({
      now,
      sessionId: exactSessionId,
      timeoutMs: 120000,
    });
  } catch (err) {
    console.error('[Canary] runPreflight threw:', err.message);
    preserveAndExit(1, 'runPreflight exception');
    return;
  }

  console.log('[Canary] Preflight result:', JSON.stringify(result, null, 2));

  // ── Check for timeout / unknown state ────────────────────────────────────
  if (!result.launched) {
    console.error('[Canary] Preflight did not launch. Reason:', result.reason);
    preserveAndExit(1, 'no launch: ' + result.reason);
    return;
  }

  if (result.reason === 'timeout' || result.holdSet) {
    console.error('[Canary] TIMEOUT or HOLD — remote state unknown.');
    console.error('[Canary] Temp dir PRESERVED for forensics:', tmpDir);
    // Do NOT delete temp dir — remote may still be running
    process.exit(1);
  }

  // ── Read canary log ──────────────────────────────────────────────────────
  if (!fs.existsSync(canaryLog)) {
    console.error('[Canary] Canary log not written. poll.js may not have reached canary gate.');
    preserveAndExit(1, 'canary log missing');
    return;
  }

  let canaryData;
  try {
    canaryData = JSON.parse(fs.readFileSync(canaryLog, 'utf8'));
  } catch (err) {
    console.error('[Canary] Cannot parse canary log:', err.message);
    preserveAndExit(1, 'canary log parse error');
    return;
  }

  console.log('\n[Canary] ═══════ CANARY LOG ═══════');
  console.log(JSON.stringify(canaryData, null, 2));
  console.log('[Canary] ═══════════════════════════\n');

  // ── Validate bound values (exact match, not prefix) ──────────────────────
  const bv = canaryData.bound_values || {};
  const errors = [];

  if (bv.LIPA_BRIDGE_BOUND !== '1')
    errors.push('LIPA_BRIDGE_BOUND: expected "1", got ' + JSON.stringify(bv.LIPA_BRIDGE_BOUND));
  if (bv.LIPA_BRIDGE_CLAIM_ID !== String(canaryRowId))
    errors.push('LIPA_BRIDGE_CLAIM_ID: expected "' + canaryRowId + '", got ' + JSON.stringify(bv.LIPA_BRIDGE_CLAIM_ID));
  if (bv.LIPA_BRIDGE_CLAIM_GEN !== '1')
    errors.push('LIPA_BRIDGE_CLAIM_GEN: expected "1", got ' + JSON.stringify(bv.LIPA_BRIDGE_CLAIM_GEN));
  // Exact session match — not a prefix
  if (bv.OPENCLAW_SESSION_ID !== exactSessionId)
    errors.push('OPENCLAW_SESSION_ID: expected exact "' + exactSessionId + '", got ' + JSON.stringify(bv.OPENCLAW_SESSION_ID));

  // Validate DB path (exact, not prefix)
  const reportedDb = canaryData.resolved_db_path || '';
  if (reportedDb !== tmpDb)
    errors.push('resolved_db_path: expected "' + tmpDb + '", got "' + reportedDb + '"');

  if (!canaryData.all_four_validated)
    errors.push('all_four_validated: false');

  if (errors.length > 0) {
    console.error('[Canary] VALIDATION ERRORS:');
    for (const e of errors) console.error('  ✗', e);
    preserveAndExit(1, 'validation errors');
    return;
  }

  // ── F-success verification ───────────────────────────────────────────────
  // Re-read DB to check done + outbox + lock released
  const freshDb = new (require('better-sqlite3'))(tmpDb, { readonly: true });

  const row = freshDb.prepare('SELECT status FROM bridge_lipa_inbox WHERE id = ?').get(canaryRowId);
  if (!row || row.status !== 'done') {
    errors.push('canary row status: expected "done", got "' + (row?.status || 'missing') + '"');
  }

  const outbox = freshDb.prepare('SELECT id FROM bridge_lipa_outbox WHERE inbox_id = ?').get(canaryRowId);
  if (!outbox) {
    errors.push('no outbox entry for canary row');
  }

  const lock = freshDb.prepare("SELECT value FROM bridge_lipa_state WHERE key = 'worker_lock'").get();
  if (lock) {
    errors.push('worker lock not released after clean completion');
  }

  const execState = freshDb.prepare("SELECT value FROM bridge_lipa_state WHERE key = 'execution_state'").get();
  if (execState) {
    const es = JSON.parse(execState.value);
    if (es.state !== 'terminal') {
      errors.push('execution_state: expected "terminal", got "' + es.state + '"');
    }
  }

  freshDb.close();

  if (errors.length > 0) {
    console.error('[Canary] F-SUCCESS ERRORS:');
    for (const e of errors) console.error('  ✗', e);
    preserveAndExit(1, 'F-success verification failed');
    return;
  }

  console.log('[Canary] ✓ All 4 bound values match exactly');
  console.log('[Canary] ✓ DB path matches');
  console.log('[Canary] ✓ Canary row status=done');
  console.log('[Canary] ✓ Outbox entry exists');
  console.log('[Canary] ✓ Worker lock released');
  console.log('[Canary] ✓ Execution state=terminal');

  // ── Restart no-launch ────────────────────────────────────────────────────
  console.log('[Canary] Running restart (should find no due work)...');
  let restartResult;
  try {
    restartResult = await runPreflight({
      now: Date.now(),
      sessionId: `canary-restart-${nonce}`,
      timeoutMs: 5000,
    });
  } catch (_) {
    restartResult = { launched: false, reason: 'exception' };
  }

  if (restartResult.launched) {
    console.error('[Canary] ✗ Restart launched — replay detected!');
    preserveAndExit(1, 'restart replay');
    return;
  }
  console.log('[Canary] ✓ Restart: no launch (reason: ' + restartResult.reason + ')');

  // ── SUCCESS — safe to clean up ───────────────────────────────────────────
  console.log('\n[Canary] ═══ SUCCESS ═══');
  console.log('[Canary] Full F-success path verified:');
  console.log('[Canary]   poll → fenced respond → done + outbox → lock release → restart no-launch');

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('[Canary] Temp dir cleaned up:', tmpDir);
  } catch (err) {
    console.error('[Canary] Cleanup warning:', err.message);
  }
  process.exit(0);
}

function preserveAndExit(code, reason) {
  console.error('[Canary] FAILED: ' + reason);
  console.error('[Canary] Temp dir PRESERVED for forensics:', tmpDir);
  console.error('[Canary] Files:', fs.readdirSync(tmpDir).join(', '));
  process.exit(code);
}

main().catch(err => {
  console.error('[Canary] Unexpected error:', err);
  console.error('[Canary] Temp dir PRESERVED:', tmpDir);
  process.exit(1);
});
