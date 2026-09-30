'use strict';
/**
 * bridge/outboxRepository.js — durable outbox for the Instinct Bridge.
 *
 * The outbox is a transactional queue: hooks in db.js enqueue events, and the
 * exporter job claims batches, delivers them, and marks results. Delivery is
 * at-least-once with jittered exponential backoff and a dead-letter terminal
 * state after maxAttempts. All multi-row state transitions run inside
 * db.transaction() so a crash mid-claim can't leave rows half-claimed.
 *
 * Fencing: every claim stamps the row with a monotonic claim_generation (the
 * claim timestamp). A completion (deliver/fail/needs_review) that carries a
 * stale generation — because another cycle re-claimed the row in between — is
 * rejected, so a late-arriving completion can never corrupt a re-claimed row.
 *
 * getDB() is required lazily (inside each function) to avoid a load-time cycle
 * with db.js, which requires this module from its enqueue hooks.
 */

const bridgeConfig = require('./config');
const { computePayloadHash, stableStringify } = require('./envelope');

// Reject oversized payloads outright rather than silently truncating. 256 KiB.
const MAX_PAYLOAD_BYTES = 256 * 1024;

// Statuses that are eligible to be (re)claimed by the exporter when due. Note
// that 'needs_review' is deliberately absent — those rows are parked for a human
// and must never be auto-retried.
const CLAIMABLE_STATUSES = ['pending', 'retry'];

function db() {
  return require('../db').getDB();
}

function truncateError(err) {
  const msg = err == null ? null : (err.message || String(err));
  return msg ? msg.slice(0, 500) : null;
}

function safeParse(json) {
  try { return JSON.parse(json); } catch (_) { return null; }
}

/**
 * Record one attempt-lifecycle event for an outbox row (claim | deliver | fail |
 * needs_review). Best-effort and never throws into the caller — attempt logging
 * must not be able to break delivery. Token fields are null (unknown) for now.
 */
