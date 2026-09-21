'use strict';
/**
 * bridge-outbox.test.js — the outbox delivery lifecycle.
 *
 * UC-1: enqueue → claim → deliver moves a row through pending/claimed/delivered.
 * UC-2: a duplicate event_id is rejected (INSERT OR IGNORE, UNIQUE).
 * UC-3: a failed event gets exponential backoff (available_at grows per attempt).
 * UC-4: a row dead-letters after maxAttempts (default 8).
 * UC-5: getStats counts by status accurately (measured as a delta).
 *
 * All test rows use the TEST_OBX_ event_id prefix and are cleaned up, so the
 * suite is safe against the shared/live DB.
 */

const { initDB, getDB } = require('../../src/db');
const outbox = require('../../src/bridge/outboxRepository');
const bridgeConfig = require('../../src/bridge/config');

const PREFIX = 'TEST_OBX_';
const payloadFor = (n) => ({ kind: 'message', message_id: n, body: `hello ${n}` });

function cleanup(db) {
  db.prepare(`DELETE FROM bridge_outbox WHERE event_id LIKE '${PREFIX}%'`).run();
}

module.exports = {
  async run() {
    const errors = [];
    initDB();
    const db = getDB();
    cleanup(db);

    try {
      // ── UC-1: lifecycle ───────────────────────────────────────────────────
      const life = outbox.enqueueEvent(`${PREFIX}life`, 'message.created', 'test', payloadFor(1));
      if (!life.inserted) errors.push('UC-1: enqueue did not insert');

      const claimed = outbox.claimBatch(100);
      const mine = claimed.find(r => r.event_id === `${PREFIX}life`);
      if (!mine) errors.push('UC-1: claimBatch did not return the enqueued row');
      else {
        if (mine.status !== 'claimed') errors.push(`UC-1: claimed status is ${mine.status}`);
        if (!mine.payload || mine.payload.message_id !== 1) errors.push('UC-1: payload not parsed on claim');
        outbox.markDelivered(mine.id, 'prov-123');
        const row = db.prepare('SELECT status, delivered_at, provider_message_id FROM bridge_outbox WHERE id=?').get(mine.id);
        if (row.status !== 'delivered') errors.push(`UC-1: status after deliver is ${row.status}`);
        if (!row.delivered_at) errors.push('UC-1: delivered_at not set');
        if (row.provider_message_id !== 'prov-123') errors.push('UC-1: provider_message_id not stored');
      }

      // ── UC-2: duplicate event_id ──────────────────────────────────────────
      outbox.enqueueEvent(`${PREFIX}dup`, 'message.created', 'test', payloadFor(2));
      const dup = outbox.enqueueEvent(`${PREFIX}dup`, 'message.created', 'test', payloadFor(2));
      if (dup.inserted) errors.push('UC-2: duplicate event_id was inserted');
      const dupCount = db.prepare(`SELECT COUNT(*) c FROM bridge_outbox WHERE event_id=?`).get(`${PREFIX}dup`).c;
      if (dupCount !== 1) errors.push(`UC-2: expected 1 row for dup event_id, got ${dupCount}`);

      // ── UC-3: exponential backoff ─────────────────────────────────────────
      const bo = outbox.enqueueEvent(`${PREFIX}backoff`, 'message.created', 'test', payloadFor(3));
      const r1 = outbox.markFailed(bo.id, new Error('boom 1'));
      const r2 = outbox.markFailed(bo.id, new Error('boom 2'));
      if (r1.status !== 'pending' || r2.status !== 'pending') {
        errors.push(`UC-3: expected pending after early failures (got ${r1.status}/${r2.status})`);
      }
      if (!(r2.available_at > r1.available_at)) {
        errors.push(`UC-3: backoff did not grow (r1=${r1.available_at}, r2=${r2.available_at})`);
      }
      const boRow = db.prepare('SELECT attempts, last_error FROM bridge_outbox WHERE id=?').get(bo.id);
      if (boRow.attempts !== 2) errors.push(`UC-3: attempts should be 2, got ${boRow.attempts}`);
      if (!boRow.last_error) errors.push('UC-3: last_error not recorded');

      // ── UC-4: dead-letter after maxAttempts ───────────────────────────────
      const dl = outbox.enqueueEvent(`${PREFIX}dead`, 'message.created', 'test', payloadFor(4));
      let last;
      for (let i = 0; i < bridgeConfig.maxAttempts; i++) last = outbox.markFailed(dl.id, new Error(`fail ${i}`));
      if (last.status !== 'dead') errors.push(`UC-4: expected dead after ${bridgeConfig.maxAttempts} attempts, got ${last.status}`);
      const dlRow = db.prepare('SELECT status, attempts FROM bridge_outbox WHERE id=?').get(dl.id);
      if (dlRow.status !== 'dead') errors.push(`UC-4: row status is ${dlRow.status}`);
      if (dlRow.attempts !== bridgeConfig.maxAttempts) errors.push(`UC-4: attempts should be ${bridgeConfig.maxAttempts}, got ${dlRow.attempts}`);

      // ── UC-5: stats accuracy (delta) ──────────────────────────────────────
      const before = outbox.getStats();
      outbox.enqueueEvent(`${PREFIX}s1`, 'message.created', 'test', payloadFor(5));
      outbox.enqueueEvent(`${PREFIX}s2`, 'message.created', 'test', payloadFor(6));
      outbox.enqueueEvent(`${PREFIX}s3`, 'message.created', 'test', payloadFor(7));
      const after = outbox.getStats();
      if (after.pending - before.pending !== 3) {
        errors.push(`UC-5: pending delta should be 3, got ${after.pending - before.pending}`);
      }
      if (after.total - before.total !== 3) {
        errors.push(`UC-5: total delta should be 3, got ${after.total - before.total}`);
      }
      if (!(after.oldest_pending_age_ms >= 0)) errors.push('UC-5: oldest_pending_age_ms not a valid age');
    } finally {
      cleanup(db);
    }

    return errors.length === 0
      ? { pass: true, message: 'Outbox lifecycle, dedup, backoff, dead-letter, and stats all correct.' }
      : { pass: false, message: errors.join('\n         ') };
  },
};
