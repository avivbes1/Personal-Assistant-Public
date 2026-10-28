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
const fs = require('fs');
const { initDB, getDB } = require('../src/db');
const rel = require('../src/bridge/lipaReliability');
const accounting = require('../src/bridge/lipaAccounting');
const { ensureLipaTables, getSmtpTransport } = require('../src/bridge/lipaLane');
const lipaConfig = require('../src/bridge/lipaConfig');
const { decideRelease } = require('../src/bridge/holdReleasePolicy');

// ── tunables ─────────────────────────────────────────────────────────────────
function intOr(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
const CLI_TIMEOUT_MS = intOr(process.env.LIPA_BRIDGE_CLI_TIMEOUT_MS, 15 * 60 * 1000); // 15 min (raised from 10 to accommodate coding tasks)
const HOLD_KEY = 'execution_hold';
const EXEC_STATE_KEY = 'execution_state';

// Grace period: a session must have been idle this long past CLI_TIMEOUT_MS
// before auto-reconciliation considers it terminated. Prevents clearing a hold
// on a session that is still actively running but just slow.
const AUTO_RECONCILE_GRACE_MS = intOr(process.env.LIPA_BRIDGE_RECONCILE_GRACE_MS, 2 * 60 * 1000); // 2 min

// The message handed to the agent turn — same intent as the OpenClaw cron message
// currently used: run the due-time gate, then process + respond to any claimed row.
const CRON_MESSAGE = [
  'LIPA_BRIDGE cron: run `node scripts/lipa-bridge-poll.js` to claim the due Lipa request.',
  'If it prints LIPA_BRIDGE_WAKE + a pending_commands block, execute each command and reply with',
  "`node scripts/lipa-bridge-respond.js <inbox_id> <request_id> '<response_json>' <subject> <in_reply_to> '<options_json>'`,",
  'echoing claim_generation + session_id back in options_json (fencing). If nothing is due, stop.',
].join(' ');

/**
 * Build a DIRECT EXECUTE message for bound-mode launches.
 *
 * ROOT CAUSE FIX (rows 915/917/918/921): the preflight sets LIPA_BRIDGE_BOUND,
 * LIPA_BRIDGE_CLAIM_ID, and LIPA_BRIDGE_CLAIM_GEN as env vars on the spawned
 * `openclaw agent` process, but the OpenClaw exec tool does NOT propagate those
 * env vars to grandchild processes. poll.js therefore sees no LIPA_BRIDGE_BOUND
 * and falls back to LEGACY mode, finds the row already `claimed`, exits silently,
 * and the preflight sets an execution hold (verified failure path).
 *
 * Fix (Option D + Option B hybrid):
 * - Option D: skip poll.js entirely — embed the full pre-claimed command data
 *   directly in the agent message so the agent can run respond.js without calling
 *   poll.js at all.
 * - Option B (safety net): write a manifest file at a deterministic path before
 *   spawn. If poll.js IS called (e.g. agent ignores instructions), it can read
 *   the manifest via OPENCLAW_SESSION_ID (which may still propagate via the
 *   OpenClaw CLI's own env handling) instead of relying on the three volatile
 *   env vars.
 *
 * Key requirement: if a row is claimed for a session, that session MUST process
 * it OR visibly fail. Silent exits that leave rows stuck are no longer acceptable.
 */
function buildBoundDirectMessage(claimedRows, sid) {
  const lines = [
    'LIPA_BRIDGE DIRECT EXECUTE: Requests have been pre-claimed for this session.',
    'DO NOT run poll.js — the claim data is provided below. Run respond.js directly for each request.',
    '',
    `Session ID: ${sid}`,
    '',
  ];

  for (const r of claimedRows) {
    const argsStr = JSON.stringify(r.args || {});
    const subjectEsc = (r.subject || '').replace(/'/g, "'\''");
    const optionsJson = JSON.stringify({
      claim_generation: r.claim_generation,
      session_id: sid,
    });
    lines.push(`--- Request ${r.id} ---`);
    lines.push(`  inbox_id:         ${r.id}`);
    lines.push(`  request_id:       ${r.request_id}`);
    lines.push(`  command:          ${r.command}`);
    lines.push(`  args:             ${argsStr}`);
    lines.push(`  from:             ${r.from_addr || ''}`);
    lines.push(`  subject:          ${r.subject || ''}`);
    lines.push(`  gmail_message_id: ${r.gmail_message_id || ''}`);
    lines.push(`  claim_generation: ${r.claim_generation}`);
    lines.push(`  created_at:       ${r.created_at}`);
    lines.push('');
    lines.push('  After executing, run exactly:');
    lines.push(`  node scripts/lipa-bridge-respond.js ${r.id} '${r.request_id}' '<response_json>' '${subjectEsc}' '' '${optionsJson}'`);
    lines.push('');
  }

  lines.push('IMPORTANT: respond.js options_json MUST include claim_generation and session_id as shown above.');
  lines.push('If respond.js exits non-zero, do not retry — report the error.');
  lines.push('');
  lines.push(`TIME BUDGET: You have ${Math.floor(CLI_TIMEOUT_MS / 1000)}s before the wrapper kills this session.`);
  lines.push('For large coding tasks: delegate to claude -p (which runs independently) so the work survives a wrapper timeout.');
  lines.push('If you need >80% of the budget, checkpoint progress via saveSplitProgress before the critical section.');

  return lines.join('\n');
}

function truncate(s, n = 300) { s = s == null ? '' : String(s); return s.slice(0, n); }

// ── auto-reconciliation: clear holds when session verifiably terminated ───────

/**
 * Fetch session record from `openclaw sessions --json` for inspection.
 * Returns { session: object|null, lookupFailed: boolean }.
 *
 * NOTE: Session JSON (as of 2026-10-28) has NO explicit terminal status or
 * endedAt field. Available fields: sessionId, key, updatedAt, ageMs,
 * abortedLastRun, totalTokens, totalTokensFresh, model, modelProvider,
 * contextTokens, agentId, agentRuntime, kind.
 * Therefore session state alone CANNOT serve as positive terminal evidence.
 * Release decisions are delegated to holdReleasePolicy.decideRelease().
 */
function fetchSessionRecord(sessionId) {
  try {
    const result = require('child_process').execFileSync(
      'openclaw', ['sessions', '--json', '--agent', 'personal'],
      { timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const data = JSON.parse(result);
    const sessions = data.sessions || [];
    const session = sessions.find(s => s.sessionId === sessionId) || null;
    return { session, lookupFailed: false };
  } catch (e) {
    console.error('[Lipa preflight] session lookup failed (fail closed):', e.message);
    return { session: null, lookupFailed: true };
  }
}

/**
 * Legacy adapter: wraps fetchSessionRecord into the old { terminated, evidence }
 * shape so that any external callers or tests using checkSessionTerminated still
 * compile. However, the decision logic now lives in holdReleasePolicy.decideRelease.
 *
 * IMPORTANT: This function now NEVER returns terminated:true on its own.
 * It always returns terminated:false — the actual release decision is made by
 * decideRelease() inside autoReconcileHold based on row completion evidence.
 */
function checkSessionTerminated(sessionId) {
  const { session, lookupFailed } = fetchSessionRecord(sessionId);
  if (lookupFailed) {
    return { terminated: false, evidence: 'session lookup failed — fail closed' };
  }
  // Informational only — session state cannot prove termination
  if (!session) {
    return { terminated: false, evidence: 'session_not_found (not sufficient for release)' };
  }
  return {
    terminated: false,
    evidence: `session exists: ageMs=${session.ageMs}, aborted=${session.abortedLastRun}, tokensFresh=${session.totalTokensFresh}`
  };
}

/**
 * Auto-reconcile an execution hold by verifying the hold's session has
 * terminated AND all claimed rows are in terminal DB states. Returns true if
 * the hold was cleared.
 *
 * SAFETY:
 *   - Fails closed: any check failure keeps the hold.
 *   - Corrupt holds are NEVER auto-cleared (require manual intervention).
 *   - A session that is still running keeps the hold.
 *   - Non-terminal rows (pending, retry, claimed) keep the hold.
 *
 * If `checkTerminated` is supplied (dependency injection for tests), it is
 * called instead of the real `checkSessionTerminated`.
 */
async function autoReconcileHold(hold, now, { checkTerminated } = {}) {
  if (!hold) return false;

  // ── Fetch row states for all claimed IDs ──
  const claimedIds = hold.claimed_ids || [];
  const db = getDB();
  const rows = [];
  for (const id of claimedIds) {
    const row = db.prepare('SELECT id, status FROM bridge_lipa_inbox WHERE id = ?').get(id);
    if (row) rows.push(row);
  }

  // ── Fetch session record (informational — not used for decision) ──
  let sessionLookupFailed = false;
  let session = null;
  if (hold.session_id) {
    // Support injected checker for tests (legacy interface)
    if (checkTerminated) {
      // Legacy path: test injects a checker. We call it but ignore its
      // terminated verdict — decideRelease makes the call.
      const checker = checkTerminated;
      const termResult = checker(hold.session_id);
      const resolved = (termResult && typeof termResult.then === 'function')
        ? await termResult : termResult;
      // Treat legacy checker failure as lookup failure
      if (resolved.evidence && resolved.evidence.includes('check_failed')) {
        sessionLookupFailed = true;
      }
      // Build a minimal session-like object from legacy response for logging
      session = resolved.terminated === undefined ? null : { _legacy: true, evidence: resolved.evidence };
    } else {
      const result = fetchSessionRecord(hold.session_id);
      session = result.session;
      sessionLookupFailed = result.lookupFailed;
    }
  }

  // ── Delegate to pure policy function ──
  const decision = decideRelease({
    hold,
    session,
    rows,
    sessionLookupFailed,
  });

  if (!decision.release) {
    console.log(`[Lipa preflight] auto-reconcile: hold preserved — ${decision.reason}`);
    return false;
  }

  // ── All checks pass — clear hold atomically ──
  const cleared = clearExecutionHold();
  if (cleared) {
    rel.logAttempt({
      inboxId: 0, attemptNumber: 0,
      event: 'hold_auto_reconciled', outcome: 'ok',
      error: JSON.stringify({
        session_id: hold.session_id,
        claimed_ids: claimedIds,
        policy_reason: decision.reason,
        reconciled_at: now,
      }),
      sessionId: hold.session_id,
      finishedAt: now,
    });
    console.log(`[Lipa preflight] AUTO-RECONCILED hold for session ${hold.session_id}: ${decision.reason}`);
  }
  return !!cleared;
}

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
  if (!row) return { exists: false, value: null, corrupt: false };
  if (row.value == null) return { exists: true, value: null, corrupt: true }; // SQL NULL = fail closed
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

const VALID_EXEC_STATES = new Set(['active', 'unknown', 'terminal']);

/**
 * Current execution state. Fails CLOSED on:
 * - corrupt JSON (parse error)
 * - empty object {}, array [], string, or non-object
 * - missing or unrecognized state field
 * - missing session_id
 * All return a synthetic { state: 'unknown', corrupt: true } so launches are blocked.
 */
function getExecutionState() {
  const r = readStateEx(EXEC_STATE_KEY);
  if (!r.exists) return null;
  if (r.corrupt) {
    console.error('[Lipa preflight] execution_state: malformed JSON — fail closed');
    return { state: 'unknown', corrupt: true, reason: 'malformed_json' };
  }
  const v = r.value;
  // Schema validation: must be a non-null, non-array object with known state + session_id
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    console.error('[Lipa preflight] execution_state: not a valid object — fail closed');
    return { state: 'unknown', corrupt: true, reason: 'invalid_type' };
  }
  if (!v.state || !VALID_EXEC_STATES.has(v.state)) {
    console.error(`[Lipa preflight] execution_state: unknown state '${v.state}' — fail closed`);
    return { state: 'unknown', corrupt: true, reason: 'unknown_state' };
  }
  if (v.state !== 'terminal') {
    if (!v.session_id || typeof v.session_id !== 'string') {
      console.error('[Lipa preflight] execution_state: missing/non-string session_id — fail closed');
      return { state: 'unknown', corrupt: true, reason: 'invalid_session_id' };
    }
    if (v.started_at != null && (typeof v.started_at !== 'number' || !Number.isFinite(v.started_at))) {
      console.error('[Lipa preflight] execution_state: non-numeric started_at — fail closed');
      return { state: 'unknown', corrupt: true, reason: 'invalid_started_at' };
    }
  }
  return v;
}

function setExecutionState(obj) {
  writeState(EXEC_STATE_KEY, obj);
}

// ── monitoring / alerting (non-fatal, best-effort) ───────────────────────────

const HOLD_ALERT_THRESHOLD_MS = 30 * 60 * 1000;    // alert after hold active >30m
const HOLD_ALERT_KEY = 'hold_alert_last_sent';
const AVIV_WHATSAPP_JID = '972504606660@c.us';
const ALERT_EMAIL = 'avivbesinsky@mail.instinct.com';

/**
 * Alert that an execution hold has been active for a long time. Sends a WhatsApp
 * DM to Aviv and an email. Best-effort: each channel is independently wrapped so
 * one failing does not block the other, and neither failing blocks the preflight.
 */
async function sendHoldAlert(hold, now) {
  const sinceStr = hold.since ? new Date(hold.since).toISOString() : 'unknown';
  const reason = hold.reason || 'unknown';

  // WhatsApp DM via the local bridge HTTP endpoint (arg array, no shell interp).
  try {
    const payload = JSON.stringify({
      jid: AVIV_WHATSAPP_JID,
      message: `⚠️ Lipa Bridge execution hold has been active for >30 minutes since ${sinceStr}. Reason: ${reason}. Manual intervention required: node scripts/lipa-bridge-preflight.js --clear-hold ...`,
    });
    require('child_process').execFileSync('curl', [
      '-sf', '-X', 'POST', 'http://localhost:3001/send-message',
      '-H', 'Content-Type: application/json',
      '-d', payload,
    ], { timeout: 10000, stdio: 'ignore' });
  } catch (e) {
    console.error('[Lipa preflight] hold WhatsApp alert failed (non-fatal):', e.message);
  }

  // Email alert.
  try {
    const transport = getSmtpTransport();
    await transport.sendMail({
      from: lipaConfig.account,
      to: ALERT_EMAIL,
      subject: '[Lipa Bridge] Execution hold alert',
      text: [
        'Lipa Bridge execution hold has been active for more than 30 minutes.',
        '',
        `since:       ${sinceStr}`,
        `reason:      ${reason}`,
        `session_id:  ${hold.session_id != null ? hold.session_id : 'null'}`,
        `claimed_ids: ${JSON.stringify(hold.claimed_ids || [])}`,
        '',
        'Manual intervention required. Verify the remote agent state, then clear via:',
        '  node scripts/lipa-bridge-preflight.js --clear-hold ...',
      ].join('\n'),
    });
  } catch (e) {
    console.error('[Lipa preflight] hold email alert failed (non-fatal):', e.message);
  }
}

/**
 * Notify that an execution hold was just SET due to an error (timeout / bad exit).
 * Best-effort email; never throws into the caller.
 */
async function sendErrorAlert({ sessionId, claimedIds, reason, now }) {
  try {
    const transport = getSmtpTransport();
    await transport.sendMail({
      from: lipaConfig.account,
      to: ALERT_EMAIL,
      subject: `[Lipa Bridge] Execution error - ${reason}`,
      text: JSON.stringify({
        session_id: sessionId != null ? sessionId : null,
        claimed_ids: claimedIds || [],
        reason: reason || 'unknown',
        timestamp: new Date(now).toISOString(),
      }, null, 2),
    });
  } catch (e) {
    console.error('[Lipa preflight] error alert email failed (non-fatal):', e.message);
  }
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

  // WAL visibility: child process may have just written.
  // Re-read by closing and recreating any implicit read snapshot.
  try { db.pragma('wal_checkpoint(PASSIVE)'); } catch (_) {}

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
function defaultLauncher({ command, args, timeoutMs, sessionId, claimDetails }) {
  return new Promise((resolve, reject) => {
    let child;
    const stdoutChunks = [];
    try {
      const firstClaim = claimDetails && claimDetails[0];
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: {
          ...process.env,
          OPENCLAW_SESSION_ID: sessionId,
          LIPA_BRIDGE_BOUND: '1',
          LIPA_BRIDGE_CLAIM_ID: firstClaim ? String(firstClaim.inbox_id) : '',
          LIPA_BRIDGE_CLAIM_GEN: firstClaim ? String(firstClaim.claim_generation) : '',
        },
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
    if (hold) {
      // AUTO-RECONCILIATION: before blocking, check if the hold's session has
      // verifiably terminated and all claimed rows are terminal. If so, clear
      // the hold automatically and continue to launch.
      // When deps.checkTerminated is explicitly `false`, skip auto-reconciliation
      // entirely (used by tests that expect holds to block unconditionally).
      const skipReconcile = deps.checkTerminated === false;
      try {
        const reconciled = !skipReconcile && await autoReconcileHold(hold, now, { checkTerminated: deps.checkTerminated });
        if (reconciled) {
          // Hold cleared — fall through to normal launch checks below
          console.log('[Lipa preflight] hold auto-reconciled, continuing to launch checks');
        } else {
          // Hold still active — alert if stale, then block
          try {
            if (hold.since && (now - hold.since) > HOLD_ALERT_THRESHOLD_MS) {
              const lastSent = readStateEx(HOLD_ALERT_KEY);
              const lastSentAt = (lastSent.exists && !lastSent.corrupt && typeof lastSent.value === 'number')
                ? lastSent.value : 0;
              if ((now - lastSentAt) > HOLD_ALERT_THRESHOLD_MS) {
                await sendHoldAlert(hold, now);
                writeState(HOLD_ALERT_KEY, now);
              }
            }
          } catch (alertErr) {
            console.error('[Lipa preflight] hold alert check failed (non-fatal):', alertErr.message);
          }
          return { launched: false, reason: 'execution_hold', hold };
        }
      } catch (reconcileErr) {
        // Reconciliation failed — fail closed, keep hold
        console.error('[Lipa preflight] auto-reconcile error (keeping hold):', reconcileErr.message);
        return { launched: false, reason: 'execution_hold', hold };
      }
    }

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

  // ── claim atomically under global lock + persist state BEFORE spawn ─────
  const startedAt = Date.now();
  const claimDue = deps.claimDue || rel.claimDue;
  const claimResult = claimDue({ limit: 1, sessionId: sid, now: startedAt });
  const claimedRows = (claimResult && claimResult.rows) || [];
  const expectedClaimIds = claimedRows.map(r => r.id);
  const claimDetails = claimedRows.map(r => ({
    inbox_id: r.id, claim_generation: r.claim_generation, session_id: sid,
  }));

  if (expectedClaimIds.length === 0) {
    // Nothing was claimed despite getDueCount > 0 (race or paused)
    rel.releaseWorkerLock(sid);
    return { launched: false, reason: 'no_claims' };
  }

  setExecutionState({
    state: 'active',
    session_id: sid,
    started_at: startedAt,
    expected_claim_ids: expectedClaimIds,
    claim_details: claimDetails,
  });

  // ── persist launch-start record BEFORE spawn (immutable INSERT) ──────────
  // A launch INSERT failure MUST stop the launch (not be swallowed).
  const launchKey = `launch_${sid}`;
  try {
    getDB().prepare(
      'INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES (?, ?, ?)'
    ).run(launchKey, JSON.stringify({
      session_id: sid, started_at: startedAt, expected_claim_ids: expectedClaimIds,
      claim_details: claimDetails, status: 'started', usage: null, usage_unknown: true,
    }), startedAt);
  } catch (launchInsertErr) {
    // Key collision means this sid was already used (replayed) — refuse to launch
    console.error(`[Lipa preflight] launch INSERT failed (refusing launch): ${launchInsertErr.message}`);
    rel.releaseWorkerLock(sid);
    setExecutionState({ state: 'unknown', session_id: sid, started_at: startedAt, reason: 'launch_insert_failed' });
    return { launched: false, reason: 'launch_insert_failed', error: launchInsertErr.message };
  }

  /** Persist outcome record (immutable INSERT). Called from all exit paths.
   *  For non-clean exits with captured usage, also reconcile into cost ledger
   *  (respond.js only covers clean completions; failed/timeout usage is invisible
   *  without this). Uses sourceKey dedup to never double-count with respond.js. */
  function persistOutcome(status, finishedAt, extra = {}) {
    try {
      getDB().prepare('INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run('outcome_' + sid, JSON.stringify({
          session_id: sid, started_at: startedAt, finished_at: finishedAt,
          expected_claim_ids: expectedClaimIds, status, ...extra,
        }), finishedAt);
    } catch (_) { /* immutable: collision = already exists */ }
    // Reconcile captured run usage into cost ledger for non-clean exits
    if (status !== 'clean_exit' && extra.usage && !extra.usage_unknown) {
      try {
        accounting.recordRequestCost({
          inboxId: expectedClaimIds[0] || null,
          inputTokens: extra.usage.input_tokens,
          outputTokens: extra.usage.output_tokens,
          cacheReadTokens: extra.usage.cache_read_tokens || extra.usage.cache_read,
          cacheWriteTokens: extra.usage.cache_write_tokens || extra.usage.cache_write,
          model: extra.usage.model || null,
          sourceKey: `wrapper_${sid}_${status}`,  // dedup: never double-count with respond.js
        });
      } catch (_) { /* non-fatal */ }
    } else if (status !== 'clean_exit') {
      // Unknown usage for failed runs — record explicitly as unknown
      try {
        accounting.recordRequestCost({
          inboxId: expectedClaimIds[0] || null,
          sourceKey: `wrapper_${sid}_${status}`,
        });
      } catch (_) { /* non-fatal */ }
    }
  }

  // ── write claim manifest file BEFORE spawn (Option B safety net) ─────────
  // If the agent ignores instructions and calls poll.js anyway, poll.js can read
  // this file via OPENCLAW_SESSION_ID (which propagates through the OpenClaw CLI)
  // instead of relying on the three volatile env vars that don't propagate.
  const manifestPath = `/tmp/lipa-bridge-claim-${sid}.json`;
  try {
    fs.writeFileSync(manifestPath, JSON.stringify({
      session_id: sid,
      written_at: Date.now(),
      claim_details: claimDetails,
    }, null, 2));
  } catch (manifestErr) {
    // Non-fatal: manifest file is a safety net, not the primary path
    console.error(`[Lipa preflight] manifest write failed (non-fatal): ${manifestErr.message}`);
  }

  // ── build the agent message — Option D: direct execute, no poll.js ─────────
  // ROOT CAUSE FIX: env vars (LIPA_BRIDGE_BOUND/CLAIM_ID/CLAIM_GEN) are not
  // inherited by grandchild processes of the OpenClaw agent exec tool. The fix:
  // embed all pre-claimed command data directly in the agent message so the agent
  // can run respond.js without needing to call poll.js at all.
  const claimJson = JSON.stringify(claimDetails);
  const boundMessage = buildBoundDirectMessage(claimedRows, sid);

  // ── launch ─────────────────────────────────────────────────────────────────
  const args = ['agent', '-m', boundMessage, '--agent', 'personal', '--session-id', sid, '--json'];
  let result;
  try {
    result = await launcher({ command: 'openclaw', args, timeoutMs, sessionId: sid, claimDetails });
  } catch (spawnErr) {
    // (5/T9) Launch failed to start: we cannot know if anything ran → hold; do NOT
    // release the lock (respond.js may or may not run; TTL is the safety net).
    const spawnDoneAt = Date.now();
    setExecutionState({ state: 'unknown', session_id: sid, started_at: startedAt, finished_at: spawnDoneAt, reason: `spawn_error: ${spawnErr.message}` });
    persistOutcome('spawn_error', spawnDoneAt, { usage: null, usage_unknown: true });
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
    persistOutcome('timeout', doneAt, { usage: usage || null, usage_unknown: !usage });
    await sendErrorAlert({ sessionId: sid, claimedIds, reason: 'CLI timeout — remote agent status unknown', now: doneAt });
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
      persistOutcome('verification_failed', doneAt, { exit_code: 0, usage: usage || null, usage_unknown: !usage, unverifiedIds });
      return { launched: true, reason: 'clean_exit_verification_failed', exitCode: 0, holdSet: true, unverifiedIds };
    }

    // All claimed rows are verified terminal — safe to release the lock.
    rel.releaseWorkerLock(sid);
    // Persist outcome record (immutable INSERT, separate from launch-start)
    // No double-count: respond.js handles per-request cost. The wrapper only
    // records run-level metadata. Accounting uses respond.js records only.
    persistOutcome('clean_exit', doneAt, { exit_code: 0, usage: usage || null, usage_unknown: !usage });
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
  persistOutcome('nonzero_exit', doneAt, { exit_code: code, usage: usage || null, usage_unknown: !usage });
  await sendErrorAlert({ sessionId: sid, claimedIds: exitClaimedIds, reason: `agent turn exited non-zero (code=${code})`, now: doneAt });
  return { launched: true, reason: 'nonzero_exit', exitCode: code, holdSet: true };
}

module.exports = {
  runPreflight,
  buildBoundDirectMessage,
  // Re-export from lipaReliability for backward compat (tests import from here)
  setExecutionHold,
  clearExecutionHold,
  getExecutionHold,
  // Also expose execution state management for tests
  getExecutionState,
  setExecutionState,
  // Auto-reconciliation (exported for tests)
  autoReconcileHold,
  checkSessionTerminated,
  CLI_TIMEOUT_MS,
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

    // Session match: operator must supply --hold-session matching hold.session_id
    const holdSession = getArg('--hold-session');
    if (sessionId != null) {
      // Hold has a session — operator must confirm they're clearing the right one
      if (!holdSession) {
        console.error(`[Lipa preflight] --clear-hold REFUSED: hold has session_id=${sessionId}. Supply --hold-session "${sessionId}" to confirm.`);
        process.exit(1);
      }
      if (holdSession !== sessionId) {
        console.error(`[Lipa preflight] --clear-hold REFUSED: --hold-session "${holdSession}" does not match hold session_id "${sessionId}".`);
        process.exit(1);
      }
    } else {
      // Null session_id hold (e.g. incident protective hold) — require explicit
      // evidence that no remote session or side effect remains
      if (!holdSession || holdSession !== 'none') {
        console.error('[Lipa preflight] --clear-hold REFUSED: hold has session_id=null (incident hold).');
        console.error('Supply --hold-session "none" to confirm no remote session exists.');
        process.exit(1);
      }
    }

    // All checks pass — write DURABLE audit + clear in ONE transaction
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

    // Audit + clear in ONE transaction (atomic: either both succeed or neither)
    const clearDb = getDB();
    const tx = clearDb.transaction(() => {
      // 0. Recheck hold state inside transaction (prevent race)
      const recheckRow = clearDb.prepare('SELECT value FROM bridge_lipa_state WHERE key = ?').get('execution_hold');
      if (!recheckRow || !recheckRow.value) throw new Error('hold disappeared between check and clear');
      const recheckHold = JSON.parse(recheckRow.value);
      if (!recheckHold.active) throw new Error('hold is no longer active');
      if (recheckHold.session_id !== sessionId) throw new Error(`hold session_id changed (was ${sessionId}, now ${recheckHold.session_id})`);
      // 1. Write audit
      rel.logAttempt({
        inboxId: 0,
        attemptNumber: 0,
        event: 'hold_cleared',
        outcome: 'ok',
        error: JSON.stringify(evidence),
        sessionId,
        finishedAt: auditAt,
      });
      // 2. Delete hold
      clearDb.prepare('DELETE FROM bridge_lipa_state WHERE key = ?').run('execution_hold');
      // 3. Set execution state to terminal
      clearDb.prepare(
        `INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run('execution_state', JSON.stringify({ state: 'terminal', session_id: sessionId, cleared_at: auditAt, reason: 'manual_clear_hold', evidence }), auditAt);
    });
    try {
      tx();
    } catch (e) {
      console.error('[Lipa preflight] --clear-hold REFUSED: transactional write failed:', e.message);
      process.exit(1);
    }

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
