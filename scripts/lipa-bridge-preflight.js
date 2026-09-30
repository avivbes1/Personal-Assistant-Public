#!/usr/bin/env node
'use strict';
/**
 * lipa-bridge-preflight.js — SYSTEM-CRON preflight wrapper for the Lipa Bridge.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * The OpenClaw cron (id 7d840526) fires an UNCONDITIONAL agent turn every 2
 * minutes and consumes one LLM turn (~17k tokens) even when the queue is empty —
 * OpenClaw cannot gate a turn on a shell command's output (see the header of
 * scripts/lipa-bridge-poll.js). This wrapper is meant to be called by SYSTEM cron
 * INSTEAD of the OpenClaw cron: it does all the cheap read-only checks in plain
 * Node FIRST and only spawns the (expensive) `openclaw agent` turn when there is
 * real, due, affordable work AND it holds the single global execution lock. An
 * empty/paused/capped/locked/held cycle costs a couple of SQLite reads and ZERO
 * LLM tokens.
 *
 * It is PURELY ADDITIVE: it reuses the SAME durable-worker primitives as the
 * in-turn scripts (src/bridge/lipaReliability.js — worker_lock, circuit,
 * getDueCount, reconcile, fencing) and the SAME advisory caps
 * (src/bridge/lipaAccounting.js). It does not modify poll.js / respond.js /
 * lipaReliability.js, and it does not install or change any crontab.
 *
 * ── Lock handoff ─────────────────────────────────────────────────────────────
 * The preflight acquires the global worker_lock BEFORE spawning, using a fresh
 * sessionId, and passes that sessionId to the CLI both as `--session-id` and via
 * OPENCLAW_SESSION_ID. Inside the turn, scripts/lipa-bridge-poll.js reads
 * OPENCLAW_SESSION_ID as its lock holder, so acquireWorkerLock() RENEWS the same
 * lock (holder match) rather than being refused, and scripts/lipa-bridge-respond.js
 * RELEASES it on clean completion. If the turn never lands, WORKER_LOCK_TTL_MS is
 * the safety net — the preflight NEVER releases the lock on a bad outcome.
 *
 * ── The critical safety property: a CLI timeout is NOT remote death ──────────
 * Killing the local `openclaw` process after a timeout does NOT prove the remote
 * agent stopped or that a side effect did not occur. So on timeout we:
 *   - set an EXECUTION HOLD flag (bridge_lipa_state key 'execution_hold'),
 *   - mark any rows this session had claimed as needs_review (bumping
 *     claim_generation so a late completion is FENCED by the existing mechanism),
 *   - do NOT release the global lock (let it expire naturally via TTL),
 *   - NEVER auto-retry.
 * While a hold is active the preflight exits 0 and launches nothing. The hold is
 * NEVER auto-cleared: a CLI timeout / non-zero exit does not prove the remote
 * agent stopped, and lock-TTL expiry proves only that the LOCAL lock lapsed, not
 * remote termination. It can be cleared ONLY by manual intervention
 * (`--clear-hold`), after a human has verified the remote agent's state.
 *
 * ── Public API (for tests via dependency injection) ──────────────────────────
 *   runPreflight({ launcher, now, sessionId, timeoutMs, deps }) -> Promise<result>
 *   setExecutionHold(reason, meta)  clearExecutionHold()  getExecutionHold()
 * `launcher` defaults to a child_process.spawn implementation; tests pass a mock
 * so no real CLI is ever spawned. `deps` lets a test override a single read-only
 * check (e.g. force getDueCount to throw) to prove read failures are side-effect
 * free.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { spawn } = require('child_process');
const { initDB, getDB } = require('../src/db');
const rel = require('../src/bridge/lipaReliability');
const accounting = require('../src/bridge/lipaAccounting');
const { ensureLipaTables } = require('../src/bridge/lipaLane');

// ── tunables ─────────────────────────────────────────────────────────────────
function intOr(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
const CLI_TIMEOUT_MS = intOr(process.env.LIPA_BRIDGE_CLI_TIMEOUT_MS, 10 * 60 * 1000); // 10 min
const HOLD_KEY = 'execution_hold';

// The message handed to the agent turn — same intent as the OpenClaw cron message
// currently used: run the due-time gate, then process + respond to any claimed row.
const CRON_MESSAGE = [
  'LIPA_BRIDGE cron: run `node scripts/lipa-bridge-poll.js` to claim the due Lipa request.',
  'If it prints LIPA_BRIDGE_WAKE + a pending_commands block, execute each command and reply with',
  "`node scripts/lipa-bridge-respond.js <inbox_id> <request_id> '<response_json>' <subject> <in_reply_to> '<options_json>'`,",
  'echoing claim_generation + session_id back in options_json (fencing). If nothing is due, stop.',
].join(' ');

function truncate(s, n = 300) { s = s == null ? '' : String(s); return s.slice(0, n); }

// ── execution-hold state (bridge_lipa_state key 'execution_hold') ─────────────
// Mirrors the getState/setState shape in lipaReliability.js (JSON value column).

function readState(key) {
  const row = getDB().prepare('SELECT value FROM bridge_lipa_state WHERE key = ?').get(key);
  if (!row || row.value == null) return null;
  try { return JSON.parse(row.value); } catch (_) { return null; }
}

/** The active execution hold, or null when none is set. */
function getExecutionHold() {
  const h = readState(HOLD_KEY);
  return h && h.active ? h : null;
}

