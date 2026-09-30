'use strict';
/**
 * lipa-worker.test.js — end-to-end behavior of the Lipa Bridge worker layer.
 *
 * Exercises the durable-worker contract in src/bridge/lipaReliability.js +
 * src/bridge/lipaAccounting.js, with emphasis on the corrections that wired cost
 * accounting into EVERY terminal path (failure + timeout, not just success):
 *
 * T1  race to claim         two workers/arrivals contend; the global lock refuses
 *                           the second, and the atomic claim hands one row to one.
 * T2  duplicate enqueue     same request_id inserts once; NULL request_id never dedups.
 * T3  lease expiry (live)   ANY timeout → needs_review (never retry), gen bumped,
 *                           and an UNKNOWN cost row is recorded for the lost attempt.
 * T4  cancellation          confirmed → done + outbox; unknown → needs_review, no send.
 * T5  late side effect      the original worker's completion after reconcile is fenced
 *                           (no outbox); its tokens are still logged for forensics.
 * T6  restart lock          held across the turn, released by respond, and an EXPIRED
 *                           lock is stealable (WORKER_LOCK_TTL crash safety net).
 * T7  exhausted timeout     3rd lease expiry → dead (not needs_review); unknown cost.
 * T8  exhausted failure     failClaim at MAX_ATTEMPTS → dead (not retry); cost recorded
 *                           with the tokens the doomed attempt consumed.
 * T9  cost on fail/retry    a non-terminal failClaim records cost — a lower bound when
 *                           tokens are known, cost_unknown=1 when they are not.
 * T10 empty cycle safe      getDueCount ignores future rows and a paused lane; an empty
 *                           claim releases the lock; there is NO launch counter at all.
 * T11 daily cap             checkDailyCap blocks new launches once spend >= $20.
 * T12 per-request cap       flags an over-$2 request but the response is still delivered.
 *
 * All rows use the TEST_LIPA_WK_ request_id prefix; circuit + worker-lock control
 * rows are snapshotted and restored, and cost/attempt/outbox rows are cleaned by
 * inbox_id, so the suite is safe on the shared/live DB. Mirrors the run() harness
 * convention used by tests/run-all.js (no jest globals).
 */

const { initDB, getDB } = require('../../src/db');
const { ensureLipaTables } = require('../../src/bridge/lipaLane');
const rel = require('../../src/bridge/lipaReliability');
const accounting = require('../../src/bridge/lipaAccounting');

