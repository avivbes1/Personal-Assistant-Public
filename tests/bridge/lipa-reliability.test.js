'use strict';
/**
 * lipa-reliability.test.js — the Lipa Bridge durable worker layer.
 *
 * UC-1: ACTUAL billing rejection (402 / insufficient_credits) pauses the lane;
 *       isBillingError rejects a normal error; a paused lane reports 0 due.
 * UC-2: due-time gate — only rows with available_at <= now are claimable.
 * UC-3: fenced late completion — a completion arriving after the row was retried
 *       and re-claimed (newer generation) is IGNORED, not applied.
 * UC-4: write uncertainty — uncertain mutating work → needs_review, no outbox
 *       row, and it is NOT re-claimed.
 * UC-5: single global worker lock (second holder is refused while the first is live).
 * UC-6: max 3 attempts then dead-letter, with backoff growth.
 * UC-7: args guard rejects an oversized job instead of truncating it.
 * UC-8: attempt logging keeps cache read/write as SEPARATE fields; absent = NULL.
 *
 * All test rows use the TEST_LIPA_ request_id prefix; the circuit + worker-lock
 * control rows are snapshotted and restored, so the suite is safe on the shared DB.
 */

const { initDB, getDB } = require('../../src/db');
const { ensureLipaTables } = require('../../src/bridge/lipaLane');
const rel = require('../../src/bridge/lipaReliability');

const PREFIX = 'TEST_LIPA_';

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
    // failClaim now records an advisory cost on every failure/timeout, so clean
    // those rows too (they are keyed by inbox_id, deleted before the inbox rows).
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

