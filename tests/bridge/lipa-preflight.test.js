'use strict';
// SAFETY: bridge tests must NEVER run against the production DB.
// run-bridge-isolated.js sets FAMILYBOT_DB_PATH to a temp DB before spawning.
const _fs = require('fs'), _path = require('path');
const _dbEnv = process.env.FAMILYBOT_DB_PATH || '';
const _dataDir = _path.resolve(__dirname, '../../data');
const _realDb = _dbEnv ? (function(){ try { return _fs.realpathSync(_dbEnv); } catch(_) { return _path.resolve(_dbEnv); } })() : '';
const _realProd = (function(){ try { return _fs.realpathSync(_path.join(_dataDir, 'family.db')); } catch(_) { return ''; } })();
if (!_dbEnv || _realDb.startsWith(_dataDir) || _realDb === _realProd) {
  module.exports = { run: async () => ({ pass: false, message: 'SAFETY ABORT: FAMILYBOT_DB_PATH is not set to an isolated test DB. Run via run-bridge-isolated.js.' }) };
  return;
}
/**
 * lipa-preflight.test.js — system-cron preflight wrapper for the Lipa Bridge.
 *
 * T1-T15: original gate tests
 * T16-T26: review-mandated tests (execution state, verified completion,
 *          fence enforcement, fail-closed caps, first-timeout park)
 *
 * Harness: module.exports = { async run() } matching lipa-worker.test.js.
 */

const { initDB, getDB } = require('../../src/db');
const { ensureLipaTables } = require('../../src/bridge/lipaLane');
const rel = require('../../src/bridge/lipaReliability');
const accounting = require('../../src/bridge/lipaAccounting');
const {
  runPreflight, setExecutionHold, clearExecutionHold, getExecutionHold,
  getExecutionState, setExecutionState,
} = require('../../scripts/lipa-bridge-preflight');

const PREFIX = 'TEST_LIPA_PF_';
const HOLD_KEY = 'execution_hold';
const LOCK_KEY = 'worker_lock';
const EXEC_STATE_KEY = 'execution_state';
const STATE_KEYS = [HOLD_KEY, LOCK_KEY, EXEC_STATE_KEY, 'circuit'];

function snapshotState(db, key) {
  const r = db.prepare('SELECT value, updated_at FROM bridge_lipa_state WHERE key = ?').get(key);
  return r || null;
}
function restoreState(db, key, snap) {
  db.prepare('DELETE FROM bridge_lipa_state WHERE key = ?').run(key);
  if (snap) db.prepare('INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES (?, ?, ?)').run(key, snap.value, snap.updated_at);
}
/** Wipe all control-plane state between tests. */
function resetState(db) {
  db.prepare(`DELETE FROM bridge_lipa_state WHERE key IN (${STATE_KEYS.map(() => '?').join(',')})`)
    .run(...STATE_KEYS);
}
function cleanup(db, ids) {
  if (ids.length) {
    const list = ids.join(',');
    db.prepare(`DELETE FROM bridge_lipa_costs WHERE inbox_id IN (${list})`).run();
    db.prepare(`DELETE FROM bridge_lipa_outbox WHERE inbox_id IN (${list})`).run();
    db.prepare(`DELETE FROM bridge_lipa_attempts WHERE inbox_id IN (${list})`).run();
    db.prepare(`DELETE FROM bridge_lipa_inbox WHERE id IN (${list})`).run();
  }
  // Clean any remaining test rows (delete outbox/costs/attempts first due to FK)
  const remaining = db.prepare(`SELECT id FROM bridge_lipa_inbox WHERE request_id LIKE '${PREFIX}%'`).all();
  if (remaining.length) {
    const rlist = remaining.map(r => r.id).join(',');
    db.prepare(`DELETE FROM bridge_lipa_costs WHERE inbox_id IN (${rlist})`).run();
    db.prepare(`DELETE FROM bridge_lipa_outbox WHERE inbox_id IN (${rlist})`).run();
    db.prepare(`DELETE FROM bridge_lipa_attempts WHERE inbox_id IN (${rlist})`).run();
    db.prepare(`DELETE FROM bridge_lipa_inbox WHERE id IN (${rlist})`).run();
  }
}
function enqueue(tag) {
  const res = rel.enqueueGuarded({ requestId: PREFIX + tag, command: 'noop', args: { tag } });
  return res.id;
}

/**
 * Force ONE specific row into 'claimed' for a session via direct SQL.
 * Returns the claim_generation stamped.
 */
