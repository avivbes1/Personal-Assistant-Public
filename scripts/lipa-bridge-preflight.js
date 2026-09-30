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
 * lock (holder match) rather than being refused.
 *
 * IMPORTANT: respond.js no longer releases the lock. The preflight wrapper OWNS
 * lock release. After a clean exit (code 0) the preflight reads back DB state to
 * verify every claimed row is in a terminal state; only then does it release the
 * lock. On any non-terminal outcome (timeout, bad exit, spawn error, or exit 0
 * with uncompleted rows) the preflight sets an execution hold instead and leaves
 * the lock for TTL.
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
 * ── Execution state tracking ─────────────────────────────────────────────────
 * The preflight persists an execution state (bridge_lipa_state key
 * 'execution_state') BEFORE spawn with { state:'active', session_id, started_at }.
 * On verified clean completion the state transitions to 'terminal'. On ambiguous
 * outcomes (timeout, bad exit, missing completions) it goes to 'unknown'. New
 * wrapper cycles are blocked when execution_state is 'active' or 'unknown' — not
 * just when a hold is set — so the block survives lock TTL expiry.
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
const EXEC_STATE_KEY = 'execution_state';

// The message handed to the agent turn — same intent as the OpenClaw cron message
// currently used: run the due-time gate, then process + respond to any claimed row.
const CRON_MESSAGE = [
  'LIPA_BRIDGE cron: run `node scripts/lipa-bridge-poll.js` to claim the due Lipa request.',
  'If it prints LIPA_BRIDGE_WAKE + a pending_commands block, execute each command and reply with',
  "`node scripts/lipa-bridge-respond.js <inbox_id> <request_id> '<response_json>' <subject> <in_reply_to> '<options_json>'`,",
  'echoing claim_generation + session_id back in options_json (fencing). If nothing is due, stop.',
].join(' ');

function truncate(s, n = 300) { s = s == null ? '' : String(s); return s.slice(0, n); }

// ── Re-export execution hold from lipaReliability (canonical source) ──────────
// Execution hold management lives in lipaReliability.js so that reconcileStaleClaims
// can set holds without a circular require. Preflight re-exports for backward compat.
const { getExecutionHold, setExecutionHold, clearExecutionHold } = rel;

// ── Execution state (active/unknown/terminal) ─────────────────────────────────

/**
 * Read a state key with corruption detection. Returns { exists, value, corrupt }.
 */
function readStateEx(key) {
  const row = getDB().prepare('SELECT value FROM bridge_lipa_state WHERE key = ?').get(key);
  if (!row || row.value == null) return { exists: false, value: null, corrupt: false };
  try { return { exists: true, value: JSON.parse(row.value), corrupt: false }; }
  catch (_) { return { exists: true, value: null, corrupt: true }; }
}

