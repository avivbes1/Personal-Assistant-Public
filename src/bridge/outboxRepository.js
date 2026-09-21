'use strict';
/**
 * bridge/outboxRepository.js — durable outbox for the Instinct Bridge.
 *
 * The outbox is a transactional queue: hooks in db.js enqueue events, and the
 * exporter job claims batches, delivers them, and marks results. Delivery is
 * at-least-once with exponential backoff and a dead-letter terminal state after
 * maxAttempts. All multi-row state transitions run inside db.transaction() so a
 * crash mid-claim can't leave rows half-claimed.
 *
 * getDB() is required lazily (inside each function) to avoid a load-time cycle
 * with db.js, which requires this module from its enqueue hooks.
 */

const bridgeConfig = require('./config');
const { computePayloadHash, stableStringify } = require('./envelope');

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
 * Enqueue a single event. event_id is UNIQUE, so a duplicate is a no-op
 * (INSERT OR IGNORE). Returns {inserted, id}.
 */
function enqueueEvent(eventId, eventType, stream, payload) {
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
 * Atomically claim up to `limit` pending rows whose backoff has elapsed.
 * Returns the claimed rows, each with a parsed `payload`.
 */
function claimBatch(limit = bridgeConfig.batchSize) {
  const now = Date.now();
  const tx = db().transaction((lim) => {
    const rows = db().prepare(
      `SELECT * FROM bridge_outbox
        WHERE status = 'pending' AND available_at <= ?
        ORDER BY created_at ASC, id ASC
        LIMIT ?`
    ).all(now, lim);
    if (rows.length === 0) return [];
    const upd = db().prepare(
      `UPDATE bridge_outbox SET status = 'claimed', claimed_at = ?, updated_at = ? WHERE id = ?`
    );
    for (const r of rows) upd.run(now, now, r.id);
    return rows.map(r => ({ ...r, status: 'claimed', claimed_at: now, payload: safeParse(r.payload_json) }));
  });
  return tx(limit);
}

/** Mark a claimed row delivered. */
function markDelivered(id, providerMessageId) {
  const now = Date.now();
  db().prepare(
    `UPDATE bridge_outbox
        SET status = 'delivered', delivered_at = ?, provider_message_id = ?, last_error = NULL, updated_at = ?
      WHERE id = ?`
  ).run(now, providerMessageId || null, now, id);
}

/**
 * Record a delivery failure: increment attempts, and either schedule an
 * exponential-backoff retry or dead-letter the row once maxAttempts is reached.
 * Returns {status, attempts, available_at}.
 */
function markFailed(id, error) {
  const row = db().prepare('SELECT attempts FROM bridge_outbox WHERE id = ?').get(id);
  if (!row) return { status: 'missing', attempts: 0 };
  const attempts = (row.attempts || 0) + 1;
  const now = Date.now();
  const errText = truncateError(error);

  if (attempts >= bridgeConfig.maxAttempts) {
    db().prepare(
      `UPDATE bridge_outbox SET status = 'dead', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`
    ).run(attempts, errText, now, id);
    return { status: 'dead', attempts };
  }

  // 1st retry: base × 2^0, 2nd: base × 2^1, ... — a growing gap between tries.
  const backoff = bridgeConfig.backoffBaseMs * Math.pow(2, attempts - 1);
  const availableAt = now + backoff;
  db().prepare(
    `UPDATE bridge_outbox
        SET status = 'pending', attempts = ?, available_at = ?, last_error = ?, updated_at = ?
      WHERE id = ?`
  ).run(attempts, availableAt, errText, now, id);
  return { status: 'pending', attempts, available_at: availableAt };
}

/**
 * Counts by status plus the age of the oldest still-pending row. Used by the
 * /health/bridge endpoint.
 */
function getStats() {
  const rows = db().prepare('SELECT status, COUNT(*) AS c FROM bridge_outbox GROUP BY status').all();
  const stats = { pending: 0, claimed: 0, delivered: 0, dead: 0, total: 0 };
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
  getStats,
};