const PREFIX = 'TEST_LIPA_WK_';

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
/** Claim a specific row by id (high limit so it is included among any due rows). */
function claimRow(db, id, sessionId) {
  return rel.claimDue({ limit: 100, sessionId }).rows.find(r => r.id === id);
}
function costRows(db, id) {
  return db.prepare('SELECT cost_usd_lower_bound, cost_unknown FROM bridge_lipa_costs WHERE inbox_id = ? ORDER BY id').all(id);
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
    db.prepare("DELETE FROM bridge_lipa_state WHERE key IN ('circuit','worker_lock')").run();

    try {
      // ── T1: race to claim — lock refuses the 2nd worker; claim is atomic ─────
      {
        const id = enqueue('t1'); ids.push(id);
        if (!rel.acquireWorkerLock('wk-A')) errors.push('T1: worker A could not acquire the lock');
        // Two workers race for the same due row: exactly one wins the atomic claim.
        const first = rel.claimDue({ limit: 100, sessionId: 'wk-A' }).rows.find(r => r.id === id);
        if (!first) errors.push('T1: worker A did not claim its row');
        const second = rel.claimDue({ limit: 100, sessionId: 'wk-B' }).rows.find(r => r.id === id);
        if (second) errors.push('T1: two workers both claimed the same row (claim not atomic)');
        // And the global worker lock refuses B while A holds it.
        if (rel.acquireWorkerLock('wk-B')) errors.push('T1: worker B acquired the lock while A holds it');
        rel.releaseWorkerLock('wk-A');
      }

      // ── T2: duplicate enqueue is deduped on request_id ──────────────────────
      {
        const first = rel.enqueueGuarded({ requestId: PREFIX + 't2', command: 'noop', args: { n: 1 } });
        const second = rel.enqueueGuarded({ requestId: PREFIX + 't2', command: 'noop', args: { n: 2 } });
        if (first.id) ids.push(first.id);
        if (!first.inserted) errors.push('T2: first enqueue was not inserted');
        if (second.inserted) errors.push('T2: duplicate enqueue was inserted again');
        if (!second.duplicate) errors.push('T2: duplicate enqueue not flagged {duplicate:true}');
        if (second.id !== first.id) errors.push('T2: duplicate did not resolve to the original row id');
        const cnt = db.prepare(`SELECT COUNT(*) c FROM bridge_lipa_inbox WHERE request_id = ?`).get(PREFIX + 't2').c;
        if (cnt !== 1) errors.push(`T2: expected exactly 1 row for the request_id, found ${cnt}`);
        // A NULL request_id must NOT be deduped — two anonymous jobs both insert.
        const a1 = rel.enqueueGuarded({ command: 'noop', args: { anon: 1 } });
        const a2 = rel.enqueueGuarded({ command: 'noop', args: { anon: 2 } });
        if (a1.id) ids.push(a1.id);
        if (a2.id) ids.push(a2.id);
        if (!a1.inserted || !a2.inserted || a1.id === a2.id) errors.push('T2: NULL request_id jobs were wrongly deduped');
      }

      // ── T3: lease expiry (ANY timeout) → needs_review + UNKNOWN cost ────────
      // Changed: first timeout now goes directly to needs_review (never retry).
      // Any timeout = uncertain = park + hold, always.
      {
        const id = enqueue('t3'); ids.push(id);
        const c = claimRow(db, id, 'wk-t3');
        const gen0 = c.claim_generation;
        const now = Date.now();
        db.prepare('UPDATE bridge_lipa_inbox SET lease_expires_at = ? WHERE id = ?').run(now - 1000, id);
        rel.reconcileStaleClaims({ now });
        const row = db.prepare('SELECT status, attempts, claim_generation FROM bridge_lipa_inbox WHERE id = ?').get(id);
        if (row.status !== 'needs_review') errors.push(`T3: status ${row.status}, expected needs_review on first timeout`);
        if (row.attempts !== 1) errors.push(`T3: attempts ${row.attempts}, expected 1 after reconcile increment`);
        if (!(row.claim_generation > gen0)) errors.push('T3: claim_generation was not bumped to fence the old worker');
        // The lost attempt may have consumed tokens we cannot observe → unknown cost.
        const costs = costRows(db, id);
        const unknown = costs.find(r => r.cost_unknown === 1 && r.cost_usd_lower_bound == null);
        if (!unknown) errors.push('T3: reconcile did not record an UNKNOWN cost for the timed-out attempt');
        // Clean up the hold that reconcile now sets on every timeout
        try { db.prepare("DELETE FROM bridge_lipa_state WHERE key='execution_hold'").run(); } catch (_) {}
      }

      // ── T4: cancellation — confirmed → done+send; unknown → needs_review ─────
      {
        // Confirmed cancellation: certain result → delivered.
        const idOk = enqueue('t4ok'); ids.push(idOk);
        const cOk = claimRow(db, idOk, 'wk-t4a');
        const okRes = rel.completeClaim({ inboxId: idOk, claimGeneration: cOk.claim_generation, sessionId: 'wk-t4a',
          response: { cancelled: true, confirmation: 'event removed' }, uncertain: false });
        if (!okRes.done) errors.push('T4: confirmed cancellation did not complete');
        if (db.prepare('SELECT COUNT(*) c FROM bridge_lipa_outbox WHERE inbox_id = ?').get(idOk).c !== 1) errors.push('T4: confirmed cancellation did not write an outbox reply');

        // Unknown cancellation: uncertain mutating work → needs_review, NO send.
        const idUn = enqueue('t4un'); ids.push(idUn);
        const cUn = claimRow(db, idUn, 'wk-t4b');
        const unRes = rel.completeClaim({ inboxId: idUn, claimGeneration: cUn.claim_generation, sessionId: 'wk-t4b',
          response: { note: 'could not verify the cancellation took effect' },
          uncertain: true, uncertainReason: 'provider did not confirm deletion' });
        if (!unRes.needsReview) errors.push('T4: uncertain cancellation was not routed to needs_review');
        if (db.prepare('SELECT COUNT(*) c FROM bridge_lipa_outbox WHERE inbox_id = ?').get(idUn).c !== 0) errors.push('T4: uncertain cancellation wrote an outbox reply (must not send)');
        const st = db.prepare('SELECT status FROM bridge_lipa_inbox WHERE id = ?').get(idUn).status;
        if (st !== 'needs_review') errors.push(`T4: uncertain row status ${st}, expected needs_review`);
      }

      // ── T5: late side effect — completion after reconcile is fenced ──────────
      {
        const id = enqueue('t5'); ids.push(id);
        const c1 = claimRow(db, id, 'wk-t5');
        const gen1 = c1.claim_generation;
        const now = Date.now();
        db.prepare('UPDATE bridge_lipa_inbox SET lease_expires_at = ? WHERE id = ?').run(now - 1000, id);
        rel.reconcileStaleClaims({ now });     // bumps generation, row → needs_review
        try { db.prepare("DELETE FROM bridge_lipa_state WHERE key='execution_hold'").run(); } catch (_) {}
        // The original worker (gen1) finally lands its completion with real tokens.
        const res = rel.completeClaim({ inboxId: id, claimGeneration: gen1, sessionId: 'wk-t5',
          response: { ok: true }, inputTokens: 1000, outputTokens: 500 });
        if (!res.fenced) errors.push('T5: completion after reconcile was NOT fenced');
        if (db.prepare('SELECT COUNT(*) c FROM bridge_lipa_outbox WHERE inbox_id = ?').get(id).c !== 0) errors.push('T5: fenced late completion wrote an outbox row');
        // The fenced attempt still logs the tokens the discarded work consumed.
        const att = db.prepare("SELECT input_tokens, output_tokens FROM bridge_lipa_attempts WHERE inbox_id=? AND event='fenced' ORDER BY id DESC").get(id);
        if (!att || att.input_tokens !== 1000 || att.output_tokens !== 500) errors.push('T5: fenced completion did not log the consumed tokens for forensics');
      }

      // ── T6: restart lock — held across turn, released, and TTL-stealable ─────
      {
        // Poll A holds the lock across the agent turn (NOT released in poll.js).
        if (!rel.acquireWorkerLock('sess-A')) errors.push('T6: poll A could not acquire the lock');
        if (rel.acquireWorkerLock('sess-B')) errors.push('T6: poll B acquired the lock while A held it across the turn');
        // respond.js releases the lock on completion (holder must match).
        rel.releaseWorkerLock('sess-A');
        if (!rel.acquireWorkerLock('sess-B')) errors.push('T6: lock not re-acquirable after respond released it');
        rel.releaseWorkerLock('sess-B');
        // Crash safety net: if respond never runs, an EXPIRED lock is stealable so
        // the lane cannot wedge for longer than WORKER_LOCK_TTL_MS.
        rel.acquireWorkerLock('ttl-A');
        const lk = JSON.parse(db.prepare("SELECT value FROM bridge_lipa_state WHERE key='worker_lock'").get().value);
        lk.expires_at = Date.now() - 1000;   // simulate the TTL having elapsed
        db.prepare("UPDATE bridge_lipa_state SET value = ? WHERE key='worker_lock'").run(JSON.stringify(lk));
        if (!rel.acquireWorkerLock('ttl-B')) errors.push('T6: an expired lock was not stealable (WORKER_LOCK_TTL net failed)');
        rel.releaseWorkerLock('ttl-B');
      }

      // ── T7: exhausted timeout — 3rd lease expiry → dead + unknown cost ───────
      {
        const id = enqueue('t7'); ids.push(id);
        const now = Date.now();
        // Pre-position at attempts = MAX-1, claimed, lease expired: the reconcile
        // increment pushes it to MAX → dead (exhaustion wins over needs_review).
        db.prepare("UPDATE bridge_lipa_inbox SET status='claimed', attempts=?, claim_generation=1, lease_expires_at=? WHERE id=?")
          .run(rel.MAX_ATTEMPTS - 1, now - 1000, id);
        rel.reconcileStaleClaims({ now });
        const row = db.prepare('SELECT status, attempts, last_error FROM bridge_lipa_inbox WHERE id = ?').get(id);
        if (row.status !== 'dead') errors.push(`T7: status ${row.status}, expected dead at MAX_ATTEMPTS`);
        if (row.attempts !== rel.MAX_ATTEMPTS) errors.push(`T7: attempts ${row.attempts} != MAX ${rel.MAX_ATTEMPTS}`);
        if (!/exhaust/i.test(row.last_error || '')) errors.push('T7: dead row last_error does not explain exhaustion');
        const unknown = costRows(db, id).find(r => r.cost_unknown === 1);
        if (!unknown) errors.push('T7: dead-by-timeout did not record an unknown cost for the lost attempt');
        try { db.prepare("DELETE FROM bridge_lipa_state WHERE key='execution_hold'").run(); } catch (_) {}
      }

      // ── T8: exhausted failure — failClaim at MAX → dead + cost with tokens ───
      {
        const id = enqueue('t8'); ids.push(id);
        // Pre-position at attempts = MAX-1; a claimed delivery failure increments
        // to MAX → dead. Must NOT reschedule another retry.
        db.prepare("UPDATE bridge_lipa_inbox SET attempts = ? WHERE id = ?").run(rel.MAX_ATTEMPTS - 1, id);
        const c = claimRow(db, id, 'wk-t8');
        const res = rel.failClaim({ inboxId: id, claimGeneration: c.claim_generation, sessionId: 'wk-t8',
          error: new Error('final boom'), inputTokens: 100, outputTokens: 50 });
        if (res.status !== 'dead') errors.push(`T8: failClaim status ${res.status}, expected dead at MAX_ATTEMPTS`);
        const row = db.prepare('SELECT status, attempts FROM bridge_lipa_inbox WHERE id = ?').get(id);
        if (row.status === 'retry') errors.push('T8: exhausted row was rescheduled as retry instead of dead');
        if (row.status !== 'dead') errors.push(`T8: row status ${row.status}, expected dead`);
        if (row.attempts !== rel.MAX_ATTEMPTS) errors.push(`T8: attempts ${row.attempts} != MAX ${rel.MAX_ATTEMPTS}`);
        // input/output tokens are logged on the fail attempt …
        const att = db.prepare("SELECT input_tokens, output_tokens FROM bridge_lipa_attempts WHERE inbox_id=? AND event='fail' ORDER BY id DESC").get(id);
        if (!att || att.input_tokens !== 100 || att.output_tokens !== 50) errors.push('T8: failClaim did not log input/output tokens');
        // … and the consumed cost is recorded (lower bound, not unknown).
        const cost = costRows(db, id).find(r => r.cost_unknown === 0 && r.cost_usd_lower_bound > 0);
        if (!cost) errors.push('T8: dead-by-failure did not record the consumed cost from its tokens');
      }

      // ── T9: cost on a non-terminal failClaim — lower bound vs unknown ────────
      {
        // Tokens known → a positive lower-bound cost is recorded on a retry failure.
        const idT = enqueue('t9tok'); ids.push(idT);
        const cT = claimRow(db, idT, 'wk-t9a');
        const rT = rel.failClaim({ inboxId: idT, claimGeneration: cT.claim_generation, sessionId: 'wk-t9a',
          error: new Error('boom'), inputTokens: 200, outputTokens: 100 });
        if (rT.status !== 'retry') errors.push(`T9: expected retry (attempt 1), got ${rT.status}`);
        const cost = costRows(db, idT).find(r => r.cost_unknown === 0 && r.cost_usd_lower_bound > 0);
        if (!cost) errors.push('T9: failClaim with known tokens did not record a lower-bound cost');

        // Tokens unknown (timeout) → cost_unknown=1, lower_bound NULL.
        const idU = enqueue('t9unk'); ids.push(idU);
        const cU = claimRow(db, idU, 'wk-t9b');
        rel.failClaim({ inboxId: idU, claimGeneration: cU.claim_generation, sessionId: 'wk-t9b',
          error: new Error('worker vanished'), isTimeout: true });
        const unk = costRows(db, idU).find(r => r.cost_unknown === 1 && r.cost_usd_lower_bound == null);
        if (!unk) errors.push('T9: failClaim with no tokens did not record an unknown cost');
      }

      // ── T10: empty cycle is safe — no due wake, lock released, no counter ────
      {
        // A future-dated row is not counted as due.
        const before = rel.getDueCount();
        const id = enqueue('t10'); ids.push(id);
        db.prepare('UPDATE bridge_lipa_inbox SET available_at = ? WHERE id = ?').run(Date.now() + 3600000, id);
        if (rel.getDueCount() !== before) errors.push(`T10: a future-dated row changed the due count (${before} → ${rel.getDueCount()})`);
        // A paused lane reports 0 due and refuses to claim (poll then never wakes).
        db.prepare("INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES ('circuit', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
          .run(JSON.stringify({ state: 'open', reason: 'TEST_LIPA_WK synthetic pause' }), Date.now());
        if (rel.getDueCount() !== 0) errors.push('T10: paused lane reported non-zero due work');
        const paused = rel.claimDue({ limit: 1, sessionId: 'empty' });
        if (!paused.paused || paused.rows.length !== 0) errors.push('T10: paused claim was not an empty no-op');
        db.prepare("DELETE FROM bridge_lipa_state WHERE key='circuit'").run();
        // The empty-claim branch of poll.js releases the lock so a no-op does not
        // hold it for the full TTL.
        rel.acquireWorkerLock('empty');
        rel.releaseWorkerLock('empty');
        if (db.prepare("SELECT COUNT(*) c FROM bridge_lipa_state WHERE key='worker_lock'").get().c !== 0) errors.push('T10: worker lock not released after an empty claim');
        // There is NO launch counter anywhere — an empty cycle increments nothing.
        // launch_* keys are immutable per-run records from the preflight wrapper (valid, not counters).
        const counterKeys = db.prepare("SELECT key FROM bridge_lipa_state").all().map(r => r.key)
          .filter(k => /counter/i.test(k));
        if (counterKeys.length) errors.push(`T10: unexpected counter state key(s) exist: ${counterKeys.join(',')}`);
      }

      // ── T11: daily cost cap blocks new launches at $20 ──────────────────────
      {
        const capId = enqueue('t11'); ids.push(capId);
        const baseline = accounting.getDailySpend();
        if (baseline < accounting.DAILY_CAP_USD) {
          if (accounting.checkDailyCap().blocked) errors.push(`T11: cap blocked below the $${accounting.DAILY_CAP_USD} threshold (spend $${accounting.getDailySpend()})`);
        }
        accounting.recordRequestCost({ inboxId: capId, costUsd: accounting.DAILY_CAP_USD });
        const post = accounting.checkDailyCap();
        if (!post.blocked) errors.push(`T11: cap did not block after >= $${accounting.DAILY_CAP_USD} spend (spend $${post.spend})`);
        if (!(accounting.getDailySpend() >= accounting.DAILY_CAP_USD)) errors.push('T11: daily spend did not reflect the recorded cost');
      }

      // ── T12: per-request cap alerts but the response is still delivered ──────
      {
        const id = enqueue('t12'); ids.push(id);
        const c = claimRow(db, id, 'wk-t12');
        const done = rel.completeClaim({ inboxId: id, claimGeneration: c.claim_generation, sessionId: 'wk-t12',
          response: { ok: true }, inputTokens: 500000, outputTokens: 100000 });
        if (!done.done) errors.push('T12: over-cap request was not delivered');
        if (db.prepare('SELECT COUNT(*) c FROM bridge_lipa_outbox WHERE inbox_id = ?').get(id).c !== 1) errors.push('T12: response was not delivered despite advisory cost alert');
        const rec = accounting.recordRequestCost({ inboxId: id, costUsd: 2.5 });
        if (!accounting.checkRequestCap(rec.cost).alert) errors.push(`T12: $${rec.cost} did not trip the $${accounting.REQUEST_CAP_USD} request cap alert`);
        if (accounting.checkRequestCap(0.01).alert) errors.push('T12: a $0.01 request wrongly tripped the alert');
      }
    } finally {
      cleanup(db, ids);
      restoreState(db, 'circuit', circuitSnap);
      restoreState(db, 'worker_lock', lockSnap);
    }

    return errors.length === 0
      ? { pass: true, message: 'Lipa worker: claim race, dedup, reconcile backoff+unknown cost, cancellation review, fencing, lock TTL, exhaustion, cost on every fail/timeout path, and both cost caps all correct.' }
      : { pass: false, message: errors.join('\n         ') };
  },
};