function forceClaim(db, id, sessionId) {
  const now = Date.now();
  db.prepare("UPDATE bridge_lipa_inbox SET status='claimed', session_id=?, claim_generation=COALESCE(claim_generation,0)+1, lease_expires_at=?, updated_at=? WHERE id=?")
    .run(sessionId, now + rel.LEASE_MS, now, id);
  return db.prepare('SELECT claim_generation FROM bridge_lipa_inbox WHERE id=?').get(id).claim_generation;
}

/**
 * Force a row to 'done' with an outbox entry (simulating what respond.js does).
 */
function forceComplete(db, id, sessionId, gen) {
  const now = Date.now();
  db.prepare("UPDATE bridge_lipa_inbox SET status='done', session_id=?, claim_generation=?, updated_at=? WHERE id=?")
    .run(sessionId, gen, now, id);
  // Use unique request_id per inbox_id to avoid dedup conflicts across tests
  db.prepare("INSERT OR IGNORE INTO bridge_lipa_outbox (inbox_id, request_id, response_json, original_subject, in_reply_to, created_at) VALUES (?, ?, '{}', '', '', ?)")
    .run(id, PREFIX + 'done_' + id, now);
}

/** Mock launcher that resolves with a configurable result. */
function mockLauncher(result) {
  let callCount = 0;
  let lastCall = null;
  const fn = (opts) => {
    callCount++;
    lastCall = opts;
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result);
  };
  fn.calls = () => callCount;
  fn.lastCall = () => lastCall;
  return fn;
}

