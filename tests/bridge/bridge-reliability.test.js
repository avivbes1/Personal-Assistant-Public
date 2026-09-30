'use strict';
/**
 * bridge-reliability.test.js — the outbox reliability patch.
 *
 * T1: billing_paused skips the send and logs a warning.
 * T2: billing_paused persists across cycles (file-backed).
 * T3: due-time gate — rows with a future available_at are not claimed.
 * T4: claim_generation fencing — a stale markDelivered (wrong gen) is rejected.
 * T5: claim_generation fencing — a stale markFailed (wrong gen) is rejected.
 * T6: needs_review rows are never auto-claimed by claimBatch.
 * T7: a payload larger than 256 KB is rejected by enqueueEvent.
 * T8: attempt logging records each attempt with the correct attempt_number.
 *
 * All test rows use the TEST_REL_ event_id prefix and are cleaned up (along with
 * their attempt rows and the isolated billing-state file), so the suite is safe
 * against the shared/live DB. Follows the pattern in bridge-outbox.test.js.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

// Isolate the billing-state file BEFORE anything reads it, so we never touch
// the real data/bridge-state.json. billingState resolves this env on each call.
const STATE_FILE = path.join(os.tmpdir(), 'TEST_REL_bridge-state.json');
process.env.INSTINCT_BRIDGE_STATE_PATH = STATE_FILE;

const { initDB, getDB } = require('../../src/db');
const outbox = require('../../src/bridge/outboxRepository');
const bridgeConfig = require('../../src/bridge/config');
const billingState = require('../../src/bridge/billingState');
const { sendBatch } = require('../../src/bridge/emailTransport');
const { buildEnvelope } = require('../../src/bridge/envelope');

const PREFIX = 'TEST_REL_';
const payloadFor = (n) => ({ kind: 'message', message_id: n, body: `hello ${n}` });

function cleanup(db) {
  db.prepare(
    `DELETE FROM bridge_outbox_attempts
      WHERE outbox_id IN (SELECT id FROM bridge_outbox WHERE event_id LIKE '${PREFIX}%')`
  ).run();
  db.prepare(`DELETE FROM bridge_outbox WHERE event_id LIKE '${PREFIX}%'`).run();
  try { billingState.unpauseBilling(); } catch (_) {}
  try { fs.unlinkSync(STATE_FILE); } catch (_) {}
}

function attemptsFor(db, outboxId) {
  return db.prepare(
    'SELECT attempt_number, status FROM bridge_outbox_attempts WHERE outbox_id = ? ORDER BY id ASC'
  ).all(outboxId);
}

module.exports = {
  async run() {
    const errors = [];
    initDB();
    const db = getDB();
    cleanup(db);

    try {
      // ── T1: billing_paused skips send and logs a warning ──────────────────
      {
        billingState.pauseBilling(new Error('SES AccountSendingPausedException'));
        const warnings = [];
        const origWarn = console.warn;
        console.warn = (...a) => { warnings.push(a.join(' ')); };
        let result;
        try {
          result = await sendBatch(buildEnvelope('test', [payloadFor(1)]));
        } finally {
          console.warn = origWarn;
        }
        if (!result || result.ok !== false || result.skipped !== 'billing_paused') {
          errors.push(`T1: expected skipped billing_paused result, got ${JSON.stringify(result)}`);
        }
        if (!warnings.some(w => /billing paused/i.test(w))) {
          errors.push('T1: expected a "billing paused" warning to be logged');
        }
      }

      // ── T2: billing_paused persists across cycles ─────────────────────────
      {
        // Already paused from T1. A fresh read (new "cycle") still sees paused,
        // and the state is durable on disk.
        if (!billingState.isBillingPaused()) errors.push('T2: pause did not persist to a second read');
        const r1 = await sendBatch(buildEnvelope('test', [payloadFor(2)]));
        const r2 = await sendBatch(buildEnvelope('test', [payloadFor(2)]));
        if (r1.skipped !== 'billing_paused' || r2.skipped !== 'billing_paused') {
          errors.push('T2: two consecutive cycles did not both skip while paused');
        }
        const onDisk = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (onDisk.billing_paused !== true) errors.push('T2: state file does not persist billing_paused=true');
        billingState.unpauseBilling();
        if (billingState.isBillingPaused()) errors.push('T2: unpause did not clear the breaker');
      }

      // ── T3: due-time gate — future available_at is NOT claimed ────────────
      {
        const future = outbox.enqueueEvent(`${PREFIX}future`, 'message.created', 'test', payloadFor(3));
        const due = outbox.enqueueEvent(`${PREFIX}due`, 'message.created', 'test', payloadFor(3));
        db.prepare('UPDATE bridge_outbox SET available_at = ? WHERE id = ?')
          .run(Date.now() + 3600000, future.id);
        const claimed = outbox.claimBatch(100);
        const ids = new Set(claimed.map(r => r.id));
        if (ids.has(future.id)) errors.push('T3: a row with a future available_at was claimed');
        if (!ids.has(due.id)) errors.push('T3: a due row was not claimed');
        const futureStatus = db.prepare('SELECT status FROM bridge_outbox WHERE id = ?').get(future.id).status;
        if (futureStatus !== 'pending') errors.push(`T3: future row status changed to ${futureStatus}`);
      }

      // ── T4: fencing — stale markDelivered rejected ────────────────────────
      {
        const e = outbox.enqueueEvent(`${PREFIX}fence_d`, 'message.created', 'test', payloadFor(4));
        const claimed = outbox.claimBatch(100);
        const mine = claimed.find(r => r.id === e.id);
        if (!mine) errors.push('T4: setup — row not claimed');
        else {
          const gen = mine.claim_generation;
          // Simulate another cycle re-claiming (new generation).
          db.prepare('UPDATE bridge_outbox SET claim_generation = ? WHERE id = ?').run(gen + 1000, e.id);
          const r = outbox.markDelivered(e.id, 'stale-prov', gen);
          if (r.status !== 'stale') errors.push(`T4: stale markDelivered not rejected (got ${r.status})`);
          const row = db.prepare('SELECT status, delivered_at FROM bridge_outbox WHERE id = ?').get(e.id);
          if (row.status === 'delivered' || row.delivered_at) {
            errors.push('T4: stale markDelivered corrupted the re-claimed row');
          }
        }
      }

      // ── T5: fencing — stale markFailed rejected ───────────────────────────
      {
        const e = outbox.enqueueEvent(`${PREFIX}fence_f`, 'message.created', 'test', payloadFor(5));
        const claimed = outbox.claimBatch(100);
        const mine = claimed.find(r => r.id === e.id);
        if (!mine) errors.push('T5: setup — row not claimed');
        else {
          const gen = mine.claim_generation;
          db.prepare('UPDATE bridge_outbox SET claim_generation = ? WHERE id = ?').run(gen + 1000, e.id);
          const r = outbox.markFailed(e.id, new Error('stale fail'), gen);
          if (r.status !== 'stale') errors.push(`T5: stale markFailed not rejected (got ${r.status})`);
          const row = db.prepare('SELECT attempts FROM bridge_outbox WHERE id = ?').get(e.id);
          if (row.attempts !== 0) errors.push(`T5: stale markFailed incremented attempts to ${row.attempts}`);
        }
      }

      // ── T6: needs_review is not auto-claimed ──────────────────────────────
      {
        const e = outbox.enqueueEvent(`${PREFIX}nr`, 'message.created', 'test', payloadFor(6));
        db.prepare("UPDATE bridge_outbox SET status = 'needs_review', available_at = 0 WHERE id = ?").run(e.id);
        const claimed = outbox.claimBatch(100);
        if (claimed.some(r => r.id === e.id)) errors.push('T6: a needs_review row was claimed by claimBatch');
        const status = db.prepare('SELECT status FROM bridge_outbox WHERE id = ?').get(e.id).status;
        if (status !== 'needs_review') errors.push(`T6: needs_review row status changed to ${status}`);
      }

      // ── T7: oversized payload rejected ────────────────────────────────────
      {
        const big = { kind: 'message', message_id: 7, body: 'x'.repeat(300 * 1024) };
        const res = outbox.enqueueEvent(`${PREFIX}big`, 'message.created', 'test', big);
        if (res.inserted) errors.push('T7: oversized payload was inserted');
        if (res.rejected !== 'payload_too_large') errors.push(`T7: rejected reason is ${res.rejected}`);
        if (!(res.bytes > 256 * 1024)) errors.push(`T7: reported bytes ${res.bytes} not over the limit`);
        const cnt = db.prepare(`SELECT COUNT(*) c FROM bridge_outbox WHERE event_id = ?`).get(`${PREFIX}big`).c;
        if (cnt !== 0) errors.push('T7: oversized row present in DB despite rejection');
      }

      // ── T8: attempt logging with correct attempt_number ───────────────────
      {
        const e = outbox.enqueueEvent(`${PREFIX}att`, 'message.created', 'test', payloadFor(8));

        // First attempt: claim → fail.
        let claimed = outbox.claimBatch(100);
        let mine = claimed.find(r => r.id === e.id);
        if (!mine) errors.push('T8: setup — row not claimed on first attempt');
        const gen1 = mine && mine.claim_generation;
        const fr = outbox.markFailed(e.id, new Error('boom'), gen1);
        if (fr.status !== 'pending') errors.push(`T8: first failure should schedule a retry (got ${fr.status})`);

        // Second attempt: re-claim (make it due first) → deliver.
        db.prepare('UPDATE bridge_outbox SET available_at = 0 WHERE id = ?').run(e.id);
        claimed = outbox.claimBatch(100);
        mine = claimed.find(r => r.id === e.id);
        if (!mine) errors.push('T8: setup — row not re-claimed on second attempt');
        const gen2 = mine && mine.claim_generation;
        const dr = outbox.markDelivered(e.id, 'prov-8', gen2);
        if (dr.status !== 'delivered') errors.push(`T8: second attempt should deliver (got ${dr.status})`);

        const rows = attemptsFor(db, e.id);
        const shape = rows.map(r => `${r.status}#${r.attempt_number}`).join(',');
        const expected = 'claim#1,fail#1,claim#2,deliver#2';
        if (shape !== expected) errors.push(`T8: attempt log shape is "${shape}", expected "${expected}"`);
      }
    } finally {
      cleanup(db);
    }

    return errors.length === 0
      ? { pass: true, message: 'Billing circuit, due-time gate, fencing, needs_review, payload cap, and attempt logging all correct.' }
      : { pass: false, message: errors.join('\n         ') };
  },
};