function recordAttempt(outboxId, attemptNumber, status, opts = {}) {
  try {
    const now = Date.now();
    db().prepare(
      `INSERT INTO bridge_outbox_attempts
         (outbox_id, attempt_number, status, error, provider_message_id,
          started_at, finished_at, cache_read_tokens, cache_write_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
    ).run(
      outboxId,
      attemptNumber,
      status,
      opts.error != null ? truncateError(opts.error) : null,
      opts.providerMessageId || null,
      opts.startedAt != null ? opts.startedAt : now,
      opts.finishedAt != null ? opts.finishedAt : now
    );
  } catch (err) {
    console.warn('[Bridge] recordAttempt failed (non-fatal):', err.message);
  }
}

/**
 * Enqueue a single event. event_id is UNIQUE, so a duplicate is a no-op
 * (INSERT OR IGNORE). Payloads whose JSON exceeds MAX_PAYLOAD_BYTES are rejected
 * (never truncated). Returns {inserted, id} or {inserted:false, rejected, bytes}.
 */
function enqueueEvent(eventId, eventType, stream, payload) {
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (bytes > MAX_PAYLOAD_BYTES) {
    console.warn(
      `[Bridge] enqueue REJECTED — payload ${bytes} bytes exceeds ${MAX_PAYLOAD_BYTES} ` +
      `limit (event_id=${eventId}); not enqueued.`
    );
    return { inserted: false, rejected: 'payload_too_large', bytes };
  }

  const now = Date.now();
  const json = stableStringify(payload);
  const hash = computePayloadHash(payload);
  const res = db().prepare(
    `INSERT OR IGNORE INTO bridge_outbox
       (event_id, event_type, stream, payload_json, payload_hash, status, attempts, available_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`
  ).run(eventId, eventType, stream || bridgeConfig.stream, json, hash, now, now, now);
  return { inserted: res.changes > 0, id: res.changes > 0 ? res.lastInsertRowid : null };
}

/**
 * Atomically claim up to `limit` claimable rows (pending or retry) whose backoff
 * has elapsed (available_at <= now). Each claim stamps a fresh claim_generation
 * and logs a 'claim' attempt. Returns the claimed rows, each with a parsed
 * `payload` and its claim_generation.
 */
function claimBatch(limit = bridgeConfig.batchSize) {
  const now = Date.now();
  const placeholders = CLAIMABLE_STATUSES.map(() => '?').join(', ');
  const tx = db().transaction((lim) => {
    const rows = db().prepare(
      `SELECT * FROM bridge_outbox
        WHERE status IN (${placeholders}) AND available_at <= ?
        ORDER BY created_at ASC, id ASC
        LIMIT ?`
    ).all(...CLAIMABLE_STATUSES, now, lim);
    if (rows.length === 0) return [];
    const upd = db().prepare(
      `UPDATE bridge_outbox
          SET status = 'claimed', claimed_at = ?, claim_generation = ?, updated_at = ?
        WHERE id = ?`
    );
    for (const r of rows) {
      upd.run(now, now, now, r.id);
      recordAttempt(r.id, (r.attempts || 0) + 1, 'claim', { startedAt: now, finishedAt: now });
    }
    return rows.map(r => ({
      ...r,
      status: 'claimed',
      claimed_at: now,
      claim_generation: now,
      payload: safeParse(r.payload_json),
    }));
  });
  return tx(limit);
}

/**
 * True when `expectedGeneration` is provided and no longer matches the row's
 * current claim_generation — i.e. the row was re-claimed by a newer cycle and
 * this completion is stale. When expectedGeneration is null/undefined the check
 * is skipped (callers that don't participate in fencing, and existing tests).
 */
function isStale(row, expectedGeneration) {
  if (expectedGeneration == null) return false;
  return Number(row.claim_generation) !== Number(expectedGeneration);
}

/** Mark a claimed row delivered. Rejects a stale completion (fencing). */
function markDelivered(id, providerMessageId, expectedGeneration = null) {
  const row = db().prepare('SELECT attempts, claim_generation FROM bridge_outbox WHERE id = ?').get(id);
  if (!row) return { status: 'missing' };
  if (isStale(row, expectedGeneration)) {
    console.warn(
      `[Bridge] markDelivered SKIPPED — stale generation for row ${id} ` +
      `(expected ${expectedGeneration}, current ${row.claim_generation}); row was re-claimed.`
    );
    return { status: 'stale', skipped: true };
  }
  const now = Date.now();
  db().prepare(
    `UPDATE bridge_outbox
        SET status = 'delivered', delivered_at = ?, provider_message_id = ?, last_error = NULL, updated_at = ?
      WHERE id = ?`
  ).run(now, providerMessageId || null, now, id);
  recordAttempt(id, (row.attempts || 0) + 1, 'deliver', { providerMessageId, finishedAt: now });
  return { status: 'delivered' };
}

/**
 * Record a delivery failure: increment attempts, and either schedule a
 * jittered exponential-backoff retry or dead-letter the row once maxAttempts is
 * reached. Rejects a stale completion (fencing). Returns {status, attempts,
 * available_at}. Retries keep status 'pending' for backward compatibility.
 */
function markFailed(id, error, expectedGeneration = null) {
  const row = db().prepare('SELECT attempts, claim_generation FROM bridge_outbox WHERE id = ?').get(id);
  if (!row) return { status: 'missing', attempts: 0 };
  if (isStale(row, expectedGeneration)) {
    console.warn(
      `[Bridge] markFailed SKIPPED — stale generation for row ${id} ` +
      `(expected ${expectedGeneration}, current ${row.claim_generation}); row was re-claimed.`
    );
    return { status: 'stale', skipped: true };
  }
  const attempts = (row.attempts || 0) + 1;
  const now = Date.now();
  const errText = truncateError(error);

  if (attempts >= bridgeConfig.maxAttempts) {
    db().prepare(
      `UPDATE bridge_outbox SET status = 'dead', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`
    ).run(attempts, errText, now, id);
    recordAttempt(id, attempts, 'fail', { error, finishedAt: now });
    return { status: 'dead', attempts };
  }

  // Jittered exponential backoff: base × 2^(attempt-1) × (0.5 + rand×0.5). The
  // jitter (a factor in [0.5, 1.0)) de-synchronises retries so a batch that
  // failed together doesn't stampede the transport at the same instant.
  const backoff = bridgeConfig.backoffBaseMs * Math.pow(2, attempts - 1) * (0.5 + Math.random() * 0.5);
  const availableAt = now + Math.round(backoff);
  db().prepare(
    `UPDATE bridge_outbox
        SET status = 'pending', attempts = ?, available_at = ?, last_error = ?, updated_at = ?
      WHERE id = ?`
  ).run(attempts, availableAt, errText, now, id);
  recordAttempt(id, attempts, 'fail', { error, finishedAt: now });
  return { status: 'pending', attempts, available_at: availableAt };
}

/**
 * Park a claimed row for human review instead of retrying it — used when a send
 * completed ambiguously (e.g. transport timed out after possibly being accepted)
 * and a blind retry risks a duplicate. needs_review rows are never auto-claimed.
 * Rejects a stale completion (fencing). Does not consume an attempt.
 */
function markNeedsReview(id, reason, expectedGeneration = null) {
  const row = db().prepare('SELECT attempts, claim_generation FROM bridge_outbox WHERE id = ?').get(id);
  if (!row) return { status: 'missing' };
  if (isStale(row, expectedGeneration)) {
    console.warn(
      `[Bridge] markNeedsReview SKIPPED — stale generation for row ${id} ` +
      `(expected ${expectedGeneration}, current ${row.claim_generation}); row was re-claimed.`
    );
    return { status: 'stale', skipped: true };
  }
  const now = Date.now();
  db().prepare(
    `UPDATE bridge_outbox SET status = 'needs_review', last_error = ?, updated_at = ? WHERE id = ?`
  ).run(truncateError(reason), now, id);
  recordAttempt(id, (row.attempts || 0) + 1, 'needs_review', { error: reason, finishedAt: now });
  return { status: 'needs_review' };
}

/**
 * Release a claimed row back to the queue WITHOUT consuming an attempt — used
 * when a send was skipped for reasons that aren't the row's fault (billing
 * paused). The row becomes immediately claimable again. Rejects a stale release.
 */
function releaseClaim(id, expectedGeneration = null) {
  const row = db().prepare('SELECT claim_generation FROM bridge_outbox WHERE id = ?').get(id);
  if (!row) return { status: 'missing' };
  if (isStale(row, expectedGeneration)) return { status: 'stale', skipped: true };
  const now = Date.now();
  db().prepare(
    `UPDATE bridge_outbox SET status = 'pending', available_at = ?, updated_at = ? WHERE id = ?`
  ).run(now, now, id);
  return { status: 'pending' };
}

/**
 * Counts by status plus the age of the oldest still-pending row. Used by the
 * /health/bridge endpoint.
 */
function getStats() {
  const rows = db().prepare('SELECT status, COUNT(*) AS c FROM bridge_outbox GROUP BY status').all();
  const stats = { pending: 0, retry: 0, claimed: 0, delivered: 0, needs_review: 0, dead: 0, total: 0 };
  for (const r of rows) {
    if (stats[r.status] != null) stats[r.status] = r.c;
    stats.total += r.c;
  }
  const oldest = db().prepare(
    "SELECT MIN(created_at) AS m FROM bridge_outbox WHERE status = 'pending'"
  ).get();
  stats.oldest_pending_age_ms = oldest && oldest.m ? Date.now() - oldest.m : 0;
  return stats;
}

module.exports = {
  enqueueEvent,
  claimBatch,
  markDelivered,
  markFailed,
  markNeedsReview,
  releaseClaim,
  getStats,
  recordAttempt,
  MAX_PAYLOAD_BYTES,
};