/** Raise the execution hold. Idempotent; preserves the original `since`. */
function setExecutionHold(reason, meta = {}) {
  const now = Date.now();
  const prev = readState(HOLD_KEY);
  const value = {
    active: true,
    reason: truncate(reason),
    session_id: meta.session_id != null ? meta.session_id : (prev && prev.session_id) || null,
    claimed_ids: meta.claimed_ids != null ? meta.claimed_ids : (prev && prev.claimed_ids) || [],
    since: prev && prev.active && prev.since ? prev.since : now,
  };
  getDB().prepare(
    `INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(HOLD_KEY, JSON.stringify(value), now);
  console.error('[Lipa preflight] EXECUTION HOLD set:', truncate(reason, 200));
  return value;
}

/** Clear the execution hold. Returns the hold that was cleared (or null). */
function clearExecutionHold() {
  const prev = getExecutionHold();
  getDB().prepare('DELETE FROM bridge_lipa_state WHERE key = ?').run(HOLD_KEY);
  return prev;
}

// ── claimed-row containment on an ambiguous timeout ──────────────────────────

/**
 * Move every row this session had claimed to needs_review, bumping
 * claim_generation so the ORIGINAL worker's late completeClaim() is fenced by the
 * existing mechanism (a completion for a non-'claimed' row, or a stale generation,
 * is ignored). NOT a retry: a timed-out mutating turn may already have taken
 * effect, so it is parked for a human — never blind-retried. Returns the ids.
 */
function quarantineClaimedRows(sessionId, reason, now) {
  const db = getDB();
  const rows = db.prepare("SELECT id, claim_generation FROM bridge_lipa_inbox WHERE status='claimed' AND session_id = ?").all(sessionId);
  const ids = [];
  const tx = db.transaction(() => {
    for (const r of rows) {
      const gen = (r.claim_generation || 0) + 1;
      db.prepare(
        "UPDATE bridge_lipa_inbox SET status='needs_review', claim_generation=?, lease_expires_at=NULL, last_error=?, updated_at=? WHERE id=?"
      ).run(gen, truncate(reason), now, r.id);
      ids.push(r.id);
    }
  });
  tx();
  return ids;
}

// ── default launcher (real child_process.spawn) ──────────────────────────────

/**
 * Spawn the OpenClaw agent turn with an ARGUMENT ARRAY (never shell-interpolated).
 * Resolves { code, signal, timedOut }; rejects on a spawn error. On timeout it
 * SIGTERMs the child and resolves { timedOut: true } — but killing the local CLI
 * is NOT proof the remote agent stopped (the caller treats it as ambiguous).
 */
function defaultLauncher({ command, args, timeoutMs, sessionId }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, OPENCLAW_SESSION_ID: sessionId },
      });
    } catch (e) { return reject(e); }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch (_) {}
      resolve({ code: null, signal: 'SIGTERM', timedOut: true });
    }, timeoutMs);

    child.on('error', (err) => { if (settled) return; settled = true; clearTimeout(timer); reject(err); });
    child.on('exit', (code, signal) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, signal, timedOut: false }); });
  });
}

// ── the preflight itself ─────────────────────────────────────────────────────

/**
 * Run one preflight cycle. Resolves a result object describing the outcome; it
 * NEVER throws for an expected no-launch condition. `launched` is true only when
 * the launcher was actually invoked.
 *
 * Read-only checks run FIRST and acquire nothing, so a read failure is entirely
 * side-effect free (no lock, no hold). The global lock is the LAST gate before a
 * launch, so it is only ever held when we are truly about to spend an LLM turn.
 */
async function runPreflight({ launcher = defaultLauncher, now = Date.now(), sessionId, timeoutMs = CLI_TIMEOUT_MS, deps = {} } = {}) {
  initDB();
  ensureLipaTables();

  const isPaused = deps.isPaused || rel.isPaused;
  const getDueCount = deps.getDueCount || rel.getDueCount;
  const checkDailyCap = deps.checkDailyCap || accounting.checkDailyCap;
  const acquireWorkerLock = deps.acquireWorkerLock || rel.acquireWorkerLock;
  const sid = sessionId || `preflight-${process.pid}-${now}`;

  // ── read-only pre-checks (no side effects on failure) ──────────────────────
  try {
    // (e) Execution hold — a prior ambiguous timeout is still in effect. This is
    // NEVER auto-cleared: a CLI timeout / non-zero exit does NOT prove the remote
    // agent stopped or that no side effect occurred, and TTL expiry proves only
    // that the LOCAL lock lapsed, not remote termination. The hold blocks every
    // new launch until a human verifies remote state and clears it via
    // `--clear-hold`.
    const hold = getExecutionHold();
    if (hold) return { launched: false, reason: 'execution_hold', hold };

    // (a) Billing circuit breaker.
    if (isPaused()) return { launched: false, reason: 'circuit_open' };

    // (b) Due work must exist.
    if (getDueCount(now) === 0) return { launched: false, reason: 'no_due_work' };

    // (c) Advisory daily cost cap.
    const cap = checkDailyCap(now);
    if (cap.blocked) return { launched: false, reason: 'daily_cap', spend: cap.spend, cap: cap.cap };
  } catch (e) {
    // A safe, terminal read failure: launch nothing, set no hold, hold no lock.
    console.error('[Lipa preflight] read-only pre-check failed (no launch, no side effect):', e.message);
    return { launched: false, reason: 'preflight_read_error', error: e.message };
  }

  // (d) Single global execution lock — LAST gate, the only pre-launch side effect.
  if (!acquireWorkerLock(sid)) return { launched: false, reason: 'lock_held' };

  // ── launch ─────────────────────────────────────────────────────────────────
  const args = ['agent', '-m', CRON_MESSAGE, '--agent', 'personal', '--session-id', sid, '--json'];
  let result;
  try {
    result = await launcher({ command: 'openclaw', args, timeoutMs, sessionId: sid });
  } catch (spawnErr) {
    // (5/T9) Launch failed to start: we cannot know if anything ran → hold; do NOT
    // release the lock (respond.js may or may not run; TTL is the safety net).
    setExecutionHold(`spawn failed: ${spawnErr.message}`, { session_id: sid });
    return { launched: true, reason: 'spawn_error', error: spawnErr.message, holdSet: true };
  }

  const doneAt = Date.now();

  if (result && result.timedOut) {
    // (4/T10) Ambiguous timeout: quarantine claimed rows (fenced via generation),
    // raise the hold, and DO NOT release the lock — TTL is the only safe release.
    const claimedIds = quarantineClaimedRows(sid, 'CLI timeout — remote status unknown, side effect uncertain', doneAt);
    setExecutionHold('CLI timeout — remote agent status unknown', { session_id: sid, claimed_ids: claimedIds });
    console.error(`[Lipa preflight] CLI TIMEOUT — ${claimedIds.length} claimed row(s) → needs_review; lock left to expire via TTL`);
    return { launched: true, reason: 'timeout', holdSet: true, claimedIds };
  }

  if (result && result.code === 0) {
    // (5/T14) Clean exit: respond.js already completed the row AND released the
    // lock. The preflight releases NOTHING and sets no hold.
    console.log('[Lipa preflight] agent turn exited 0 (respond.js handled completion + lock release)');
    return { launched: true, reason: 'clean_exit', exitCode: 0 };
  }

  // (5) Non-zero / unknown exit: a failure with an ambiguous completion state. Log,
  // set a hold, and leave the lock for the TTL — respond.js may not have run.
  const code = result ? result.code : null;
  setExecutionHold(`agent turn exited non-zero (code=${code}) — completion uncertain`, { session_id: sid });
  console.error(`[Lipa preflight] agent turn exit code=${code} — hold set, lock left to expire via TTL`);
  return { launched: true, reason: 'nonzero_exit', exitCode: code, holdSet: true };
}

module.exports = { runPreflight, setExecutionHold, clearExecutionHold, getExecutionHold };

// ── CLI entrypoint ───────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  initDB();
  ensureLipaTables();

  if (argv.includes('--clear-hold')) {
    const cleared = clearExecutionHold();
    console.log(cleared
      ? `[Lipa preflight] execution hold cleared (was: ${truncate(cleared.reason, 120)})`
      : '[Lipa preflight] no execution hold was set');
    process.exit(0);
  }

  runPreflight()
    .then((res) => {
      if (!res.launched) console.log(`[Lipa preflight] no launch — ${res.reason}`);
      // The wrapper always exits 0: it is a cron gate, and its own exit code is not
      // consumed downstream. Never a dry-run with reversed exit codes.
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Lipa preflight] unexpected error (no launch):', err.message);
      process.exit(0);
    });
}