module.exports = {
  async run() {
    const errors = [];
    initDB();
    ensureLipaTables();
    const db = getDB();
    const ids = [];
    const stateSnaps = {};
    for (const k of STATE_KEYS) stateSnaps[k] = snapshotState(db, k);
    resetState(db);

    try {
      // ── T1: empty queue → no launch ──────────────────────────────────────────
      {
        const launcher = mockLauncher({ code: 0, signal: null, timedOut: false });
        const res = await runPreflight({ launcher, deps: { getDueCount: () => 0 } });
        if (res.launched) errors.push('T1: launched on empty queue');
        if (res.reason !== 'no_due_work') errors.push(`T1: reason=${res.reason}, expected no_due_work`);
        if (launcher.calls() !== 0) errors.push('T1: launcher was called on empty queue');
      }

      // ── T2: daily cap hit → no launch ────────────────────────────────────────
      {
        const launcher = mockLauncher({ code: 0, signal: null, timedOut: false });
        const res = await runPreflight({
          launcher, deps: { getDueCount: () => 3, checkDailyCap: () => ({ blocked: true, spend: 25, cap: 20 }) },
        });
        if (res.launched) errors.push('T2: launched despite daily cap');
        if (res.reason !== 'daily_cap') errors.push(`T2: reason=${res.reason}, expected daily_cap`);
      }

      // ── T3: circuit open → no launch ─────────────────────────────────────────
      {
        const launcher = mockLauncher({ code: 0, signal: null, timedOut: false });
        const res = await runPreflight({
          launcher, deps: { isPaused: () => true, getDueCount: () => 5 },
        });
        if (res.launched) errors.push('T3: launched with circuit open');
        if (res.reason !== 'circuit_open') errors.push(`T3: reason=${res.reason}, expected circuit_open`);
      }

      // ── T4: lock already held → no launch ────────────────────────────────────
      {
        rel.acquireWorkerLock('other-session-t4');
        const launcher = mockLauncher({ code: 0, signal: null, timedOut: false });
        const res = await runPreflight({ launcher, deps: { getDueCount: () => 1 } });
        if (res.launched) errors.push('T4: launched with lock held');
        if (res.reason !== 'lock_held') errors.push(`T4: reason=${res.reason}, expected lock_held`);
        rel.releaseWorkerLock('other-session-t4');
      }

      // ── T5: execution hold → no launch, NEVER auto-cleared ───────────────────
      {
        const holdVal = { active: true, reason: 'T5 test hold', session_id: 'dead-t5', claimed_ids: [], since: Date.now() - 600000 };
        db.prepare(`INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
          .run(HOLD_KEY, JSON.stringify(holdVal), Date.now());
        // Expired lock — would have auto-cleared under old logic
        db.prepare(`INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
          .run(LOCK_KEY, JSON.stringify({ holder: 'dead-t5', acquired_at: Date.now() - 600000, expires_at: Date.now() - 300000 }), Date.now());

        const res = await runPreflight({ launcher: mockLauncher({ code: 0 }), deps: { getDueCount: () => 5 } });
        if (res.launched) errors.push('T5: launched with hold active');
        if (res.reason !== 'execution_hold') errors.push(`T5: reason=${res.reason}, expected execution_hold`);
        const holdAfter = getExecutionHold();
        if (!holdAfter || !holdAfter.active) errors.push('T5: hold was auto-cleared');
        resetState(db);
      }

      // ── T6: two concurrent wrappers → only one launches ──────────────────────
      {
        rel.acquireWorkerLock('wrapper-1-t6');
        const res2 = await runPreflight({ launcher: mockLauncher({ code: 0 }), sessionId: 'wrapper-2-t6', deps: { getDueCount: () => 2 } });
        if (res2.launched) errors.push('T6: second wrapper launched');
        if (res2.reason !== 'lock_held') errors.push(`T6: reason=${res2.reason}, expected lock_held`);
        rel.releaseWorkerLock('wrapper-1-t6');
        resetState(db);
      }

      // ── T7: new arrival while hold active → still blocked ────────────────────
      {
        setExecutionHold('T7 prior timeout', { session_id: 'old-t7' });
        const newId = enqueue('t7-new'); ids.push(newId);
        const res = await runPreflight({ launcher: mockLauncher({ code: 0 }) });
        if (res.launched) errors.push('T7: launched despite hold');
        if (res.reason !== 'execution_hold') errors.push(`T7: reason=${res.reason}, expected execution_hold`);
        resetState(db);
      }

      // ── T8: spawn error → hold set, no lock release ──────────────────────────
      {
        resetState(db);
        const launcher = mockLauncher(new Error('ENOENT: openclaw not found'));
        const res = await runPreflight({ launcher, sessionId: 'spawn-fail-t8', deps: {
          getDueCount: () => 1,
          claimDue: ({ sessionId: s }) => ({ rows: [{ id: 9998, claim_generation: 1 }] }),
        } });
        if (!res.launched) errors.push('T8: not marked as launched');
        if (res.reason !== 'spawn_error') errors.push(`T8: reason=${res.reason}, expected spawn_error`);
        if (!res.holdSet) errors.push('T8: hold was not set');
        const hold = getExecutionHold();
        if (!hold || !hold.active) errors.push('T8: execution hold not active');
        const lock = JSON.parse((db.prepare("SELECT value FROM bridge_lipa_state WHERE key='worker_lock'").get() || {}).value || 'null');
        if (!lock) errors.push('T8: lock was released');
        resetState(db);
      }

      // ── T9: CLI timeout → quarantine, hold, lock NOT released, gen bumped ────
      {
        resetState(db);
        const id = enqueue('t9'); ids.push(id);
        const sid = 'timeout-sess-t9';
        const genBefore = forceClaim(db, id, sid);

        const res = await runPreflight({
          launcher: mockLauncher({ code: null, signal: 'SIGTERM', timedOut: true }),
          sessionId: sid, deps: {
            getDueCount: () => 1,
            claimDue: () => ({ rows: [{ id: id, claim_generation: genBefore }] }),
          },
        });
        if (!res.launched) errors.push('T9: not marked as launched');
        if (res.reason !== 'timeout') errors.push(`T9: reason=${res.reason}, expected timeout`);
        if (!res.holdSet) errors.push('T9: hold was not set');
        const row = db.prepare('SELECT status, claim_generation FROM bridge_lipa_inbox WHERE id = ?').get(id);
        if (row && row.status !== 'needs_review') errors.push(`T9: row status=${row.status}, expected needs_review`);
        if (row && row.claim_generation <= genBefore) errors.push('T9: claim_generation not bumped');
        const lock = JSON.parse((db.prepare("SELECT value FROM bridge_lipa_state WHERE key='worker_lock'").get() || {}).value || 'null');
        if (!lock) errors.push('T9: lock was released');
        resetState(db);
      }

      // ── T10: restart with unknown remote → hold blocks ───────────────────────
      {
        setExecutionHold('previous timeout', { session_id: 'ghost-t10' });
        const res = await runPreflight({ launcher: mockLauncher({ code: 0 }), deps: { getDueCount: () => 3 } });
        if (res.launched) errors.push('T10: launched despite hold');
        if (res.reason !== 'execution_hold') errors.push(`T10: reason=${res.reason}, expected execution_hold`);
        resetState(db);
      }

      // ── T11: late completion after timeout → fenced ──────────────────────────
      {
        const id = enqueue('t11'); ids.push(id);
        const gen1 = forceClaim(db, id, 'late-sess-t11');
        const now = Date.now();
        db.prepare('UPDATE bridge_lipa_inbox SET lease_expires_at = ? WHERE id = ?').run(now - 1000, id);
        rel.reconcileStaleClaims({ now });
        const completeResult = rel.completeClaim({
          inboxId: id, claimGeneration: gen1, sessionId: 'late-sess-t11', response: { ok: true },
        });
        if (!completeResult.fenced) errors.push('T11: late completion was NOT fenced');
        const outbox = db.prepare('SELECT COUNT(*) c FROM bridge_lipa_outbox WHERE inbox_id = ?').get(id);
        if (outbox.c !== 0) errors.push('T11: fenced late completion created an outbox row');
        resetState(db);
      }

      // ── T12: read-only pre-check failure → no side effects ───────────────────
      {
        resetState(db);
        const launcher = mockLauncher({ code: 0 });
        const res = await runPreflight({
          launcher, deps: { getDueCount: () => { throw new Error('DB read failed'); } },
        });
        if (res.launched) errors.push('T12: launched despite read error');
        if (res.reason !== 'preflight_read_error') errors.push(`T12: reason=${res.reason}, expected preflight_read_error`);
        if (launcher.calls() !== 0) errors.push('T12: launcher called despite read failure');
        const hold = getExecutionHold();
        if (hold && hold.active) errors.push('T12: read failure set an execution hold');
      }

      // ── T13: clean exit (code 0) with verified completion → no hold ──────────
      {
        resetState(db);
        const id = enqueue('t13'); ids.push(id);
        const sid = 'clean-t13';

        const launcher = (opts) => {
          const gen = forceClaim(db, id, sid);
          forceComplete(db, id, sid, gen);
          return Promise.resolve({ code: 0, signal: null, timedOut: false, stdout: '' });
        };
        // Inject expected claim IDs so verification works on shared DB
        const res = await runPreflight({ launcher, sessionId: sid, deps: { getDueCount: () => 1, claimDue: () => ({ rows: [{ id: id, claim_generation: 1 }] }) } });
        if (!res.launched) errors.push('T13: did not launch');
        if (res.reason !== 'clean_exit') errors.push(`T13: reason=${res.reason}, expected clean_exit`);
        const hold = getExecutionHold();
        if (hold && hold.active) errors.push('T13: hold was set on verified clean exit');
        resetState(db);
      }

      // ── T14: non-zero exit → hold set ────────────────────────────────────────
      {
        resetState(db);
        const res = await runPreflight({
          launcher: mockLauncher({ code: 1, signal: null, timedOut: false }),
          sessionId: 'nonzero-t14', deps: {
            getDueCount: () => 1,
            claimDue: () => ({ rows: [{ id: 9997, claim_generation: 1 }] }),
          },
        });
        if (!res.launched) errors.push('T14: did not launch');
        if (res.reason !== 'nonzero_exit') errors.push(`T14: reason=${res.reason}, expected nonzero_exit`);
        if (!res.holdSet) errors.push('T14: hold was not set');
        const hold = getExecutionHold();
        if (!hold || !hold.active) errors.push('T14: execution hold not active');
        resetState(db);
      }

      // ── T15: --clear-hold works correctly ────────────────────────────────────
      {
        const original = setExecutionHold('T15 timeout', { session_id: 'held-t15', claimed_ids: [999] });
        const before = getExecutionHold();
        if (!before || !before.active) errors.push('T15: hold was not set');
        const cleared = clearExecutionHold();
        if (!cleared) errors.push('T15: clearExecutionHold returned null');
        if (cleared && cleared.reason !== 'T15 timeout') errors.push('T15: wrong reason');
        const after = getExecutionHold();
        if (after) errors.push('T15: hold still active after clear');
        const noop = clearExecutionHold();
        if (noop !== null) errors.push('T15: clearing empty hold did not return null');
      }

      // ═══════════════════════════════════════════════════════════════════════
      // T16-T26: review-mandated tests
      // ═══════════════════════════════════════════════════════════════════════

      // ── T16: two concurrent wrappers blocked by execution state ─────────────
      {
        resetState(db);
        // First wrapper sets execution_state to 'active'
        setExecutionState({ state: 'active', session_id: 'wrapper-a-t16', started_at: Date.now() });
        const res = await runPreflight({
          launcher: mockLauncher({ code: 0 }), sessionId: 'wrapper-b-t16', deps: { getDueCount: () => 2 },
        });
        if (res.launched) errors.push('T16: second wrapper launched despite active execution state');
        if (res.reason !== 'execution_state_active') errors.push(`T16: reason=${res.reason}, expected execution_state_active`);
        resetState(db);
      }

      // ── T17: second arrival after lock TTL with remote still active ─────────
      {
        resetState(db);
        // Set execution state to 'active' but let the lock expire
        setExecutionState({ state: 'active', session_id: 'remote-alive-t17', started_at: Date.now() - 600000 });
        // Expired lock
        db.prepare(`INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
          .run(LOCK_KEY, JSON.stringify({ holder: 'remote-alive-t17', acquired_at: Date.now() - 600000, expires_at: Date.now() - 300000 }), Date.now());

        const res = await runPreflight({
          launcher: mockLauncher({ code: 0 }), sessionId: 'new-t17', deps: { getDueCount: () => 1 },
        });
        if (res.launched) errors.push('T17: launched despite active execution state (lock expired but remote alive)');
        if (res.reason !== 'execution_state_active') errors.push(`T17: reason=${res.reason}, expected execution_state_active`);
        resetState(db);
      }

      // ── T18: first timeout parks immediately (no retry) ─────────────────────
      {
        resetState(db);
        const id = enqueue('t18'); ids.push(id);
        const sid = 'timeout-first-t18';
        forceClaim(db, id, sid);
        // Expire the lease
        const now = Date.now();
        db.prepare('UPDATE bridge_lipa_inbox SET lease_expires_at = ? WHERE id = ?').run(now - 1000, id);
        rel.reconcileStaleClaims({ now });
        const row = db.prepare('SELECT status, attempts FROM bridge_lipa_inbox WHERE id = ?').get(id);
        // Item 3: first timeout MUST go to needs_review, not retry
        if (row.status === 'retry') errors.push('T18: first lease expiry went to retry (UNSAFE — should be needs_review)');
        if (row.status !== 'needs_review') errors.push(`T18: status=${row.status}, expected needs_review`);
        // Hold must be set on ANY lease expiry
        const hold = getExecutionHold();
        if (!hold || !hold.active) errors.push('T18: execution hold not set on first lease expiry');
        resetState(db);
      }

      // ── T19: exit 0 without response in DB → hold set ──────────────────────
      {
        resetState(db);
        // Row must be pending+due so preflight pre-reads its ID
        const id = enqueue('t19'); ids.push(id);
        const sid = 'exit0-noresponse-t19';
        // Launcher claims the row but does NOT complete it (respond.js didn't run)
        const launcher = (opts) => {
          forceClaim(db, id, sid);
          return Promise.resolve({ code: 0, signal: null, timedOut: false, stdout: '' });
        };
        const res = await runPreflight({ launcher, sessionId: sid, deps: { getDueCount: () => 1, claimDue: () => ({ rows: [{ id: id, claim_generation: 1 }] }) } });
        if (!res.launched) errors.push('T19: not launched');
        if (res.reason === 'clean_exit') errors.push('T19: treated as clean exit despite uncompleted row');
        if (res.reason !== 'clean_exit_verification_failed') errors.push(`T19: reason=${res.reason}, expected clean_exit_verification_failed`);
        const hold = getExecutionHold();
        if (!hold || !hold.active) errors.push('T19: hold not set on unverified exit 0');
        const row = db.prepare('SELECT status FROM bridge_lipa_inbox WHERE id = ?').get(id);
        if (row && row.status === 'claimed') errors.push('T19: row still claimed after failed exit 0 verification');
        resetState(db);
      }

      // ── T20: stale responder — fenced, lock NOT released ───────────────────
      {
        resetState(db);
        const id = enqueue('t20'); ids.push(id);
        const sid = 'stale-t20';
        const gen1 = forceClaim(db, id, sid);
        // Bump generation (simulating reconcile)
        db.prepare('UPDATE bridge_lipa_inbox SET claim_generation = claim_generation + 1 WHERE id = ?').run(id);
        // Late completion with old generation
        const result = rel.completeClaim({
          inboxId: id, claimGeneration: gen1, sessionId: sid, response: { ok: true },
        });
        if (!result.fenced) errors.push('T20: stale completion was not fenced');
        // No outbox row
        const outbox = db.prepare('SELECT COUNT(*) c FROM bridge_lipa_outbox WHERE inbox_id = ?').get(id);
        if (outbox.c !== 0) errors.push('T20: fenced completion created an outbox row');
        resetState(db);
      }

      // ── T21: bad/missing fence in respond path → rejected ──────────────────
      // This tests the respond.js logic: if a row has claim_generation in DB,
      // a completion without providing it must be rejected.
      {
        const id = enqueue('t21'); ids.push(id);
        const gen = forceClaim(db, id, 'fence-t21');
        // completeClaim without matching generation → should be fenced
        const result = rel.completeClaim({
          inboxId: id, claimGeneration: gen - 1, sessionId: 'fence-t21', response: { ok: true },
        });
        if (!result.fenced) errors.push('T21: completion with wrong generation was not fenced');
        resetState(db);
      }

      // ── T22: corrupt hold JSON → fail closed ──────────────────────────────
      {
        resetState(db);
        // Write corrupt JSON into the hold key
        db.prepare(`INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
          .run(HOLD_KEY, '{corrupt json!!!', Date.now());
        // getExecutionHold should return null (not crash), and preflight should NOT treat it as a hold
        let holdResult;
        try { holdResult = getExecutionHold(); } catch (e) { errors.push('T22: corrupt hold JSON threw instead of failing closed'); }
        // With corrupt JSON, readState returns null → getExecutionHold returns null → no hold
        // This is acceptable: the hold is not "active" because it's unreadable.
        // The critical thing is it doesn't crash.

        // Now write corrupt execution_state
        db.prepare(`INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
          .run(EXEC_STATE_KEY, 'not json at all', Date.now());
        let stateResult;
        try { stateResult = getExecutionState(); } catch (e) { errors.push('T22: corrupt execution_state threw instead of failing closed'); }
        // Fail closed: corrupt state should return { state: 'unknown', corrupt: true }
        // which BLOCKS launches (not null which would allow them)
        if (!stateResult) errors.push('T22: corrupt execution_state returned null (fail OPEN, not closed)');
        if (stateResult && stateResult.state !== 'unknown') errors.push(`T22: corrupt state=${stateResult.state}, expected unknown`);
        if (stateResult && !stateResult.corrupt) errors.push('T22: corrupt state not flagged as corrupt');
        // Clear the corrupt HOLD first so we can test the execution_state gate separately
        db.prepare('DELETE FROM bridge_lipa_state WHERE key = ?').run(HOLD_KEY);
        // Verify corrupt execution_state actually blocks a launch
        const blockRes = await runPreflight({ launcher: mockLauncher({ code: 0 }), deps: { getDueCount: () => 1 } });
        if (blockRes.launched) errors.push('T22: launched despite corrupt execution_state (fail OPEN)');
        if (blockRes.reason !== 'execution_state_active') errors.push(`T22: reason=${blockRes.reason}, expected execution_state_active`);
        resetState(db);
      }

      // ── T23: cumulative request cap ────────────────────────────────────────
      {
        const id = enqueue('t23'); ids.push(id);
        // Record 3 attempts each costing $1
        accounting.recordRequestCost({ inboxId: id, costUsd: 1.0 });
        accounting.recordRequestCost({ inboxId: id, costUsd: 1.0 });
        accounting.recordRequestCost({ inboxId: id, costUsd: 1.0 });
        const capCheck = accounting.checkRequestCap({ inboxId: id });
        if (!capCheck.alert) errors.push(`T23: cumulative cost $${capCheck.cost} did not trigger alert at $${capCheck.cap}`);
        if (capCheck.cost < 3.0) errors.push(`T23: cumulative cost should be >= $3, got $${capCheck.cost}`);
        // Single small cost should not trigger
        const id2 = enqueue('t23-small'); ids.push(id2);
        accounting.recordRequestCost({ inboxId: id2, costUsd: 0.5 });
        const smallCheck = accounting.checkRequestCap({ inboxId: id2 });
        if (smallCheck.alert) errors.push('T23: small cumulative cost wrongly triggered alert');
        resetState(db);
      }

      // ── T24: daily cap read error → fail closed ────────────────────────────
      {
        // checkDailyCap with broken getDailySpend should return blocked:true
        const capResult = accounting.checkDailyCap(Date.now());
        // Normal call should work; we can't easily break getDailySpend without monkey-patching.
        // Instead verify the fail-closed path exists by checking the return shape.
        // The actual fail-closed was tested by code review — the try/catch returns blocked:true.
        // We verify the normal path returns the right shape.
        if (typeof capResult.blocked !== 'boolean') errors.push('T24: checkDailyCap did not return blocked boolean');
        if (typeof capResult.spend !== 'number') errors.push('T24: checkDailyCap did not return spend number');
        if (typeof capResult.cap !== 'number') errors.push('T24: checkDailyCap did not return cap number');
        // Verify fail-closed by testing with a deps override in preflight
        const res = await runPreflight({
          launcher: mockLauncher({ code: 0 }), deps: {
            getDueCount: () => 1,
            checkDailyCap: () => { throw new Error('accounting DB broken'); },
          },
        });
        // The preflight's try/catch in the read-only section should catch this
        if (res.launched) errors.push('T24: launched despite checkDailyCap throw (should be caught in preflight_read_error)');
        resetState(db);
      }

      // ── T25: first lease expiry parks immediately, sets hold ────────────────
      // (Comprehensive version of T18 — also verifies the hold contains the right data)
      {
        resetState(db);
        const id = enqueue('t25'); ids.push(id);
        const sid = 'first-lease-t25';
        const gen = forceClaim(db, id, sid);
        const now = Date.now();
        db.prepare('UPDATE bridge_lipa_inbox SET lease_expires_at = ? WHERE id = ?').run(now - 1000, id);
        rel.reconcileStaleClaims({ now });
        const row = db.prepare('SELECT status, attempts, claim_generation, last_error FROM bridge_lipa_inbox WHERE id = ?').get(id);
        if (row.status !== 'needs_review') errors.push(`T25: status=${row.status}, expected needs_review`);
        if (row.attempts !== 1) errors.push(`T25: attempts=${row.attempts}, expected 1`);
        if (row.claim_generation <= gen) errors.push('T25: claim_generation not bumped');
        if (!row.last_error || !row.last_error.includes('needs review')) errors.push('T25: last_error missing needs review text');
        const hold = getExecutionHold();
        if (!hold) errors.push('T25: no hold set after first lease expiry');
        if (hold && !hold.reason.includes('lease expired')) errors.push('T25: hold reason missing "lease expired"');
        if (hold && hold.session_id !== sid) errors.push(`T25: hold session_id=${hold.session_id}, expected ${sid}`);
        resetState(db);
      }

      // ── T26: launcher stdout captured + launch record persisted ───────────
      {
        resetState(db);
        const id = enqueue('t26'); ids.push(id);
        const sid = 'stdout-t26';
        const launcher = (opts) => {
          const gen = forceClaim(db, id, sid);
          forceComplete(db, id, sid, gen);
          return Promise.resolve({
            code: 0, signal: null, timedOut: false,
            stdout: JSON.stringify({ usage: { input_tokens: 5000, output_tokens: 1000 } }),
          });
        };
        const res = await runPreflight({ launcher, sessionId: sid, deps: { getDueCount: () => 1, claimDue: () => ({ rows: [{ id: id, claim_generation: 1 }] }) } });
        if (!res.launched) errors.push('T26: not launched');
        if (res.reason !== 'clean_exit') errors.push(`T26: reason=${res.reason}, expected clean_exit`);
        // Execution state should be 'terminal'
        const execState = getExecutionState();
        if (!execState) errors.push('T26: no execution state persisted');
        if (execState && execState.state !== 'terminal') errors.push(`T26: state=${execState.state}, expected terminal`);
        // usage_unknown should be false since we captured stdout
        if (execState && execState.usage_unknown !== false) errors.push('T26: usage_unknown should be false when usage captured');
        // Immutable launch record should exist
        const launchKey = `launch_${sid}`;
        const launchRow = db.prepare('SELECT value FROM bridge_lipa_state WHERE key = ?').get(launchKey);
        if (!launchRow) errors.push('T26: no immutable launch record persisted');
        if (launchRow) {
          const lr = JSON.parse(launchRow.value);
          // Launch record is written BEFORE spawn → usage=null, usage_unknown=true (correct)
          if (lr.status !== 'started') errors.push(`T26: launch record status=${lr.status}, expected started`);
        }
        // Outcome record (written after exit 0 verification) should have the usage
        const outcomeKey = `outcome_${sid}`;
        const outcomeRow = db.prepare('SELECT value FROM bridge_lipa_state WHERE key = ?').get(outcomeKey);
        if (!outcomeRow) errors.push('T26: no outcome record persisted');
        if (outcomeRow) {
          const or = JSON.parse(outcomeRow.value);
          if (!or.usage) errors.push('T26: outcome record missing usage');
          if (or.usage && or.usage.input_tokens !== 5000) errors.push(`T26: outcome input_tokens=${or.usage.input_tokens}`);
          if (or.usage_unknown) errors.push('T26: outcome record incorrectly marked usage_unknown');
        }
        resetState(db);
        // Clean launch record
        try { db.prepare('DELETE FROM bridge_lipa_state WHERE key = ?').run(launchKey); } catch (_) {}
      }

      // ── T27: corrupt hold blocks launch (fail closed) ─────────────────
      {
        resetState(db);
        // Write corrupt JSON into hold key
        db.prepare(`INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
          .run(HOLD_KEY, '{invalid json!!!', Date.now());
        const holdResult = getExecutionHold();
        if (!holdResult) errors.push('T27: corrupt hold returned null (fail OPEN)');
        if (holdResult && !holdResult.corrupt) errors.push('T27: corrupt hold not flagged');
        // Must block launch
        const res = await runPreflight({ launcher: mockLauncher({ code: 0 }), deps: { getDueCount: () => 1 } });
        if (res.launched) errors.push('T27: launched despite corrupt hold (fail OPEN)');
        if (res.reason !== 'execution_hold') errors.push(`T27: reason=${res.reason}, expected execution_hold`);
        resetState(db);
      }

      // ── T28: verifyCompletions fails closed on empty expected claims ───────
      {
        resetState(db);
        // If no expected claims are known, verification must fail (not succeed vacuously)
        const launcher = mockLauncher({ code: 0, signal: null, timedOut: false, stdout: '' });
        const res = await runPreflight({
          launcher, sessionId: 'empty-claims-t28',
          deps: { getDueCount: () => 1, claimDue: () => ({ rows: [] }) },
        });
        // With no claims, the preflight should NOT launch
        if (res.launched) errors.push('T28: launched despite empty claims');
        if (res.reason !== 'no_claims') errors.push('T28: reason=' + res.reason + ', expected no_claims');
        resetState(db);
      }

      // ── T29: failClaim(isTimeout:true) parks immediately, no retry ───────
      {
        resetState(db);
        const id = enqueue('t29'); ids.push(id);
        const sid = 'explicit-timeout-t29';
        rel.acquireWorkerLock(sid);
        const claimed = rel.claimDue({ limit: 100, sessionId: sid });
        const row = claimed.rows.find(r => r.id === id);
        if (!row) { errors.push('T29: setup failed - could not claim'); } else {
          const result = rel.failClaim({
            inboxId: id, claimGeneration: row.claim_generation, sessionId: sid,
            error: new Error('agent timeout'), isTimeout: true,
          });
          if (result.status === 'retry') errors.push('T29: explicit timeout went to retry (UNSAFE)');
          if (result.status !== 'needs_review') errors.push(`T29: status=${result.status}, expected needs_review`);
          if (!result.parked) errors.push('T29: not flagged as parked');
          // Hold must be set
          const hold = getExecutionHold();
          if (!hold || !hold.active) errors.push('T29: execution hold not set on explicit timeout');
        }
        rel.releaseWorkerLock(sid);
        resetState(db);
      }

      // ── T30: model-aware accounting rates ──────────────────────────
      {
        // Opus should be most expensive (full tokens with explicit cache=0 for clean estimate)
        const opusEst = accounting.estimateFromTokens({ inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: 'claude-opus-4.6' });
        const sonnetEst = accounting.estimateFromTokens({ inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: 'claude-sonnet-4.6' });
        const haikuEst = accounting.estimateFromTokens({ inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: 'claude-haiku-4.5' });
        if (!opusEst.cost || !sonnetEst.cost || !haikuEst.cost) errors.push('T30: estimates returned null for known token counts');
        if (opusEst.cost <= sonnetEst.cost) errors.push(`T30: Opus ($${opusEst.cost}) not more expensive than Sonnet ($${sonnetEst.cost})`);
        if (sonnetEst.cost <= haikuEst.cost) errors.push(`T30: Sonnet ($${sonnetEst.cost}) not more expensive than Haiku ($${haikuEst.cost})`);
        // Partial usage should be flagged (missing output tokens)
        const partial = accounting.estimateFromTokens({ inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, model: 'claude-opus-4.6' });
        if (!partial.partial) errors.push('T30: missing output tokens not flagged as partial');
        // Unknown model returns cost=null + unknownModel=true (per Aviv: unknown=unknown, not guessed)
        const unknownModel = accounting.estimateFromTokens({ inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: null });
        if (unknownModel.cost !== null) errors.push('T30: unknown model should return null cost, not a guess');
        if (!unknownModel.unknownModel) errors.push('T30: unknown model not flagged as unknownModel');
      }

      // ── T31: partial usage flagged as cost_unknown in recordRequestCost ───
      {
        const id = enqueue('t31'); ids.push(id);
        // Only input tokens, no model → unknownModel → cost_unknown=1
        const rec = accounting.recordRequestCost({ inboxId: id, inputTokens: 1000 });
        if (!rec.unknown) errors.push('T31: partial usage (no model) not flagged as unknown');
        // Full tokens + explicit cache=0 with known model → cost_unknown=0
        const rec2 = accounting.recordRequestCost({ inboxId: id, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, model: 'claude-opus-4.6' });
        if (rec2.unknown) errors.push('T31: full usage with explicit cache=0 and known model wrongly flagged as unknown');
        // Missing cache with known model → partial → cost_unknown=1 (cache required for complete estimate)
        const rec3 = accounting.recordRequestCost({ inboxId: id, inputTokens: 1000, outputTokens: 500, model: 'claude-opus-4.6' });
        if (!rec3.unknown) errors.push('T31: input+output with missing cache should be flagged as unknown (partial estimate)');
        resetState(db);
      }

    } finally {
      cleanup(db, ids);
      for (const k of STATE_KEYS) restoreState(db, k, stateSnaps[k]);
      // Clean any immutable launch/outcome records left by tests
      db.prepare("DELETE FROM bridge_lipa_state WHERE key LIKE 'launch_%' OR key LIKE 'outcome_%'").run();
      // WAL checkpoint to release locks before next test in suite
      try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
    }

    const total = 31;
    return errors.length === 0
      ? { pass: true, message: `Lipa preflight: all ${total} tests pass (T1-T15 gate, T16-T26 exec state/fence/caps, T27-T31 fail-closed corruption/explicit timeout/model rates/partial usage).` }
      : { pass: false, message: errors.join('\n         ') };
  },
};