function writeState(key, value) {
  const now = Date.now();
  getDB().prepare(
    `INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), now);
}

/**
 * Current execution state. Fails CLOSED: if the key exists but is corrupt,
 * returns a synthetic { state: 'unknown', corrupt: true } so launches are blocked.
 */
function getExecutionState() {
  const r = readStateEx(EXEC_STATE_KEY);
  if (!r.exists) return null;
  if (r.corrupt) {
    console.error('[Lipa preflight] execution_state key is corrupt — fail closed (blocking)');
    return { state: 'unknown', corrupt: true, reason: 'corrupt_execution_state' };
  }
  return r.value && typeof r.value === 'object' ? r.value : null;
}

function setExecutionState(obj) {
  writeState(EXEC_STATE_KEY, obj);
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

/**
 * Verify that all EXPECTED rows for this session are in a durable terminal state.
 * expectedClaimIds (persisted before launch) is the authoritative list — if empty
 * or missing, verification FAILS CLOSED (we can't prove completion without knowing
 * what was expected). A row is verified if:
 *   - status = 'done' AND a bridge_lipa_outbox row exists for it, OR
 *   - status = 'needs_review' (explicitly parked for human review), OR
 *   - status = 'dead' (exhausted)
 * Pending, retry, claimed, unknown statuses, wrong session, or missing rows = unverified.
 */
function verifyCompletions(sessionId, expectedClaimIds) {
  const db = getDB();

  // Fail closed: if we don't know what was expected, we can't verify
  if (!expectedClaimIds || !Array.isArray(expectedClaimIds) || expectedClaimIds.length === 0) {
    return { verified: false, reason: 'no_expected_claims', unverifiedIds: [] };
  }

  const unverifiedIds = [];
  for (const id of expectedClaimIds) {
    const row = db.prepare('SELECT id, status, session_id FROM bridge_lipa_inbox WHERE id = ?').get(id);
    if (!row) {
      unverifiedIds.push(id); // row disappeared — unverifiable
      continue;
    }
    // Session must match
    if (row.session_id !== sessionId) {
      unverifiedIds.push(id); // wrong session owns it now
      continue;
    }
    if (row.status === 'done') {
      const outbox = db.prepare('SELECT id FROM bridge_lipa_outbox WHERE inbox_id = ?').get(id);
      if (!outbox) unverifiedIds.push(id); // done but no outbox = suspicious
    } else if (row.status === 'needs_review' || row.status === 'dead') {
      // Acceptable terminal states
    } else {
      // claimed, pending, retry, or anything else = not terminal
      unverifiedIds.push(id);
    }
  }

  return unverifiedIds.length === 0
    ? { verified: true }
    : { verified: false, unverifiedIds };
}

// ── default launcher (real child_process.spawn) ──────────────────────────────

/**
 * Spawn the OpenClaw agent turn with an ARGUMENT ARRAY (never shell-interpolated).
 * Resolves { code, signal, timedOut, stdout }; rejects on a spawn error. On timeout
 * it SIGTERMs the child and resolves { timedOut: true } — but killing the local CLI
 * is NOT proof the remote agent stopped (the caller treats it as ambiguous).
 * Captures stdout for usage extraction.
 */
function defaultLauncher({ command, args, timeoutMs, sessionId }) {
  return new Promise((resolve, reject) => {
    let child;
    const stdoutChunks = [];
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: { ...process.env, OPENCLAW_SESSION_ID: sessionId },
      });
    } catch (e) { return reject(e); }

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch (_) {}
      resolve({ code: null, signal: 'SIGTERM', timedOut: true, stdout: Buffer.concat(stdoutChunks).toString() });
    }, timeoutMs);

    child.on('error', (err) => { if (settled) return; settled = true; clearTimeout(timer); reject(err); });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, timedOut: false, stdout: Buffer.concat(stdoutChunks).toString() });
    });
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

    // (e2) Execution state — also blocks when state is 'active' or 'unknown',
    // even after the lock TTL would have expired, so a new wrapper cycle cannot
    // sneak in while a remote agent is still running.
    const execState = getExecutionState();
    if (execState && (execState.state === 'active' || execState.state === 'unknown')) {
      return { launched: false, reason: 'execution_state_active', execState };
    }

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

  // ── claim expected IDs + persist execution state BEFORE spawn ─────────────
  const startedAt = Date.now();
  const getExpectedClaimIds = deps.getExpectedClaimIds || (() => {
    try {
      const dueRows = getDB().prepare(
        "SELECT id FROM bridge_lipa_inbox WHERE status IN ('pending','retry') AND available_at <= ? ORDER BY created_at ASC, id ASC LIMIT 1"
      ).all(startedAt);
      return dueRows.map(r => r.id);
    } catch (_) { return []; }
  });
  let expectedClaimIds = getExpectedClaimIds();

  setExecutionState({
    state: 'active',
    session_id: sid,
    started_at: startedAt,
    expected_claim_ids: expectedClaimIds,
  });

  // ── launch ─────────────────────────────────────────────────────────────────
  const args = ['agent', '-m', CRON_MESSAGE, '--agent', 'personal', '--session-id', sid, '--json'];
  let result;
  try {
    result = await launcher({ command: 'openclaw', args, timeoutMs, sessionId: sid });
  } catch (spawnErr) {
    // (5/T9) Launch failed to start: we cannot know if anything ran → hold; do NOT
    // release the lock (respond.js may or may not run; TTL is the safety net).
    setExecutionState({ state: 'unknown', session_id: sid, started_at: startedAt, finished_at: Date.now(), reason: `spawn_error: ${spawnErr.message}` });
    setExecutionHold(`spawn failed: ${spawnErr.message}`, { session_id: sid });
    return { launched: true, reason: 'spawn_error', error: spawnErr.message, holdSet: true };
  }

  const doneAt = Date.now();

  // Extract usage from stdout if available
  let usage = null;
  try {
    if (result && result.stdout) {
      const match = result.stdout.match(/\{[\s\S]*"usage"[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        usage = parsed.usage || null;
      }
    }
  } catch (_) {}

  if (result && result.timedOut) {
    // (4/T10) Ambiguous timeout: quarantine claimed rows (fenced via generation),
    // raise the hold, and DO NOT release the lock — TTL is the only safe release.
    const claimedIds = quarantineClaimedRows(sid, 'CLI timeout — remote status unknown, side effect uncertain', doneAt);
    setExecutionState({ state: 'unknown', session_id: sid, started_at: startedAt, finished_at: doneAt, reason: 'timeout', claimed_ids: claimedIds });
    setExecutionHold('CLI timeout — remote agent status unknown', { session_id: sid, claimed_ids: claimedIds });
    console.error(`[Lipa preflight] CLI TIMEOUT — ${claimedIds.length} claimed row(s) → needs_review; lock left to expire via TTL`);
    return { launched: true, reason: 'timeout', holdSet: true, claimedIds };
  }

  if (result && result.code === 0) {
    // (5) Exit 0 — verify DB state before releasing the lock.
    // For each row claimed by this session: it must be done (with outbox row),
    // needs_review, or dead. If any row is still 'claimed', respond.js didn't run.
    const execStatePre = getExecutionState();
    const claimIds = (execStatePre && Array.isArray(execStatePre.expected_claim_ids))
      ? execStatePre.expected_claim_ids : expectedClaimIds;
    const verification = verifyCompletions(sid, claimIds);
    if (!verification.verified) {
      const unverifiedIds = verification.unverifiedIds || [];
      quarantineClaimedRows(sid, 'exit 0 but respond.js did not complete all claimed rows', doneAt);
      setExecutionState({ state: 'unknown', session_id: sid, started_at: startedAt, finished_at: doneAt, reason: verification.reason || 'exit_0_verify_failed', unverified_ids: unverifiedIds, exit_code: 0, usage_unknown: !usage });
      setExecutionHold('exit 0 but respond.js did not complete all claimed rows', { session_id: sid, claimed_ids: unverifiedIds });
      console.error(`[Lipa preflight] exit 0 verification FAILED — ${unverifiedIds.length} row(s) uncompleted; hold set`);
      return { launched: true, reason: 'clean_exit_verification_failed', exitCode: 0, holdSet: true, unverifiedIds };
    }

    // All claimed rows are verified terminal — safe to release the lock.
    rel.releaseWorkerLock(sid);
    // Persist immutable per-launch record (never overwritten; keyed by session)
    const launchRecord = {
      session_id: sid, started_at: startedAt, finished_at: doneAt, exit_code: 0,
      expected_claim_ids: claimIds,
      usage: usage || null, usage_unknown: !usage,
    };
    try {
      writeState(`launch_${sid}`, launchRecord);
      // Record launch-level cost into daily accounting (bootstrap / non-request cost).
      // This is separate from respond.js per-request accounting — no double count
      // because this uses inboxId=null.
      if (usage && (usage.input_tokens || usage.output_tokens)) {
        accounting.recordRequestCost({
          inboxId: null,
          inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_tokens || usage.cache_read,
          cacheWriteTokens: usage.cache_write_tokens || usage.cache_write,
          model: usage.model || null,
        });
      }
    } catch (_) { /* non-fatal */ }
    setExecutionState({ state: 'terminal', session_id: sid, started_at: startedAt, finished_at: doneAt, exit_code: 0, usage_unknown: !usage });
    console.log('[Lipa preflight] agent turn exited 0, all rows verified terminal — lock released');
    return { launched: true, reason: 'clean_exit', exitCode: 0 };
  }

  // Non-zero / unknown exit: quarantine all claimed rows + hold.
  const code = result ? result.code : null;
  const exitClaimedIds = quarantineClaimedRows(sid, `agent turn exited non-zero (code=${code})`, doneAt);
  setExecutionState({ state: 'unknown', session_id: sid, started_at: startedAt, finished_at: doneAt, exit_code: code, reason: 'nonzero_exit', usage_unknown: !usage });
  setExecutionHold(`agent turn exited non-zero (code=${code}) — completion uncertain`, { session_id: sid, claimed_ids: exitClaimedIds });
  console.error(`[Lipa preflight] agent turn exit code=${code} — hold set, lock left to expire via TTL`);
  return { launched: true, reason: 'nonzero_exit', exitCode: code, holdSet: true };
}

module.exports = {
  runPreflight,
  // Re-export from lipaReliability for backward compat (tests import from here)
  setExecutionHold,
  clearExecutionHold,
  getExecutionHold,
  // Also expose execution state management for tests
  getExecutionState,
  setExecutionState,
};

// ── CLI entrypoint ───────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  initDB();
  ensureLipaTables();

  if (argv.includes('--clear-hold')) {
    // --clear-hold requires OPERATOR-SUPPLIED terminal evidence:
    //   --terminal-status "session confirmed terminated via openclaw sessions list"
    //   --source "Aviv, manual verification"
    //   --side-effect-outcome "no side effects; rows quarantined"
    // All three are REQUIRED. Without them the clear is refused.
    // DB checks (no claimed rows, all terminal) are also required but are NOT
    // sufficient — quarantine itself sets needs_review, which is not proof the
    // remote agent stopped.

    const getArg = (flag) => {
      const idx = argv.indexOf(flag);
      return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : null;
    };
    const terminalStatus = getArg('--terminal-status');
    const source = getArg('--source');
    const sideEffectOutcome = getArg('--side-effect-outcome');

    if (!terminalStatus || !source || !sideEffectOutcome) {
      console.error('[Lipa preflight] --clear-hold REFUSED: missing required evidence.');
      console.error('Required flags:');
      console.error('  --terminal-status "<how remote terminal status was verified>"');
      console.error('  --source "<who verified (operator name/id)>"');
      console.error('  --side-effect-outcome "<confirmed side effects or lack thereof>"');
      process.exit(1);
    }

    let hold;
    try {
      hold = getExecutionHold();
    } catch (e) {
      console.error('[Lipa preflight] --clear-hold: corrupt hold state (fail closed):', e.message);
      process.exit(1);
    }

    if (!hold) {
      console.log('[Lipa preflight] no execution hold was set');
      process.exit(0);
    }

    // Corrupt hold (detected by getExecutionHold) → refuse
    if (hold.corrupt) {
      console.error('[Lipa preflight] --clear-hold REFUSED: hold state is corrupt. Manual DB repair required.');
      process.exit(1);
    }

    if (typeof hold !== 'object' || typeof hold.active === 'undefined') {
      console.error('[Lipa preflight] --clear-hold REFUSED: unrecognized hold JSON (fail closed):', JSON.stringify(hold));
      process.exit(1);
    }

    const sessionId = hold.session_id || null;
    const db = getDB();

    // DB checks: no claimed rows, all terminal for this session
    let claimedRows = [];
    let nonTerminalRows = [];
    try {
      if (sessionId) {
        claimedRows = db.prepare("SELECT id, status FROM bridge_lipa_inbox WHERE session_id = ? AND status = 'claimed'").all(sessionId);
        nonTerminalRows = db.prepare(
          "SELECT id, status FROM bridge_lipa_inbox WHERE session_id = ? AND status NOT IN ('done','needs_review','dead')"
        ).all(sessionId);
      }
    } catch (e) {
      console.error('[Lipa preflight] --clear-hold: DB read failed (fail closed):', e.message);
      process.exit(1);
    }

    if (claimedRows.length > 0) {
      console.error(`[Lipa preflight] --clear-hold REFUSED: ${claimedRows.length} row(s) still 'claimed' for session ${sessionId}:`);
      for (const r of claimedRows) console.error(`  - inbox_id=${r.id}`);
      process.exit(1);
    }
    if (nonTerminalRows.length > 0) {
      console.error(`[Lipa preflight] --clear-hold REFUSED: ${nonTerminalRows.length} row(s) non-terminal for session ${sessionId}:`);
      for (const r of nonTerminalRows) console.error(`  - inbox_id=${r.id} status=${r.status}`);
      process.exit(1);
    }

    // Session match: the session in the hold must match the evidence
    // (operator is clearing the right hold)

    // All checks pass — write DURABLE audit record, then atomic clear
    const auditAt = Date.now();
    const evidence = {
      terminal_status: terminalStatus,
      source: source,
      side_effect_outcome: sideEffectOutcome,
      session_id: sessionId,
      hold_reason: hold.reason,
      hold_since: hold.since,
      cleared_at: auditAt,
    };

    // Audit MUST succeed before clear proceeds
    try {
      rel.logAttempt({
        inboxId: 0,  // sentinel for audit records (not tied to a specific inbox row)
        attemptNumber: 0,
        event: 'hold_cleared',
        outcome: 'ok',
        error: JSON.stringify(evidence),
        sessionId,
        finishedAt: auditAt,
      });
    } catch (e) {
      console.error('[Lipa preflight] --clear-hold REFUSED: audit log write failed (no clear without audit):', e.message);
      process.exit(1);
    }

    // Atomic clear: hold + execution state
    clearExecutionHold();
    setExecutionState({ state: 'terminal', session_id: sessionId, cleared_at: auditAt, reason: 'manual_clear_hold', evidence });

    console.log(`[Lipa preflight] execution hold cleared (was: ${truncate(hold.reason, 120)})`);
    console.log(`[Lipa preflight] audit: hold_cleared by ${source}, terminal_status: ${terminalStatus}`);
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
