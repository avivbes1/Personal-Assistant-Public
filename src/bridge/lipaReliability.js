'use strict';
/**
 * bridge/lipaReliability.js — durable worker layer for the Lipa lane.
 *
 * The Lipa lane (bridge_lipa_inbox/outbox, src/bridge/lipaLane.js) was a plain
 * pending/done queue: the OpenClaw cron read every pending row and wrote a
 * response, with no due-time gating, no single-worker guarantee, no retry
 * bounds, no fencing of late completions, and no reaction to a provider billing
 * outage. This module adds all of that on top of the SAME tables (columns added
 * additively in db.js), so the existing lane keeps working unchanged.
 *
 * Design mirrors outboxRepository.js: getDB() is required lazily to avoid a
 * load-time cycle, and every multi-row transition runs inside db.transaction().
 *
 * status lifecycle on bridge_lipa_inbox:
 *   pending → claimed → done
 *                    ↘ retry (backoff) → claimed → …           (≤ 3 attempts)
 *                    ↘ needs_review     (uncertain side effect — never retried)
 *                    ↘ dead             (attempts exhausted)
 *   any     → paused  (billing circuit breaker parks the whole lane)
 *
 * Fencing: each claim stamps a monotonically-increasing claim_generation. A
 * completion must present the generation it was handed at claim time; if the row
 * has since moved on (retried, reconciled, re-claimed by a newer session) the
 * generation no longer matches and the completion is IGNORED, not applied.
 */

const lipaConfig = require('./lipaConfig');
// Advisory cost accounting (soft daily/request caps). Re-exported below so the
// whole Lipa worker layer has one import surface (rel.accounting.*); the scripts
// also import it directly.
const lipaAccounting = require('./lipaAccounting');

// ── execution hold (bridge_lipa_state key 'execution_hold') ──────────────────
// Centralised here so lipaReliability (reconcileStaleClaims) and the preflight
// wrapper share the SAME hold logic without a circular require.
const HOLD_KEY = 'execution_hold';
function _truncateHold(s, n = 300) { s = s == null ? '' : String(s); return s.slice(0, n); }

/** The active execution hold, or null when none is set. */
function getExecutionHold() {
  const h = getState(HOLD_KEY);
  return h && h.active ? h : null;
}

/**
 * Raise the execution hold. Idempotent: if one already exists the `since` field
 * is preserved so we don't accidentally reset the clock. Merges claimed_ids.
 */
function setExecutionHold(reason, meta = {}) {
  const now = Date.now();
  const prev = getState(HOLD_KEY);
  // Validate prev — corrupt JSON from getState returns null; safe.
  const prevActive = prev && typeof prev === 'object' && prev.active;
  const prevIds = prevActive && Array.isArray(prev.claimed_ids) ? prev.claimed_ids : [];
  const newIds = meta.claimed_ids != null && Array.isArray(meta.claimed_ids) ? meta.claimed_ids : [];
  // Merge claimed_ids (union, deduplicated)
  const merged = Array.from(new Set([...prevIds, ...newIds]));
  const value = {
    active: true,
    reason: _truncateHold(reason),
    session_id: meta.session_id != null ? meta.session_id : (prevActive && prev.session_id) || null,
    claimed_ids: merged,
    since: prevActive && prev.since ? prev.since : now,
  };
  setState(HOLD_KEY, value);
  console.error('[Lipa] EXECUTION HOLD set:', _truncateHold(reason, 200));
  return value;
}

/** Clear the execution hold. Returns the hold that was cleared (or null). */
function clearExecutionHold() {
  const prev = getExecutionHold();
  if (prev) db().prepare('DELETE FROM bridge_lipa_state WHERE key = ?').run(HOLD_KEY);
  return prev || null;
}

function db() {
  return require('../db').getDB();
}

// ── tunables ─────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = intOr(process.env.LIPA_BRIDGE_MAX_ATTEMPTS, 3);       // total, incl. first
const BACKOFF_BASE_MS = intOr(process.env.LIPA_BRIDGE_BACKOFF_BASE_MS, 60000);
const LEASE_MS = intOr(process.env.LIPA_BRIDGE_LEASE_MS, 5 * 60 * 1000);
const WORKER_LOCK_TTL_MS = intOr(process.env.LIPA_BRIDGE_LOCK_TTL_MS, 5 * 60 * 1000);
const MAX_ARGS_BYTES = intOr(process.env.LIPA_BRIDGE_MAX_ARGS_BYTES, 64 * 1024);

