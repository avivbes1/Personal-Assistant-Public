#!/usr/bin/env node
'use strict';
/**
 * lipa-lane-verify.js — End-to-end verification of the Lipa Bridge lane repair.
 *
 * Tests the full request-to-reply path using an isolated test DB.
 * Part of the lipa-lane-repair-20261027T0658Z-r1 fix verification.
 *
 * This script verifies:
 *   1. A synthetic test row is inserted into the inbox
 *   2. The preflight generates a correct DIRECT EXECUTE message (Option D fix)
 *   3. The manifest file is written (Option B fix)
 *   4. A mock "agent turn" runs respond.js for the claimed row
 *   5. The outbox row is created and the inbox row is marked 'done'
 *   6. The preflight's verifyCompletions passes and the lock is released
 *   7. A second preflight cycle finds no work (restart no-launch)
 *
 * This exercises the COMPLETE mechanical path (claim → manifest → direct-message
 * → respond.js → outbox → verifyCompletions → lock release). The mock agent turn
 * executes real Node.js code (respond.js) against the real schema — it is not a
 * fake stub. The only mocked part is "LLM decides to call respond.js" which is
 * replaced by a deterministic script call.
 *
 * Exits 0 on success, 1 on failure.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ── Safety: must use isolated DB ─────────────────────────────────────────────
const existingDb = process.env.FAMILYBOT_DB_PATH || '';
if (existingDb && !existingDb.startsWith('/tmp/')) {
  console.error('[Verify] REFUSED: FAMILYBOT_DB_PATH points outside /tmp/:', existingDb);
  process.exit(1);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lipa-verify-'));
const tmpDb = path.join(tmpDir, 'verify.db');
console.log('[Verify] Isolated test DB:', tmpDb);

process.env.FAMILYBOT_DB_PATH = tmpDb;
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.FAMILYBOT_DB_PATH = tmpDb; // re-override after dotenv

// Validate DB isolation by inode
const { initDB, getDB } = require('../src/db');
const { ensureLipaTables } = require('../src/bridge/lipaLane');
const { runPreflight, buildBoundDirectMessage } = require('./lipa-bridge-preflight');

async function main() {
  let pass = true;
  const failures = [];

  function check(label, condition, detail) {
    if (condition) {
      console.log(`  ✅ ${label}`);
    } else {
      console.error(`  ❌ ${label}${detail ? ': ' + detail : ''}`);
      pass = false;
      failures.push(label);
    }
  }

  // Initialize isolated DB
  initDB();
  ensureLipaTables();
  const db = getDB();

  // Validate inode
  const tmpStat = fs.statSync(tmpDb);
  const prodDb = path.resolve(__dirname, '..', 'data', 'family.db');
  if (fs.existsSync(prodDb)) {
    const prodStat = fs.statSync(prodDb);
    if (prodStat.ino === tmpStat.ino && prodStat.dev === tmpStat.dev) {
      console.error('[Verify] SAFETY ABORT: test DB has same inode as production!');
      process.exit(1);
    }
  }
  console.log('[Verify] Inode check: test DB is isolated (ino=' + tmpStat.ino + ')');

  const nonce = crypto.randomBytes(6).toString('hex');
  const testRequestId = `lipa-lane-repair-verify-${nonce}`;
  const now = Date.now();

  // ── Phase 1: Insert synthetic test row ────────────────────────────────────
  console.log('\n[Verify] Phase 1: Insert synthetic test row');
  const insertRes = db.prepare(
    `INSERT INTO bridge_lipa_inbox
       (request_id, command, args_json, from_addr, subject, created_at, status, attempts, available_at, updated_at)
     VALUES (?, 'test_echo', '{"echo":"lane-repair-verification"}', 'test@lipa-lane-repair', 'SYNTHETIC TEST - lipa-lane-repair-20261027', ?, 'pending', 0, ?, ?)`
  ).run(testRequestId, now, now, now);
  const testRowId = insertRes.lastInsertRowid;

  check('Test row inserted', testRowId > 0, `id=${testRowId}`);
  const inserted = db.prepare('SELECT * FROM bridge_lipa_inbox WHERE id=?').get(testRowId);
  check('Row is pending', inserted && inserted.status === 'pending');
  check('Row has correct request_id', inserted && inserted.request_id === testRequestId);

  // ── Phase 2: Run preflight with mock launcher (simulates agent turn) ──────
  console.log('\n[Verify] Phase 2: Run preflight with mock agent launcher');
  let capturedMessage = null;
  let capturedManifestPath = null;

  const mockLauncher = async ({ args, sessionId, claimDetails }) => {
    // The -m flag carries the agent message
    const msgIdx = args.indexOf('-m');
    capturedMessage = msgIdx >= 0 ? args[msgIdx + 1] : null;

    // Find the manifest file
    const manifestPath = `/tmp/lipa-bridge-claim-${sessionId}.json`;
    if (fs.existsSync(manifestPath)) {
      capturedManifestPath = manifestPath;
    }

    console.log('[Verify] Mock agent received message (first 200 chars):');
    console.log('  ' + (capturedMessage || '').slice(0, 200).replace(/\n/g, '\n  '));

    if (!capturedMessage || !capturedMessage.includes('DIRECT EXECUTE')) {
      return { code: 1, signal: null, timedOut: false, stdout: '' };
    }

    // Mock agent: simulate what a real agent would do — run respond.js
    const firstDetail = claimDetails && claimDetails[0];
    if (!firstDetail) {
      return { code: 1, signal: null, timedOut: false, stdout: '' };
    }

    const responseObj = {
      ok: true,
      echo: 'lane-repair-verification',
      test_type: 'synthetic',
      verified_path: 'direct-execute-option-d',
      session_id: sessionId,
      inbox_id: firstDetail.inbox_id,
    };
    const optionsObj = {
      claim_generation: firstDetail.claim_generation,
      session_id: sessionId,
    };

    // Run the real respond.js (actual Node.js code, real DB)
    try {
      execFileSync('node', [
        path.join(__dirname, 'lipa-bridge-respond.js'),
        String(firstDetail.inbox_id),
        testRequestId,
        JSON.stringify(responseObj),
        'SYNTHETIC TEST - lipa-lane-repair-20261027',
        '',
        JSON.stringify(optionsObj),
      ], {
        env: { ...process.env, FAMILYBOT_DB_PATH: tmpDb, OPENCLAW_SESSION_ID: sessionId },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      return { code: 0, signal: null, timedOut: false, stdout: '' };
    } catch (err) {
      console.error('[Verify] respond.js failed:', err.message);
      return { code: 1, signal: null, timedOut: false, stdout: '' };
    }
  };

  const preflightSid = `verify-${process.pid}-${now}`;
  let preflightResult;
  try {
    preflightResult = await runPreflight({
      launcher: mockLauncher,
      now,
      sessionId: preflightSid,
      timeoutMs: 30000,
    });
  } catch (err) {
    console.error('[Verify] runPreflight threw:', err.message);
    cleanup(tmpDir);
    process.exit(1);
  }

  // ── Phase 3: Verify preflight result ─────────────────────────────────────
  console.log('\n[Verify] Phase 3: Verify preflight result');
  console.log('  Preflight result:', JSON.stringify(preflightResult, null, 2));

  check('Preflight launched', preflightResult.launched === true);
  check('Preflight clean exit', preflightResult.reason === 'clean_exit',
    `reason=${preflightResult.reason}`);
  check('No hold set', !preflightResult.holdSet);

  // ── Phase 4: Verify Option D message ─────────────────────────────────────
  console.log('\n[Verify] Phase 4: Verify Option D direct execute message');
  check('Message uses DIRECT EXECUTE', capturedMessage && capturedMessage.includes('DIRECT EXECUTE'));
  check('Message does NOT say run poll.js', capturedMessage && !capturedMessage.includes('run `node scripts/lipa-bridge-poll.js`'));
  check('Message contains inbox_id', capturedMessage && capturedMessage.includes(`inbox_id:         ${testRowId}`));
  check('Message contains respond.js command', capturedMessage && capturedMessage.includes('lipa-bridge-respond.js'));
  check('Message contains claim_generation', capturedMessage && capturedMessage.includes('claim_generation'));
  check('Message contains session_id', capturedMessage && capturedMessage.includes(preflightSid));

  // ── Phase 5: Verify Option B manifest file ────────────────────────────────
  console.log('\n[Verify] Phase 5: Verify Option B manifest file');
  check('Manifest file was written', capturedManifestPath !== null);
  if (capturedManifestPath) {
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(capturedManifestPath, 'utf8')); } catch (_) {}
    check('Manifest has session_id', manifest && manifest.session_id === preflightSid);
    check('Manifest has claim_details', manifest && Array.isArray(manifest.claim_details) && manifest.claim_details.length > 0);
    check('Manifest inbox_id matches', manifest && manifest.claim_details[0] &&
      manifest.claim_details[0].inbox_id === testRowId);
  }

  // ── Phase 6: Verify DB state ──────────────────────────────────────────────
  console.log('\n[Verify] Phase 6: Verify DB state');
  const finalRow = db.prepare('SELECT * FROM bridge_lipa_inbox WHERE id=?').get(testRowId);
  check('Inbox row is done', finalRow && finalRow.status === 'done', `status=${finalRow && finalRow.status}`);
  check('Row session_id correct', finalRow && finalRow.session_id === preflightSid);

  const outboxRow = db.prepare('SELECT * FROM bridge_lipa_outbox WHERE inbox_id=?').get(testRowId);
  check('Outbox row exists', outboxRow !== undefined && outboxRow !== null);
  check('Outbox response has ok:true', outboxRow && JSON.parse(outboxRow.response_json).ok === true);
  check('Outbox response has correct path marker', outboxRow &&
    JSON.parse(outboxRow.response_json).verified_path === 'direct-execute-option-d');

  const rel = require('../src/bridge/lipaReliability');
  check('No execution hold', rel.getExecutionHold() === null);
  check('isPaused false', rel.isPaused() === false);

  const execState = db.prepare('SELECT value FROM bridge_lipa_state WHERE key=?').get('execution_state');
  const st = execState ? JSON.parse(execState.value) : null;
  check('Execution state is terminal', st && st.state === 'terminal',
    `state=${st && st.state}`);

  // ── Phase 7: Restart cycle no-launch ─────────────────────────────────────
  console.log('\n[Verify] Phase 7: Restart cycle (should find no work)');
  let restartLauncherCalled = false;
  const noopLauncher = async () => { restartLauncherCalled = true; return { code: 0, signal: null, timedOut: false, stdout: '' }; };
  const restartResult = await runPreflight({ launcher: noopLauncher, now: Date.now(), sessionId: `verify-restart-${now}` });
  check('Restart did not launch', restartResult.launched === false);
  check('Restart reason is no_due_work', restartResult.reason === 'no_due_work',
    `reason=${restartResult.reason}`);
  check('Restart launcher not called', !restartLauncherCalled);

  // ── Result ────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  if (pass) {
    console.log('[Verify] ✅ ALL CHECKS PASSED — Lipa Bridge lane repair verified');
    console.log('[Verify] Path exercised: inbox → claim → direct-message(D) + manifest(B) → respond.js → outbox → verifyCompletions → lock released → restart no-launch');
  } else {
    console.error(`[Verify] ❌ FAILED: ${failures.length} check(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
  }
  console.log('═'.repeat(60));

  cleanup(tmpDir);
  process.exit(pass ? 0 : 1);
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  // Also clean up manifest file
  // (already in /tmp/lipa-bridge-claim-<sid>.json — will be cleaned by OS)
}

main().catch(err => {
  console.error('[Verify] Unexpected error:', err);
  process.exit(1);
});
