#!/usr/bin/env node
'use strict';
/**
 * lipa-failure-mode-verify.js — Verify the old failure mode now fails visibly.
 *
 * The old failure (rows 915/917/918/921):
 *   poll.js was called without LIPA_BRIDGE_BOUND env var → runs in LEGACY mode
 *   → finds no pending rows (row is 'claimed') → exits 0 silently
 *   → preflight: exit 0 but row not done → sets execution hold
 *
 * After the fix:
 *   Option D: agent message says DIRECT EXECUTE — don't call poll.js
 *   Option B: if poll.js IS called in BOUND mode without env vars, it finds the
 *             manifest file and loads the claim (or fails visibly with exit 1)
 *
 * This script verifies BOTH failure-to-visible paths:
 *
 * TEST A: poll.js called with LIPA_BRIDGE_BOUND=1 but without CLAIM_ID/GEN env
 *         vars AND no manifest file → should exit 1 with clear error (not silent 0)
 *
 * TEST B: poll.js called with LIPA_BRIDGE_BOUND=1 + session BUT row claimed by
 *         different session → should exit 1 (not silent 0)
 *
 * TEST C: poll.js called without LIPA_BRIDGE_BOUND (the old legacy mode) while
 *         row is 'claimed' → exits 0 (no work), which is the legacy behavior
 *         (this is unavoidable, but Option D makes it irrelevant since the agent
 *         no longer calls poll.js)
 *
 * TEST D: mock of the old agent message (contains CRON_MESSAGE "run poll.js")
 *         → show that a "wrong" agent message leads to hold (proven existing behavior)
 *         and that the new DIRECT EXECUTE message prevents this entirely
 *
 * Exits 0 if all failure-mode checks pass, 1 otherwise.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const existingDb = process.env.FAMILYBOT_DB_PATH || '';
if (existingDb && !existingDb.startsWith('/tmp/')) {
  console.error('[FailureVerify] REFUSED: FAMILYBOT_DB_PATH outside /tmp/');
  process.exit(1);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lipa-fmv-'));
const tmpDb = path.join(tmpDir, 'fmv.db');

process.env.FAMILYBOT_DB_PATH = tmpDb;
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.FAMILYBOT_DB_PATH = tmpDb;

const { initDB, getDB } = require('../src/db');
const { ensureLipaTables } = require('../src/bridge/lipaLane');
const rel = require('../src/bridge/lipaReliability');
const { runPreflight, buildBoundDirectMessage } = require('./lipa-bridge-preflight');

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    return true;
  } else {
    console.error(`  ❌ ${label}${detail ? ': ' + detail : ''}`);
    return false;
  }
}

async function main() {
  const results = [];
  initDB();
  ensureLipaTables();
  const db = getDB();

  const nonce = crypto.randomBytes(4).toString('hex');
  const now = Date.now();

  // ═══ TEST A: BOUND mode, no env vars, no manifest → exit 1 (visible failure) ═
  console.log('\n[FailureVerify] TEST A: BOUND mode without CLAIM_ID/GEN and no manifest');
  console.log('  (Old behavior: silent exit 0. New behavior: exit 1 with error message)');

  // Insert and claim a row to simulate in-flight state
  const rowAReq = `fmv-testA-${nonce}`;
  const insertA = db.prepare(
    `INSERT INTO bridge_lipa_inbox
       (request_id, command, args_json, from_addr, subject, created_at, status, attempts, available_at, updated_at)
     VALUES (?, 'test_echo', '{}', 'test@verify', 'TEST A', ?, 'pending', 0, ?, ?)`
  ).run(rowAReq, now, now, now);
  const rowAId = insertA.lastInsertRowid;

  // Claim it (simulating preflight having claimed but not passing env vars)
  const sessionA = `verify-sessionA-${nonce}`;
  rel.claimDue({ limit: 1, sessionId: sessionA, now });

  // Verify it's claimed
  const claimedA = db.prepare('SELECT status FROM bridge_lipa_inbox WHERE id=?').get(rowAId);
  results.push(check('Row A is claimed', claimedA && claimedA.status === 'claimed'));

  // Now call poll.js with LIPA_BRIDGE_BOUND=1 but NO CLAIM_ID/GEN and NO manifest
  const pollPath = path.join(__dirname, 'lipa-bridge-poll.js');
  const resultA = spawnSync('node', [pollPath], {
    env: {
      ...process.env,
      FAMILYBOT_DB_PATH: tmpDb,
      OPENCLAW_SESSION_ID: sessionA,
      LIPA_BRIDGE_BOUND: '1',
      // Deliberately NOT setting LIPA_BRIDGE_CLAIM_ID or LIPA_BRIDGE_CLAIM_GEN
      // Also making sure there's no manifest file for this session
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });

  const stderrA = resultA.stderr || '';
  console.log(`  poll.js exit code: ${resultA.status}`);
  console.log(`  poll.js stderr: ${stderrA.slice(0, 200)}`);

  results.push(check('TEST A: poll.js exits 1 (visible failure, not silent 0)', resultA.status === 1,
    `exit=${resultA.status}`));
  results.push(check('TEST A: stderr mentions missing manifest', stderrA.includes('manifest') || stderrA.includes('CLAIM_ID'),
    `stderr=${stderrA.slice(0, 100)}`));

  // ═══ TEST B: BOUND mode with manifest → loads claim, but wrong session → exit 1 ═
  console.log('\n[FailureVerify] TEST B: BOUND mode, manifest exists but wrong session');

  const sessionB = `verify-sessionB-${nonce}`;
  const manifestPath = `/tmp/lipa-bridge-claim-${sessionB}.json`;

  // Write a manifest for a DIFFERENT session
  fs.writeFileSync(manifestPath, JSON.stringify({
    session_id: `OTHER-session-${nonce}`,  // wrong session
    written_at: now,
    claim_details: [{ inbox_id: rowAId, claim_generation: 1, session_id: `OTHER-session-${nonce}` }],
  }));

  const resultB = spawnSync('node', [pollPath], {
    env: {
      ...process.env,
      FAMILYBOT_DB_PATH: tmpDb,
      OPENCLAW_SESSION_ID: sessionB,
      LIPA_BRIDGE_BOUND: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });

  const stderrB = resultB.stderr || '';
  console.log(`  poll.js exit code: ${resultB.status}`);
  console.log(`  poll.js stderr: ${stderrB.slice(0, 200)}`);

  results.push(check('TEST B: poll.js exits 1 for wrong-session manifest', resultB.status === 1,
    `exit=${resultB.status}`));

  // Clean up test manifest
  try { fs.unlinkSync(manifestPath); } catch (_) {}

  // ═══ TEST C: Legacy mode, row claimed → exits 0 (legacy behavior) ══════
  console.log('\n[FailureVerify] TEST C: Legacy mode (no LIPA_BRIDGE_BOUND), row claimed → exit 0 (no work)');
  console.log('  (This is the OLD silent failure. With Option D it is IRRELEVANT since agent no longer calls poll.js)');

  const resultC = spawnSync('node', [pollPath], {
    env: {
      ...process.env,
      FAMILYBOT_DB_PATH: tmpDb,
      // No LIPA_BRIDGE_BOUND — uses legacy mode
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  const stdoutC = resultC.stdout || '';
  console.log(`  poll.js exit code: ${resultC.status}`);
  console.log(`  LIPA_BRIDGE_WAKE in stdout: ${stdoutC.includes('LIPA_BRIDGE_WAKE')}`);

  results.push(check('TEST C: Legacy mode exits 0 (no work since all rows claimed)', resultC.status === 0));
  results.push(check('TEST C: Legacy mode does NOT emit LIPA_BRIDGE_WAKE (row is claimed)', !stdoutC.includes('LIPA_BRIDGE_WAKE')));

  // ═══ TEST D: New DIRECT EXECUTE message format ══════════════════════════
  console.log('\n[FailureVerify] TEST D: Verify DIRECT EXECUTE message format');
  console.log('  (Option D fix: agent message does not say "run poll.js")');

  // Build a mock claimed row for message testing
  const fakeRow = {
    id: 9999,
    request_id: `fmv-msgtest-${nonce}`,
    command: 'test_echo',
    args: { echo: 'hello' },
    from_addr: 'test@verify',
    subject: 'Test message',
    gmail_message_id: null,
    claim_generation: 1,
    created_at: now,
  };
  const fakeSession = `verify-msgtest-${nonce}`;
  const msg = buildBoundDirectMessage([fakeRow], fakeSession);

  console.log('\n  Generated DIRECT EXECUTE message:');
  console.log('  ' + msg.replace(/\n/g, '\n  '));

  results.push(check('TEST D: Message starts with LIPA_BRIDGE DIRECT EXECUTE', msg.startsWith('LIPA_BRIDGE DIRECT EXECUTE')));
  results.push(check('TEST D: Message does NOT contain "run `node scripts/lipa-bridge-poll.js`"',
    !msg.includes('run `node scripts/lipa-bridge-poll.js`')));
  results.push(check('TEST D: Message contains DO NOT run poll.js', msg.includes('DO NOT run poll.js')));
  results.push(check('TEST D: Message contains inbox_id', msg.includes('inbox_id:         9999')));
  results.push(check('TEST D: Message contains claim_generation in options_json',
    msg.includes('"claim_generation":1')));
  results.push(check('TEST D: Message contains session_id in options_json',
    msg.includes(fakeSession)));
  results.push(check('TEST D: Message contains lipa-bridge-respond.js',
    msg.includes('lipa-bridge-respond.js')));

  // ═══ SUMMARY ═══════════════════════════════════════════════════════════
  const allPassed = results.every(Boolean);
  const failCount = results.filter(r => !r).length;

  console.log('\n' + '═'.repeat(60));
  if (allPassed) {
    console.log('[FailureVerify] ✅ ALL FAILURE-MODE CHECKS PASSED');
    console.log('[FailureVerify] Old failure mode (silent exit 0) now fails visibly (exit 1)');
    console.log('[FailureVerify] New DIRECT EXECUTE message prevents poll.js call entirely');
  } else {
    console.error(`[FailureVerify] ❌ ${failCount} check(s) FAILED`);
  }
  console.log('═'.repeat(60));

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error('[FailureVerify] Unexpected error:', err);
  process.exit(1);
});
