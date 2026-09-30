'use strict';
/**
 * lipa-preflight.test.js — system-cron preflight wrapper for the Lipa Bridge.
 *
 * Tests the full preflight gate logic via dependency injection (mock launcher,
 * injected deps). No real CLI is ever spawned.
 *
 * T1   empty queue → no launch (getDueCount returns 0)
 * T2   daily cap hit → no launch
 * T3   circuit open (billing breaker) → no launch
 * T4   lock already held → no launch
 * T5   execution hold active → no launch, hold NOT auto-cleared even if lock
 *      expired + no claimed rows (the critical safety property)
 * T6   two concurrent wrappers → only one launches (lock prevents second)
 * T7   new arrival while hold active → still blocked until manual clear
 * T8   launch fails (spawn error) → hold set, no lock release
 * T9   CLI timeout → claimed rows quarantined to needs_review, hold set, lock
 *      NOT released, claim_generation bumped to fence late completion
 * T10  restart with unknown remote → hold blocks new launch
 * T11  late completion after timeout → fenced by claim_generation bump
 * T12  read-only pre-check failure → safe exit, no side effects, no hold
 * T13  clean exit (code 0) → no hold set
 * T14  non-zero exit → hold set
 * T15  --clear-hold works correctly
 *
 * Harness: module.exports = { async run() } matching lipa-worker.test.js.
 */

const { initDB, getDB } = require('../../src/db');
const { ensureLipaTables } = require('../../src/bridge/lipaLane');
const rel = require('../../src/bridge/lipaReliability');
const { runPreflight, setExecutionHold, clearExecutionHold, getExecutionHold } = require('../../scripts/lipa-bridge-preflight');

const PREFIX = 'TEST_LIPA_PF_';
const HOLD_KEY = 'execution_hold';
const LOCK_KEY = 'worker_lock';

function snapshotState(db, key) {
  const r = db.prepare('SELECT value, updated_at FROM bridge_lipa_state WHERE key = ?').get(key);
  return r || null;
}
function restoreState(db, key, snap) {
  db.prepare('DELETE FROM bridge_lipa_state WHERE key = ?').run(key);
  if (snap) db.prepare('INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES (?, ?, ?)').run(key, snap.value, snap.updated_at);
}
function cleanup(db, ids) {
  if (ids.length) {
    const list = ids.join(',');
    db.prepare(`DELETE FROM bridge_lipa_costs WHERE inbox_id IN (${list})`).run();
    db.prepare(`DELETE FROM bridge_lipa_outbox WHERE inbox_id IN (${list})`).run();
    db.prepare(`DELETE FROM bridge_lipa_attempts WHERE inbox_id IN (${list})`).run();
    db.prepare(`DELETE FROM bridge_lipa_inbox WHERE id IN (${list})`).run();
  }
  db.prepare(`DELETE FROM bridge_lipa_inbox WHERE request_id LIKE '${PREFIX}%'`).run();
}
function enqueue(tag) {
  const res = rel.enqueueGuarded({ requestId: PREFIX + tag, command: 'noop', args: { tag } });
  return res.id;
}

/**
 * Force ONE specific row into 'claimed' for a session via direct SQL. Deliberately
 * NOT rel.claimDue(), which claims the oldest due row(s) GLOBALLY and on the shared
 * live DB would grab a real production row instead of (or before) the test's own.
 * Returns the claim_generation stamped, so callers can assert the later fence bump.
 */