function intOr(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function truncate(s, n = 500) { s = s == null ? null : String(s); return s ? s.slice(0, n) : null; }
function jitter(ms) { return Math.floor(ms * 0.2 * Math.random()); }          // up to +20%

// ── key/value control state (circuit breaker + worker lock) ──────────────────

function getState(key) {
  const row = db().prepare('SELECT value FROM bridge_lipa_state WHERE key = ?').get(key);
  if (!row || row.value == null) return null;
  try { return JSON.parse(row.value); } catch (_) { return null; }
}

function setState(key, value) {
  db().prepare(
    `INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), Date.now());
}

// ── billing circuit breaker ──────────────────────────────────────────────────

/**
 * True only for an ACTUAL provider insufficient-credit / billing rejection — a
 * 402, an insufficient_credits/insufficient_quota/billing error code, or an
 * unmistakable message. This is deliberately NOT a cost estimate: Aviv has not
 * approved pre-emptive dollar caps, so the breaker reacts to real API errors.
 */
function isBillingError(err) {
  if (!err) return false;
  const status = err.status || err.statusCode || (err.response && err.response.status);
  if (Number(status) === 402) return true;
  const code = String(err.code || err.type || (err.error && (err.error.type || err.error.code)) || '').toLowerCase();
  if (/insufficient_credit|insufficient_quota|billing|payment_required|credit_balance/.test(code)) return true;
  const msg = String(err.message || err.error && err.error.message || err || '').toLowerCase();
  return /insufficient[ _](credit|quota|balance|fund)|payment required|402|billing (hard )?limit|credit balance is too low/.test(msg);
}

function getCircuit() {
  return getState('circuit') || { state: 'closed' };
}
function isPaused() {
  return getCircuit().state === 'open';
}

/**
 * Persist a 'paused' state for the whole lane and fire a best-effort ops alert.
 * Called when a real provider billing error is detected. Idempotent.
 */
function pauseCircuit(reason, meta = {}) {
  const already = isPaused();
  setState('circuit', { state: 'open', reason: truncate(reason, 300), meta, since: Date.now() });
  if (!already) {
    try {
      const { sendAlertDirect } = require('../health');
      Promise.resolve(sendAlertDirect(`🟠 Lipa Bridge PAUSED — provider billing error: ${truncate(reason, 200)}`)).catch(() => {});
    } catch (_) { /* health module optional in tests */ }
    console.error('[Lipa][circuit] PAUSED:', truncate(reason, 200));
  }
}

function resumeCircuit() {
  setState('circuit', { state: 'closed', resumed_at: Date.now() });
  console.log('[Lipa][circuit] resumed');
}

// ── single global worker lock ────────────────────────────────────────────────

/** Acquire (or renew) the global worker lock. Returns true if held by us. */
function acquireWorkerLock(holder, ttlMs = WORKER_LOCK_TTL_MS) {
  const now = Date.now();
  const tx = db().transaction(() => {
    const cur = getState('worker_lock');
    if (cur && cur.holder !== holder && cur.expires_at > now) return false; // someone else, still live
    setState('worker_lock', { holder, acquired_at: (cur && cur.holder === holder) ? cur.acquired_at : now, expires_at: now + ttlMs });
    return true;
  });
  return tx();
}

function releaseWorkerLock(holder) {
  const cur = getState('worker_lock');
  if (cur && cur.holder === holder) db().prepare("DELETE FROM bridge_lipa_state WHERE key = 'worker_lock'").run();
}

// ── attempt logging (every attempt, incl. failures/timeouts/fences) ──────────

function logAttempt(a) {
  db().prepare(
    `INSERT INTO bridge_lipa_attempts
       (inbox_id, attempt_number, event, outcome, error, provider_message_id,
        session_id, run_id, claim_generation, started_at, finished_at,
        cache_read_tokens, cache_write_tokens, input_tokens, output_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    a.inboxId, a.attemptNumber || 0, a.event, a.outcome || null, truncate(a.error),
    a.providerMessageId || null, a.sessionId || null, a.runId || null,
    a.claimGeneration != null ? a.claimGeneration : null,
    a.startedAt || null, a.finishedAt != null ? a.finishedAt : Date.now(),
    // NULL is stored as-is and reported as 'unknown' by readers — never 0.
    a.cacheReadTokens == null ? null : a.cacheReadTokens,
    a.cacheWriteTokens == null ? null : a.cacheWriteTokens,
    a.inputTokens == null ? null : a.inputTokens,
    a.outputTokens == null ? null : a.outputTokens
  );
}

// ── args guard (no silent truncation) ────────────────────────────────────────

function argsByteLength(args) {
  const json = typeof args === 'string' ? args : JSON.stringify(args || {});
  return Buffer.byteLength(json, 'utf8');
}

/**
 * Guarded enqueue. Rejects an oversized job (> MAX_ARGS_BYTES) rather than
 * silently truncating it. Dedups on request_id: two concurrent arrivals with the
 * same request_id insert only once (ON CONFLICT via the partial unique index
 * idx_bridge_lipa_request_id — see db.js). A NULL request_id is NEVER deduped
 * (the partial index excludes NULLs, so each anonymous job inserts).
 * Returns {inserted, id, rejected?, duplicate?, bytes, reason?}.
 * (Splitting large jobs is supported via the split_progress column + saveSplitProgress;
 *  callers that can chunk should do so and enqueue each chunk under the limit.)
 */
function enqueueGuarded({ requestId, command, args, fromAddr, subject, messageId }) {
  const now = Date.now();
  const argsJson = JSON.stringify(args || {});
  const bytes = Buffer.byteLength(argsJson, 'utf8');
  if (bytes > MAX_ARGS_BYTES) {
    console.error(`[Lipa] rejecting oversized job: ${bytes}B > ${MAX_ARGS_BYTES}B (request_id=${requestId || 'n/a'})`);
    return { inserted: false, rejected: true, bytes, reason: `args ${bytes}B exceeds ${MAX_ARGS_BYTES}B limit` };
  }
  const cols = `(request_id, command, args_json, from_addr, subject, gmail_message_id,
        created_at, status, attempts, available_at, args_bytes, updated_at)`;
  const vals = `VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`;
  const params = [requestId || null, command || '', argsJson, fromAddr || null, subject || null,
        messageId || null, now, now, bytes, now];
  if (requestId) {
    // Dedup non-null request_id against the partial unique index. The WHERE
    // clause in the conflict target must match the partial index exactly.
    const res = db().prepare(
      `INSERT INTO bridge_lipa_inbox ${cols} ${vals}
         ON CONFLICT(request_id) WHERE request_id IS NOT NULL DO NOTHING`
    ).run(...params);
    if (res.changes === 0) {
      const existing = db().prepare('SELECT id FROM bridge_lipa_inbox WHERE request_id = ?').get(requestId);
      return { inserted: false, duplicate: true, id: existing ? existing.id : undefined, bytes };
    }
    return { inserted: true, id: res.lastInsertRowid, bytes };
  }
  const res = db().prepare(`INSERT INTO bridge_lipa_inbox ${cols} ${vals}`).run(...params);
  return { inserted: true, id: res.lastInsertRowid, bytes };
}

function saveSplitProgress(inboxId, progress) {
  db().prepare('UPDATE bridge_lipa_inbox SET split_progress = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(progress), Date.now(), inboxId);
}

// ── due-time gate helper ─────────────────────────────────────────────────────

/** Count rows that are actually due now. Returns 0 when the lane is paused. */
function getDueCount(now = Date.now()) {
  if (isPaused()) return 0;
  return db().prepare(
    "SELECT COUNT(*) AS c FROM bridge_lipa_inbox WHERE status IN ('pending','retry') AND available_at <= ?"
  ).get(now).c;
}

// ── claim ────────────────────────────────────────────────────────────────────

/**
 * Atomically claim up to `limit` DUE rows (pending|retry, available_at <= now)
 * for one worker session. Stamps a fresh claim_generation + lease + session/run
 * ids on each. No-ops (returns []) when the circuit is open. Attempts are NOT
 * incremented here — only a failed delivery counts against MAX_ATTEMPTS.
 */
function claimDue({ limit = 1, sessionId, runId, now = Date.now(), leaseMs = LEASE_MS } = {}) {
  if (isPaused()) return { paused: true, rows: [] };
  const tx = db().transaction(() => {
    const rows = db().prepare(
      `SELECT * FROM bridge_lipa_inbox
        WHERE status IN ('pending','retry') AND available_at <= ?
        ORDER BY created_at ASC, id ASC LIMIT ?`
    ).all(now, limit);
    const claimed = [];
    for (const r of rows) {
      const gen = (r.claim_generation || 0) + 1;
      db().prepare(
        `UPDATE bridge_lipa_inbox
            SET status = 'claimed', claim_generation = ?, lease_expires_at = ?,
                session_id = ?, run_id = ?, updated_at = ?
          WHERE id = ?`
      ).run(gen, now + leaseMs, sessionId || null, runId || null, now, r.id);
      logAttempt({ inboxId: r.id, attemptNumber: r.attempts, event: 'claim', outcome: 'ok',
        sessionId, runId, claimGeneration: gen, startedAt: now, finishedAt: now });
      claimed.push({ ...r, status: 'claimed', claim_generation: gen, lease_expires_at: now + leaseMs,
        session_id: sessionId, run_id: runId, args: safeParse(r.args_json) });
    }
    return claimed;
  });
  return { paused: false, rows: tx() };
}

function safeParse(j) { try { return JSON.parse(j || '{}'); } catch (_) { return {}; } }

/** Shared fence check: is this completion still the live claim on the row? */
function fenceOk(row, claimGeneration) {
  return !!row && row.status === 'claimed' && row.claim_generation === claimGeneration;
}

// ── complete / fail / needs_review ───────────────────────────────────────────

/**
 * Finish a claimed row. Fences stale/late completions. Writes the outbox reply
 * exactly once (dedup by inbox_id). `uncertain: true` routes uncertain mutating
 * work to needs_review with NO outbox write and NO retry.
 * Returns {done|fenced|needsReview: true, ...}.
 */
function completeClaim({ inboxId, claimGeneration, sessionId, response, originalSubject, inReplyTo,
                         providerMessageId, cacheReadTokens, cacheWriteTokens,
                         inputTokens, outputTokens,
                         uncertain, uncertainReason }) {
  const now = Date.now();
  const tx = db().transaction(() => {
    const row = db().prepare('SELECT * FROM bridge_lipa_inbox WHERE id = ?').get(inboxId);
    if (!fenceOk(row, claimGeneration)) {
      logAttempt({ inboxId, attemptNumber: row ? row.attempts : 0, event: 'fenced', outcome: 'ignored',
        error: `late/stale completion (row gen=${row ? row.claim_generation : 'gone'}/${row ? row.status : 'gone'} vs ${claimGeneration})`,
        sessionId, claimGeneration, cacheReadTokens, cacheWriteTokens, inputTokens, outputTokens });
      return { fenced: true };
    }
    if (uncertain) {
      db().prepare(
        "UPDATE bridge_lipa_inbox SET status = 'needs_review', last_error = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?"
      ).run(truncate('uncertain side effect: ' + (uncertainReason || 'unverified mutating work')), now, inboxId);
      logAttempt({ inboxId, attemptNumber: row.attempts, event: 'needs_review', outcome: 'ok',
        error: uncertainReason || null, sessionId, claimGeneration, cacheReadTokens, cacheWriteTokens, inputTokens, outputTokens });
      return { needsReview: true };
    }
    // Outbox dedup: existence of an outbox row prevents a duplicate RESPONSE.
    const existing = db().prepare('SELECT id FROM bridge_lipa_outbox WHERE inbox_id = ?').get(inboxId);
    db().prepare("UPDATE bridge_lipa_inbox SET status = 'done', processed_at = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
      .run(now, now, inboxId);
    if (!existing) {
      db().prepare(
        `INSERT INTO bridge_lipa_outbox (inbox_id, request_id, response_json, original_subject, in_reply_to, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(inboxId, row.request_id || null, JSON.stringify(response == null ? {} : response),
            originalSubject || row.subject || null, inReplyTo || null, now);
    }
    logAttempt({ inboxId, attemptNumber: row.attempts, event: 'deliver', outcome: 'ok',
      providerMessageId, sessionId, claimGeneration, cacheReadTokens, cacheWriteTokens, inputTokens, outputTokens, finishedAt: now });
    return { done: true, outboxWritten: !existing, deduped: !!existing };
  });
  return tx();
}

/**
 * Record a delivery failure on a claimed row. Fences stale completions. A real
 * billing error pauses the whole lane (does NOT count against attempts — it is
 * an outage, not the job's fault). Otherwise increments attempts and either
 * schedules an exponential-backoff+jitter retry or dead-letters at MAX_ATTEMPTS.
 */
function failClaim({ inboxId, claimGeneration, sessionId, error, isTimeout,
                     cacheReadTokens, cacheWriteTokens, inputTokens, outputTokens,
                     providerMessageId, runId }) {
  const now = Date.now();
  const tx = db().transaction(() => {
    const row = db().prepare('SELECT * FROM bridge_lipa_inbox WHERE id = ?').get(inboxId);
    if (!fenceOk(row, claimGeneration)) {
      logAttempt({ inboxId, attemptNumber: row ? row.attempts : 0, event: 'fenced', outcome: 'ignored',
        error: 'late/stale failure', sessionId, runId, claimGeneration, providerMessageId,
        cacheReadTokens, cacheWriteTokens, inputTokens, outputTokens });
      return { fenced: true };
    }
    const errText = truncate(error && error.message ? error.message : error);

    if (isBillingError(error)) {
      pauseCircuit(errText || 'provider billing error', { inboxId });
      db().prepare("UPDATE bridge_lipa_inbox SET status = 'retry', available_at = ?, lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ?")
        .run(now, errText, now, inboxId);            // attempts unchanged — held, not penalized
      logAttempt({ inboxId, attemptNumber: row.attempts, event: 'paused', outcome: 'error',
        error: errText, sessionId, runId, claimGeneration, providerMessageId,
        cacheReadTokens, cacheWriteTokens, inputTokens, outputTokens, finishedAt: now });
      return { paused: true, status: 'retry' };
    }

    const attempts = (row.attempts || 0) + 1;
    logAttempt({ inboxId, attemptNumber: attempts, event: isTimeout ? 'timeout' : 'fail', outcome: 'error',
      error: errText, sessionId, runId, claimGeneration, providerMessageId,
      cacheReadTokens, cacheWriteTokens, inputTokens, outputTokens, finishedAt: now });

    // A failed (or timed-out) delivery may still have consumed provider tokens
    // BEFORE it failed — the success path is not the only place spend happens.
    // Record the (lower-bound / unknown) cost so accounting never treats a failed
    // attempt as free. Best-effort: a cost-INSERT error must not roll back or
    // change the core fail/retry/dead transition below.
    try {
      lipaAccounting.recordRequestCost({ inboxId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, now });
    } catch (e) { console.error('[Lipa] failClaim cost accounting failed:', e.message); }

    if (attempts >= MAX_ATTEMPTS) {
      db().prepare("UPDATE bridge_lipa_inbox SET status = 'dead', attempts = ?, last_error = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
        .run(attempts, errText, now, inboxId);
      return { status: 'dead', attempts };
    }
    const backoff = BACKOFF_BASE_MS * Math.pow(2, attempts - 1);
    const availableAt = now + backoff + jitter(backoff);
    db().prepare("UPDATE bridge_lipa_inbox SET status = 'retry', attempts = ?, available_at = ?, last_error = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
      .run(attempts, availableAt, errText, now, inboxId);
    return { status: 'retry', attempts, available_at: availableAt };
  });
  return tx();
}

/**
 * Reclaim rows whose lease expired (worker died / remote session vanished — a
 * PID is not remote liveness, so we rely on the lease). Bumps claim_generation
 * so the ORIGINAL worker's in-flight completion is fenced when it finally lands.
 * Also the drain step of the rollback procedure. Returns count reconciled.
 *
 * A lease expiry IS a failed attempt, so it INCREMENTS attempts (otherwise a row
 * could bounce claimed→expired→retry→claimed forever, never dead-lettering).
 * After the increment, per row:
 *   - attempts >= MAX_ATTEMPTS  → dead   (exhausted; exhaustion wins over review)
 *   - ANY timeout (1st or later) → needs_review: a lease expiry means the remote
 *     status is UNKNOWN. We cannot verify whether any side effect already occurred,
 *     so we NEVER blind-retry on timeout — park for human review every time.
 *   Sets execution hold on EVERY lease expiry (first or later), because any
 *   timeout = uncertain = park + hold, always.
 */
function reconcileStaleClaims({ now = Date.now() } = {}) {
  const tx = db().transaction(() => {
    const rows = db().prepare(
      "SELECT * FROM bridge_lipa_inbox WHERE status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?"
    ).all(now);
    for (const r of rows) {
      const gen = (r.claim_generation || 0) + 1;   // fence the old session
      const attempts = (r.attempts || 0) + 1;      // a lease expiry is a failed attempt

      // The timed-out worker vanished mid-flight: it may have consumed provider
      // tokens we can never observe. Record the cost as UNKNOWN (cost_unknown=1,
      // cost_usd_lower_bound=NULL) so a timeout is never silently counted as $0 in
      // forensics. Best-effort so a cost-INSERT error can't roll back the reconcile.
      try {
        lipaAccounting.recordRequestCost({ inboxId: r.id, now });
      } catch (e) { console.error('[Lipa] reconcile cost accounting failed:', e.message); }

      if (attempts >= MAX_ATTEMPTS) {
        const errText = `lease expired — attempts exhausted (${attempts}/${MAX_ATTEMPTS})`;
        db().prepare("UPDATE bridge_lipa_inbox SET status = 'dead', attempts = ?, claim_generation = ?, lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ?")
          .run(attempts, gen, errText, now, r.id);
        logAttempt({ inboxId: r.id, attemptNumber: attempts, event: 'timeout', outcome: 'error',
          error: errText, claimGeneration: gen, finishedAt: now });
        // Even exhausted rows set a hold — we cannot verify what happened remotely.
        setExecutionHold(`lease expired & exhausted — session ${r.session_id || 'unknown'}, row ${r.id}`,
          { session_id: r.session_id || null, claimed_ids: [r.id] });
        continue;
      }

      // ANY timeout (first or later): uncertain side effect — park for human review.
      // Do NOT retry blindly: the remote may have already taken action.
      const errText = `lease expired — uncertain side effect after ${attempts} timeout(s) (needs review)`;
      db().prepare("UPDATE bridge_lipa_inbox SET status = 'needs_review', attempts = ?, claim_generation = ?, lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ?")
        .run(attempts, gen, errText, now, r.id);
      logAttempt({ inboxId: r.id, attemptNumber: attempts, event: 'needs_review', outcome: 'ignored',
        error: errText, claimGeneration: gen, finishedAt: now });
      // Set execution hold on EVERY lease expiry — any timeout = uncertain.
      setExecutionHold(`lease expired — session ${r.session_id || 'unknown'}, row ${r.id}, attempt ${attempts}`,
        { session_id: r.session_id || null, claimed_ids: [r.id] });
    }
    return rows.length;
  });
  return tx();
}

// ── stats ────────────────────────────────────────────────────────────────────

function getStats() {
  const rows = db().prepare('SELECT status, COUNT(*) AS c FROM bridge_lipa_inbox GROUP BY status').all();
  const stats = { pending: 0, retry: 0, claimed: 0, done: 0, needs_review: 0, dead: 0, paused: 0, total: 0 };
  for (const r of rows) { if (stats[r.status] != null) stats[r.status] = r.c; stats.total += r.c; }
  stats.circuit = getCircuit().state;
  return stats;
}

module.exports = {
  MAX_ATTEMPTS, BACKOFF_BASE_MS, LEASE_MS, MAX_ARGS_BYTES,
  isBillingError,
  getCircuit, isPaused, pauseCircuit, resumeCircuit,
  acquireWorkerLock, releaseWorkerLock,
  enqueueGuarded, argsByteLength, saveSplitProgress,
  getDueCount, claimDue, completeClaim, failClaim, reconcileStaleClaims,
  logAttempt, getStats,
  // Execution hold (shared with preflight wrapper)
  getExecutionHold, setExecutionHold, clearExecutionHold,
  accounting: lipaAccounting,
};