module.exports = {
  async run() {
    const errors = [];
    initDB();
    ensureLipaTables();
    const db = getDB();
    const ids = [];
    const circuitSnap = snapshotState(db, 'circuit');
    const lockSnap = snapshotState(db, 'worker_lock');
    // Start from a clean, closed circuit for the test.
    db.prepare("DELETE FROM bridge_lipa_state WHERE key IN ('circuit','worker_lock')").run();

    try {
      // ── UC-1: actual billing rejection pauses the lane ──────────────────────
      if (rel.isBillingError(new Error('some transient network blip'))) errors.push('UC-1: normal error misclassified as billing');
      if (!rel.isBillingError({ status: 402 })) errors.push('UC-1: 402 not detected as billing');
      if (!rel.isBillingError(new Error('insufficient_credits: balance too low'))) errors.push('UC-1: insufficient_credits not detected');

      const bId = enqueue('billing'); ids.push(bId);
      const bClaim = rel.claimDue({ limit: 10, sessionId: 'sess-b' });
      const bRow = bClaim.rows.find(r => r.id === bId);
      if (!bRow) errors.push('UC-1: billing row not claimed');
      else {
        const r = rel.failClaim({ inboxId: bId, claimGeneration: bRow.claim_generation, sessionId: 'sess-b', error: { status: 402, message: 'insufficient_credits' } });
        if (!r.paused) errors.push('UC-1: 402 failure did not pause');
        if (!rel.isPaused()) errors.push('UC-1: circuit not open after billing error');
        const row = db.prepare('SELECT status, attempts FROM bridge_lipa_inbox WHERE id=?').get(bId);
        if (row.status !== 'retry') errors.push(`UC-1: billing row status is ${row.status}, expected retry (held)`);
        if (row.attempts !== 0) errors.push(`UC-1: billing error wrongly counted against attempts (${row.attempts})`);
        if (rel.getDueCount() !== 0) errors.push('UC-1: paused lane still reports due work');
      }
      rel.resumeCircuit();
      if (rel.isPaused()) errors.push('UC-1: resume did not close circuit');

      // ── UC-2: due-time gate ─────────────────────────────────────────────────
      const dId = enqueue('due'); ids.push(dId);
      const future = Date.now() + 60 * 60 * 1000;
      db.prepare('UPDATE bridge_lipa_inbox SET available_at=? WHERE id=?').run(future, dId);
      const notDue = rel.claimDue({ limit: 50, sessionId: 'sess-d' }).rows.find(r => r.id === dId);
      if (notDue) errors.push('UC-2: not-yet-due row was claimed');
      db.prepare('UPDATE bridge_lipa_inbox SET available_at=? WHERE id=?').run(Date.now() - 1000, dId);
      const nowDue = rel.claimDue({ limit: 50, sessionId: 'sess-d' }).rows.find(r => r.id === dId);
      if (!nowDue) errors.push('UC-2: due row was not claimed once available_at <= now');

      // ── UC-3: fenced late completion (completion after non-timeout retry) ────
      // Uses a non-timeout failure (isTimeout=false) to trigger retry, since
      // timeouts now park immediately to needs_review.
      const fId = enqueue('fence'); ids.push(fId);
      const c1 = rel.claimDue({ limit: 50, sessionId: 'sess-f1' }).rows.find(r => r.id === fId);
      const gen1 = c1.claim_generation;
      rel.failClaim({ inboxId: fId, claimGeneration: gen1, sessionId: 'sess-f1', error: new Error('transient delivery error'), isTimeout: false });
      db.prepare('UPDATE bridge_lipa_inbox SET available_at=? WHERE id=?').run(Date.now() - 1, fId);   // make retry due now
      const c2 = rel.claimDue({ limit: 50, sessionId: 'sess-f2' }).rows.find(r => r.id === fId);
      if (!c2 || c2.claim_generation === gen1) errors.push('UC-3: re-claim did not bump generation');
      // The ORIGINAL worker (gen1) finally lands its completion — must be fenced.
      const late = rel.completeClaim({ inboxId: fId, claimGeneration: gen1, sessionId: 'sess-f1', response: { ok: true } });
      if (!late.fenced) errors.push('UC-3: stale completion was NOT fenced');
      const outboxCount = db.prepare('SELECT COUNT(*) c FROM bridge_lipa_outbox WHERE inbox_id=?').get(fId).c;
      if (outboxCount !== 0) errors.push('UC-3: fenced completion wrote an outbox row anyway');
      const fenceLog = db.prepare("SELECT COUNT(*) c FROM bridge_lipa_attempts WHERE inbox_id=? AND event='fenced'").get(fId).c;
      if (fenceLog < 1) errors.push('UC-3: fenced event not logged');
      // The live worker (gen2) can still complete normally.
      const good = rel.completeClaim({ inboxId: fId, claimGeneration: c2.claim_generation, sessionId: 'sess-f2', response: { ok: true } });
      if (!good.done) errors.push('UC-3: live worker completion did not succeed');

      // ── UC-4: write uncertainty → needs_review, no send, no retry ───────────
      const uId = enqueue('uncertain'); ids.push(uId);
      const uc = rel.claimDue({ limit: 50, sessionId: 'sess-u' }).rows.find(r => r.id === uId);
      const ur = rel.completeClaim({ inboxId: uId, claimGeneration: uc.claim_generation, sessionId: 'sess-u',
        uncertain: true, uncertainReason: 'may have already created the calendar event' });
      if (!ur.needsReview) errors.push('UC-4: uncertain work did not route to needs_review');
      const uRow = db.prepare('SELECT status FROM bridge_lipa_inbox WHERE id=?').get(uId);
      if (uRow.status !== 'needs_review') errors.push(`UC-4: status is ${uRow.status}, expected needs_review`);
      if (db.prepare('SELECT COUNT(*) c FROM bridge_lipa_outbox WHERE inbox_id=?').get(uId).c !== 0) errors.push('UC-4: needs_review wrote an outbox row');
      db.prepare('UPDATE bridge_lipa_inbox SET available_at=? WHERE id=?').run(Date.now() - 1, uId);
      if (rel.claimDue({ limit: 50, sessionId: 'sess-u2' }).rows.find(r => r.id === uId)) errors.push('UC-4: needs_review row was blindly re-claimed');

      // ── UC-5: single global worker lock ─────────────────────────────────────
      if (!rel.acquireWorkerLock('worker-A')) errors.push('UC-5: first worker could not acquire lock');
      if (rel.acquireWorkerLock('worker-B')) errors.push('UC-5: second worker acquired a live lock');
      rel.releaseWorkerLock('worker-A');
      if (!rel.acquireWorkerLock('worker-B')) errors.push('UC-5: lock not free after release');
      rel.releaseWorkerLock('worker-B');

      // ── UC-6: max 3 attempts → dead, backoff grows ──────────────────────────
      const mId = enqueue('max'); ids.push(mId);
      let last, prevAvail = 0;
      for (let i = 0; i < rel.MAX_ATTEMPTS; i++) {
        db.prepare('UPDATE bridge_lipa_inbox SET available_at=? WHERE id=?').run(Date.now() - 1, mId);
        const c = rel.claimDue({ limit: 50, sessionId: 'sess-m' }).rows.find(r => r.id === mId);
        if (!c) { errors.push(`UC-6: could not claim on attempt ${i}`); break; }
        last = rel.failClaim({ inboxId: mId, claimGeneration: c.claim_generation, sessionId: 'sess-m', error: new Error('boom ' + i) });
        if (last.status === 'retry') { if (!(last.available_at > prevAvail)) errors.push('UC-6: backoff did not grow'); prevAvail = last.available_at; }
      }
      if (!last || last.status !== 'dead') errors.push(`UC-6: expected dead after ${rel.MAX_ATTEMPTS} attempts, got ${last && last.status}`);
      const mRow = db.prepare('SELECT status, attempts FROM bridge_lipa_inbox WHERE id=?').get(mId);
      if (mRow.attempts !== rel.MAX_ATTEMPTS) errors.push(`UC-6: attempts ${mRow.attempts} != ${rel.MAX_ATTEMPTS}`);

      // ── UC-7: oversized args rejected, not truncated ────────────────────────
      const big = 'x'.repeat(rel.MAX_ARGS_BYTES + 100);
      const rej = rel.enqueueGuarded({ requestId: PREFIX + 'big', command: 'noop', args: { blob: big } });
      if (rej.inserted || !rej.rejected) errors.push('UC-7: oversized job was not rejected');
      if (db.prepare(`SELECT COUNT(*) c FROM bridge_lipa_inbox WHERE request_id=?`).get(PREFIX + 'big').c !== 0) errors.push('UC-7: rejected job left a row');

      // ── UC-8: cache read/write tokens are SEPARATE; absent = NULL (unknown) ──
      const tId = enqueue('tokens'); ids.push(tId);
      const tc = rel.claimDue({ limit: 50, sessionId: 'sess-t' }).rows.find(r => r.id === tId);
      rel.completeClaim({ inboxId: tId, claimGeneration: tc.claim_generation, sessionId: 'sess-t',
        response: { ok: true }, providerMessageId: 'prov-xyz', cacheReadTokens: 5 /* cacheWriteTokens omitted */ });
      const att = db.prepare("SELECT cache_read_tokens, cache_write_tokens, provider_message_id FROM bridge_lipa_attempts WHERE inbox_id=? AND event='deliver'").get(tId);
      if (!att || att.cache_read_tokens !== 5) errors.push('UC-8: cache_read_tokens not recorded');
      if (!att || att.cache_write_tokens !== null) errors.push('UC-8: absent cache_write_tokens should be NULL (unknown)');
      if (!att || att.provider_message_id !== 'prov-xyz') errors.push('UC-8: provider_message_id not tracked');
    } finally {
      cleanup(db, ids);
      restoreState(db, 'circuit', circuitSnap);
      restoreState(db, 'worker_lock', lockSnap);
    }

    return errors.length === 0
      ? { pass: true, message: 'Lipa reliability: billing breaker, due-gate, fencing, needs_review, lock, max-attempts, args-guard, token logging all correct.' }
      : { pass: false, message: errors.join('\n         ') };
  },
};