function forceClaim(db, id, sessionId) {
  const now = Date.now();
  db.prepare("UPDATE bridge_lipa_inbox SET status='claimed', session_id=?, claim_generation=COALESCE(claim_generation,0)+1, lease_expires_at=?, updated_at=? WHERE id=?")
    .run(sessionId, now + rel.LEASE_MS, now, id);
  return db.prepare('SELECT claim_generation FROM bridge_lipa_inbox WHERE id=?').get(id).claim_generation;
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
    const holdSnap = snapshotState(db, HOLD_KEY);
    const lockSnap = snapshotState(db, LOCK_KEY);
    const circuitSnap = snapshotState(db, 'circuit');
    // Clean slate
    db.prepare("DELETE FROM bridge_lipa_state WHERE key IN ('execution_hold','worker_lock','circuit')").run();

    try {
      // ── T1: empty queue → no launch ──────────────────────────────────────────
      {
        const launcher = mockLauncher({ code: 0, signal: null, timedOut: false });
        const res = await runPreflight({
          launcher,
          deps: { getDueCount: () => 0 },
        });
        if (res.launched) errors.push('T1: launched on empty queue');
        if (res.reason !== 'no_due_work') errors.push(`T1: reason=${res.reason}, expected no_due_work`);
        if (launcher.calls() !== 0) errors.push('T1: launcher was called on empty queue');
      }

      // ── T2: daily cap hit → no launch ────────────────────────────────────────
      {
        const launcher = mockLauncher({ code: 0, signal: null, timedOut: false });
        const res = await runPreflight({
          launcher,
          deps: {
            getDueCount: () => 3,
            checkDailyCap: () => ({ blocked: true, spend: 25, cap: 20 }),
          },
        });
        if (res.launched) errors.push('T2: launched despite daily cap');
        if (res.reason !== 'daily_cap') errors.push(`T2: reason=${res.reason}, expected daily_cap`);
        if (launcher.calls() !== 0) errors.push('T2: launcher was called despite daily cap');
      }

      // ── T3: circuit open (billing breaker) → no launch ───────────────────────
      {
        const launcher = mockLauncher({ code: 0, signal: null, timedOut: false });
        const res = await runPreflight({
          launcher,
          deps: {
            isPaused: () => true,
            getDueCount: () => 5,
          },
        });
        if (res.launched) errors.push('T3: launched with circuit open');
        if (res.reason !== 'circuit_open') errors.push(`T3: reason=${res.reason}, expected circuit_open`);
        if (launcher.calls() !== 0) errors.push('T3: launcher was called with circuit open');
      }

      // ── T4: lock already held → no launch ────────────────────────────────────
      {
        // Acquire lock as another holder
        rel.acquireWorkerLock('other-session-t4');
        const launcher = mockLauncher({ code: 0, signal: null, timedOut: false });
        const res = await runPreflight({
          launcher,
          deps: { getDueCount: () => 1 },
        });
        if (res.launched) errors.push('T4: launched with lock held by another');
        if (res.reason !== 'lock_held') errors.push(`T4: reason=${res.reason}, expected lock_held`);
        if (launcher.calls() !== 0) errors.push('T4: launcher was called with lock held');
        rel.releaseWorkerLock('other-session-t4');
      }

      // ── T5: execution hold → no launch, NEVER auto-cleared ───────────────────
      // This is the critical safety property: even when the lock has expired AND
      // there are no claimed rows, the hold MUST NOT be cleared automatically.
      {
        // Set a hold with an expired lock and no claimed rows — conditions that the
        // old (unsafe) canAutoClearHold would have cleared.
        const holdVal = {
          active: true,
          reason: 'T5 test hold',
          session_id: 'dead-session-t5',
          claimed_ids: [],
          since: Date.now() - 600000,
        };
        db.prepare(
          `INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        ).run(HOLD_KEY, JSON.stringify(holdVal), Date.now());
        // Set an EXPIRED lock — TTL lapsed
        const expiredLock = { holder: 'dead-session-t5', acquired_at: Date.now() - 600000, expires_at: Date.now() - 300000 };
        db.prepare(
          `INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        ).run(LOCK_KEY, JSON.stringify(expiredLock), Date.now());

        const launcher = mockLauncher({ code: 0, signal: null, timedOut: false });
        const res = await runPreflight({
          launcher,
          deps: { getDueCount: () => 5 },
        });
        if (res.launched) errors.push('T5: launched with execution hold active');
        if (res.reason !== 'execution_hold') errors.push(`T5: reason=${res.reason}, expected execution_hold`);
        if (launcher.calls() !== 0) errors.push('T5: launcher was called with hold active');
        // The hold must still be active — NOT auto-cleared
        const holdAfter = getExecutionHold();
        if (!holdAfter) errors.push('T5: hold was auto-cleared (UNSAFE — TTL expiry is not remote death)');
        if (!holdAfter || !holdAfter.active) errors.push('T5: hold is not active after preflight returned');

        // Clean up
        db.prepare("DELETE FROM bridge_lipa_state WHERE key IN ('execution_hold','worker_lock')").run();
      }

      // ── T6: two concurrent wrappers → only one launches ──────────────────────
      {
        // Pre-acquire the lock as wrapper-1 to simulate it being mid-turn
        rel.acquireWorkerLock('wrapper-1-t6');
        const launcher2 = mockLauncher({ code: 0, signal: null, timedOut: false });
        // Second wrapper tries while first holds the lock
        const res2 = await runPreflight({
          launcher: launcher2,
          sessionId: 'wrapper-2-t6',
          deps: { getDueCount: () => 2 },
        });
        if (res2.launched) errors.push('T6: second wrapper launched despite lock held by first');
        if (res2.reason !== 'lock_held') errors.push(`T6: second wrapper reason=${res2.reason}, expected lock_held`);
        if (launcher2.calls() !== 0) errors.push('T6: second launcher was called despite lock held');
        rel.releaseWorkerLock('wrapper-1-t6');
        db.prepare("DELETE FROM bridge_lipa_state WHERE key IN ('execution_hold','worker_lock')").run();
      }

      // ── T7: new arrival while hold active → still blocked ────────────────────
      {
        setExecutionHold('T7 prior timeout', { session_id: 'old-t7' });
        // New work arrives
        const newId = enqueue('t7-new'); ids.push(newId);
        const launcher = mockLauncher({ code: 0, signal: null, timedOut: false });
        const res = await runPreflight({
          launcher,
          // getDueCount would return >0 if reached, but hold blocks first
        });
        if (res.launched) errors.push('T7: launched despite hold (new arrival should not override hold)');
        if (res.reason !== 'execution_hold') errors.push(`T7: reason=${res.reason}, expected execution_hold`);
        clearExecutionHold();
      }

      // ── T8: launch fails (spawn error) → hold set, no lock release ──────────
      {
        // Ensure no stale lock from prior tests
        db.prepare("DELETE FROM bridge_lipa_state WHERE key='worker_lock'").run();
        const spawnErr = new Error('ENOENT: openclaw not found');
        const launcher = mockLauncher(spawnErr);
        const res = await runPreflight({
          launcher,
          sessionId: 'spawn-fail-t8',
          deps: { getDueCount: () => 1 },
        });
        if (!res.launched) errors.push('T8: not marked as launched (spawn was attempted)');
        if (res.reason !== 'spawn_error') errors.push(`T8: reason=${res.reason}, expected spawn_error`);
        if (!res.holdSet) errors.push('T8: hold was not set on spawn failure');
        const hold = getExecutionHold();
        if (!hold || !hold.active) errors.push('T8: execution hold not active after spawn failure');
        // Lock should NOT be released (we don't know if anything ran)
        const lock = JSON.parse((db.prepare("SELECT value FROM bridge_lipa_state WHERE key='worker_lock'").get() || {}).value || 'null');
        if (!lock) errors.push('T8: lock was released after spawn failure (should be left for TTL)');
        clearExecutionHold();
        db.prepare("DELETE FROM bridge_lipa_state WHERE key='worker_lock'").run();
      }

      // ── T9: CLI timeout → quarantine, hold, lock NOT released, gen bumped ────
      {
        // Ensure clean state
        db.prepare("DELETE FROM bridge_lipa_state WHERE key IN ('worker_lock','execution_hold')").run();
        // Create a due row and pre-claim it with the SAME sessionId the preflight
        // will use, simulating what poll.js does inside the agent turn.
        const id = enqueue('t9'); ids.push(id);
        const sid = 'timeout-sess-t9';
        // Force THIS row into 'claimed' under the SAME sessionId the preflight will
        // use (what poll.js does inside the turn) — direct SQL so we never claim any
        // OTHER due row on the shared live DB. The lock stays free for runPreflight.
        const genBefore = forceClaim(db, id, sid);

        const launcher = mockLauncher({ code: null, signal: 'SIGTERM', timedOut: true });
        const res = await runPreflight({
          launcher,
          sessionId: sid,
          deps: { getDueCount: () => 1 },
        });
        if (!res.launched) errors.push('T9: not marked as launched');
        if (res.reason !== 'timeout') errors.push(`T9: reason=${res.reason}, expected timeout`);
        if (!res.holdSet) errors.push('T9: hold was not set on timeout');

        // Claimed rows should be quarantined to needs_review
        const row = db.prepare('SELECT status, claim_generation FROM bridge_lipa_inbox WHERE id = ?').get(id);
        if (row && row.status !== 'needs_review') errors.push(`T9: row status=${row.status}, expected needs_review`);
        // claim_generation must be bumped to fence late completion
        if (row && row.claim_generation <= genBefore) errors.push('T9: claim_generation not bumped (late completion not fenced)');

        // Lock must NOT be released
        const lock = JSON.parse((db.prepare("SELECT value FROM bridge_lipa_state WHERE key='worker_lock'").get() || {}).value || 'null');
        if (!lock) errors.push('T9: lock was released after timeout (UNSAFE — remote may still be running)');

        clearExecutionHold();
        db.prepare("DELETE FROM bridge_lipa_state WHERE key='worker_lock'").run();
      }

      // ── T10: restart with unknown remote → hold blocks new launch ────────────
      {
        // Simulate: a previous run timed out, set a hold, and now the preflight
        // restarts (e.g., next cron cycle). The hold should block.
        setExecutionHold('previous timeout — remote unknown', { session_id: 'ghost-t10' });
        const launcher = mockLauncher({ code: 0, signal: null, timedOut: false });
        const res = await runPreflight({
          launcher,
          deps: { getDueCount: () => 3 },
        });
        if (res.launched) errors.push('T10: launched after restart with unknown remote (hold should block)');
        if (res.reason !== 'execution_hold') errors.push(`T10: reason=${res.reason}, expected execution_hold`);
        clearExecutionHold();
      }

      // ── T11: late completion after timeout → fenced by gen bump ──────────────
      {
        const id = enqueue('t11'); ids.push(id);
        // Claim THIS row via direct SQL (not rel.claimDue, which would claim other
        // due rows on the shared DB). Its stamped generation is the "original" one.
        const gen1 = forceClaim(db, id, 'late-sess-t11');

        // Simulate timeout: quarantine bumps generation
        const now = Date.now();
        db.prepare('UPDATE bridge_lipa_inbox SET lease_expires_at = ? WHERE id = ?').run(now - 1000, id);
        rel.reconcileStaleClaims({ now });
        const afterReconcile = db.prepare('SELECT claim_generation FROM bridge_lipa_inbox WHERE id = ?').get(id);
        const gen2 = afterReconcile ? afterReconcile.claim_generation : gen1 + 1;

        // The late completion from the original session arrives with gen1
        const completeResult = rel.completeClaim({
          inboxId: id,
          claimGeneration: gen1,
          sessionId: 'late-sess-t11',
          response: { ok: true },
        });
        if (!completeResult.fenced) errors.push('T11: late completion was NOT fenced after gen bump');
        // No outbox row should exist
        const outbox = db.prepare('SELECT COUNT(*) c FROM bridge_lipa_outbox WHERE inbox_id = ?').get(id);
        if (outbox.c !== 0) errors.push('T11: fenced late completion created an outbox row');
      }

      // ── T12: read-only pre-check failure → no side effects ───────────────────
      {
        const launcher = mockLauncher({ code: 0, signal: null, timedOut: false });
        const res = await runPreflight({
          launcher,
          deps: {
            getDueCount: () => { throw new Error('DB read failed'); },
          },
        });
        if (res.launched) errors.push('T12: launched despite read error');
        if (res.reason !== 'preflight_read_error') errors.push(`T12: reason=${res.reason}, expected preflight_read_error`);
        if (launcher.calls() !== 0) errors.push('T12: launcher called despite read failure');
        // No hold should be set (read failures are side-effect free)
        const hold = getExecutionHold();
        if (hold && hold.active) errors.push('T12: read failure set an execution hold (must be side-effect free)');
        // No lock should be held
        const lock = db.prepare("SELECT value FROM bridge_lipa_state WHERE key='worker_lock'").get();
        if (lock) errors.push('T12: read failure acquired a worker lock');
      }

      // ── T13: clean exit (code 0) → no hold set ──────────────────────────────
      {
        const launcher = mockLauncher({ code: 0, signal: null, timedOut: false });
        const res = await runPreflight({
          launcher,
          sessionId: 'clean-t13',
          deps: { getDueCount: () => 1 },
        });
        if (!res.launched) errors.push('T13: did not launch');
        if (res.reason !== 'clean_exit') errors.push(`T13: reason=${res.reason}, expected clean_exit`);
        const hold = getExecutionHold();
        if (hold && hold.active) errors.push('T13: hold was set on clean exit (should not be)');
        db.prepare("DELETE FROM bridge_lipa_state WHERE key='worker_lock'").run();
      }

      // ── T14: non-zero exit → hold set ────────────────────────────────────────
      {
        const launcher = mockLauncher({ code: 1, signal: null, timedOut: false });
        const res = await runPreflight({
          launcher,
          sessionId: 'nonzero-t14',
          deps: { getDueCount: () => 1 },
        });
        if (!res.launched) errors.push('T14: did not launch');
        if (res.reason !== 'nonzero_exit') errors.push(`T14: reason=${res.reason}, expected nonzero_exit`);
        if (!res.holdSet) errors.push('T14: hold was not set on non-zero exit');
        const hold = getExecutionHold();
        if (!hold || !hold.active) errors.push('T14: execution hold not active after non-zero exit');
        clearExecutionHold();
        db.prepare("DELETE FROM bridge_lipa_state WHERE key='worker_lock'").run();
      }

      // ── T15: --clear-hold works correctly ────────────────────────────────────
      {
        // Set a hold
        const original = setExecutionHold('T15 timeout', { session_id: 'held-t15', claimed_ids: [999] });
        // Verify it's active
        const before = getExecutionHold();
        if (!before || !before.active) errors.push('T15: hold was not set');
        // Clear it
        const cleared = clearExecutionHold();
        if (!cleared) errors.push('T15: clearExecutionHold returned null');
        if (cleared && cleared.reason !== 'T15 timeout') errors.push('T15: cleared hold did not return the original');
        // Verify it's gone
        const after = getExecutionHold();
        if (after) errors.push('T15: hold still active after clear');
        // Clearing a non-existent hold returns null
        const noop = clearExecutionHold();
        if (noop !== null) errors.push('T15: clearing empty hold did not return null');
      }

    } finally {
      cleanup(db, ids);
      restoreState(db, HOLD_KEY, holdSnap);
      restoreState(db, LOCK_KEY, lockSnap);
      restoreState(db, 'circuit', circuitSnap);
    }

    return errors.length === 0
      ? { pass: true, message: 'Lipa preflight: all 15 tests pass (empty queue, caps, circuit, lock, hold-never-auto-cleared, concurrent wrappers, new arrival blocked, spawn error, timeout quarantine+fence, restart blocked, late completion fenced, read-only safe, clean exit, nonzero exit, clear-hold).' }
      : { pass: false, message: errors.join('\n         ') };
  },
};
