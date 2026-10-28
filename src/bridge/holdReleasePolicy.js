'use strict';

/**
 * holdReleasePolicy.js — Pure decision function for execution hold release.
 *
 * NO imports of DB, network, child_process, or app modules.
 * Takes pre-fetched data, returns { release: boolean, reason: string }.
 *
 * SAFETY INVARIANT: Release ONLY on POSITIVE GROUNDED EVIDENCE that ALL
 * claimed rows were completed by THIS hold's session at the SAME claim
 * generation the preflight originally issued. Fail closed on anything
 * ambiguous.
 *
 * ── Positive evidence required (ALL must hold for EVERY claimed row) ─────
 *   1. Row EXISTS in DB (missing = unexplained = hold)
 *   2. Row status is 'done'
 *   3. Attribution: row was completed by THIS session+generation, proven by:
 *      a. Row's session_id matches hold's session_id, AND
 *      b. Row's claim_generation matches the generation originally issued
 *         for that row (from claimDetails / execution_state), AND
 *      c. A completion event ('deliver', outcome 'ok') exists in the
 *         attempts log for this inbox_id + session_id + generation
 *   If any attribution check fails (manual/DM reconcile, different session,
 *   different generation), the row does NOT count as positive evidence.
 *
 * ── NOT accepted as release evidence ─────────────────────────────────────
 *   - 'dead' (retries exhausted — proves neither that the turn stopped
 *     nor that no side effect happened)
 *   - Missing rows (a claimed row you cannot see is unexplained)
 *   - 'done' by a different session or claim generation
 *   - 'done' by manual/DM reconciliation (no matching completion event)
 *   - abortedLastRun alone (CLI kill ≠ remote termination)
 *   - session not found alone (cleanup race, not proof)
 *   - ageMs exceeding any threshold alone (stale ≠ terminated)
 *   - needs_review rows (uncertain side effects)
 *   - process or file inactivity
 *   - parse/CLI errors (fail closed)
 *
 * ── Extra blocker (never release evidence, only a hold reason) ───────────
 *   - Session found AND recently active (ageMs < quietThresholdMs):
 *     the session record is present and may still be live. A recently
 *     updated session is a reason to wait. This is never release evidence.
 *
 * Session JSON shape (openclaw sessions --json, as of 2026-10-28):
 *   Fields: sessionId, key, updatedAt, ageMs, abortedLastRun, totalTokens,
 *           totalTokensFresh, model, modelProvider, contextTokens, agentId,
 *           agentRuntime, kind
 *   ABSENT: status, endedAt, runtime duration — no explicit terminal indicator.
 *   Therefore session state CANNOT serve as positive terminal evidence.
 *
 * ── DECISION TABLE ───────────────────────────────────────────────────────
 *
 * Inputs:
 *   A = all rows done by THIS session + THIS generation (with completion event)
 *   S = session absent (not found in `openclaw sessions --json`)
 *   R = session recently active (found, ageMs < quietThresholdMs)
 *
 * | #  | A   | S   | R   | Result  | Reason                                        |
 * |----|-----|-----|-----|---------|-----------------------------------------------|
 * |  1 | YES | YES | n/a | RELEASE | all rows positively completed, session gone    |
 * |  2 | YES | NO  | YES | HOLD    | session recently active — may still be live    |
 * |  3 | YES | NO  | NO  | RELEASE | all rows completed, session stale/quiet        |
 * |  4 | NO  | any | any | HOLD    | row done by other session                     |
 * |  5 | NO  | any | any | HOLD    | done by manual/DM reconcile (no completion ev) |
 * |  6 | NO  | any | any | HOLD    | done at different claim generation             |
 * |  7 | NO  | any | any | HOLD    | one done + one missing from DB                |
 * |  8 | NO  | any | any | HOLD    | dead only (retries exhausted ≠ safe)          |
 * |  9 | NO  | any | any | HOLD    | needs_review                                  |
 * | 10 | NO  | any | any | HOLD    | abortedLastRun only (not terminal evidence)   |
 * | 11 | NO  | any | any | HOLD    | not-found only with non-done rows             |
 * | 12 | NO  | any | any | HOLD    | stale age only (staleness ≠ termination)      |
 * | 13 | --- | --- | --- | HOLD    | corrupt hold / missing session_id / lookup fail|
 * | 14 | --- | --- | --- | HOLD    | claimed_ids empty                             |
 *
 * Columns/events used for attribution:
 *   - bridge_lipa_inbox: id, status, session_id, claim_generation
 *   - bridge_lipa_attempts: inbox_id, session_id, claim_generation, event, outcome
 *   - execution_state.claim_details: inbox_id, claim_generation (issued at claim time)
 *   - hold: session_id, claimed_ids
 *
 * What is NOT proven by this policy:
 *   - That the remote agent process has actually terminated (session JSON has
 *     no endedAt/status field). We use the quiet threshold as a heuristic.
 *   - That no side effect occurred during a timed-out run. Dead/needs_review
 *     rows are left for human review precisely because of this.
 *   - That the session cleanup race is impossible. We require ALL rows present
 *     to avoid releasing on incomplete data.
 */

/**
 * @param {object} input
 * @param {object|null} input.hold - The execution hold object
 *   Expected shape: { session_id, claimed_ids: number[], ... }
 * @param {object|null} input.session - Session record from `openclaw sessions --json`
 *   (null if session not found or CLI failed). Has ageMs when present.
 * @param {Array<{id: number, status: string, session_id: string|null, claim_generation: number|null}>} input.rows
 *   - Current DB state of claimed rows (MUST include session_id and claim_generation)
 * @param {boolean} input.sessionLookupFailed - True if the CLI call itself errored
 * @param {Array<{inbox_id: number, claim_generation: number}>} [input.claimDetails]
 *   - Original claim details from execution_state (claim_generation issued per row)
 *   - If missing/empty, attribution cannot be verified → fail closed
 * @param {Array<{inbox_id: number, session_id: string, claim_generation: number, event: string, outcome: string}>} [input.completionEvents]
 *   - Relevant entries from bridge_lipa_attempts for the claimed rows
 *   - A valid completion event has event='deliver' AND outcome='ok'
 * @param {number} [input.quietThresholdMs] - Session ageMs must exceed this
 *   to not block release (default: 0, meaning session presence never blocks).
 *   Recommended: CLI_TIMEOUT_MS + AUTO_RECONCILE_GRACE_MS
 * @returns {{ release: boolean, reason: string }}
 */
function decideRelease({ hold, session, rows, sessionLookupFailed, claimDetails, completionEvents, quietThresholdMs }) {
  // ── Guard: no hold or corrupt hold → never release ──
  if (!hold) {
    return { release: false, reason: 'no hold present' };
  }
  if (hold.corrupt) {
    return { release: false, reason: 'corrupt hold requires manual intervention' };
  }
  if (!hold.session_id) {
    return { release: false, reason: 'hold has no session_id — cannot verify attribution' };
  }

  // ── Guard: CLI/parse failure → fail closed ──
  if (sessionLookupFailed) {
    return { release: false, reason: 'session lookup failed — fail closed' };
  }

  // ── Guard: must have claimed IDs to evaluate ──
  const claimedIds = hold.claimed_ids || [];
  if (claimedIds.length === 0) {
    return { release: false, reason: 'hold has no claimed_ids — cannot verify completion' };
  }

  // ── Guard: must have claimDetails to verify attribution ──
  const details = Array.isArray(claimDetails) ? claimDetails : [];
  if (details.length === 0) {
    return { release: false, reason: 'no claimDetails available — cannot verify claim generation attribution' };
  }

  // Build lookup: inbox_id → originally issued claim_generation
  const issuedGeneration = new Map();
  for (const d of details) {
    if (d && typeof d.inbox_id === 'number' && typeof d.claim_generation === 'number') {
      issuedGeneration.set(d.inbox_id, d.claim_generation);
    }
  }

  // Build lookup: (inbox_id, session_id, claim_generation) → has completion event
  const events = Array.isArray(completionEvents) ? completionEvents : [];
  const completionSet = new Set();
  for (const ev of events) {
    if (ev && ev.event === 'deliver' && ev.outcome === 'ok' &&
        typeof ev.inbox_id === 'number' && ev.session_id && typeof ev.claim_generation === 'number') {
      completionSet.add(`${ev.inbox_id}:${ev.session_id}:${ev.claim_generation}`);
    }
  }

  const holdSessionId = hold.session_id;
  const failures = [];

  for (const id of claimedIds) {
    const numId = Number(id);

    // (1) Row must exist — missing rows are unexplained, not acceptable
    const row = rows.find(r => r.id === numId || r.id === id);
    if (!row) {
      failures.push(`row ${id}: missing from DB — unexplained absence`);
      continue;
    }

    // (2) Row must be 'done' — dead, needs_review, claimed, etc. are NOT positive evidence
    if (row.status !== 'done') {
      failures.push(`row ${id}: status '${row.status}' is not positive completion evidence`);
      continue;
    }

    // (3) Attribution: done by THIS session at THIS generation
    // 3a. Row's session_id must match
    if (row.session_id !== holdSessionId) {
      failures.push(`row ${id}: done by session '${row.session_id}', not hold session '${holdSessionId}'`);
      continue;
    }

    // 3b. Row's claim_generation must match what was originally issued
    const expectedGen = issuedGeneration.get(numId);
    if (expectedGen === undefined) {
      // This claimed ID has no matching claimDetails entry — cannot verify
      failures.push(`row ${id}: no issued claim_generation in claimDetails — cannot verify`);
      continue;
    }
    if (row.claim_generation !== expectedGen) {
      failures.push(`row ${id}: claim_generation ${row.claim_generation} ≠ issued ${expectedGen} — different generation`);
      continue;
    }

    // 3c. Must have a completion event in the attempts log
    const key = `${numId}:${holdSessionId}:${expectedGen}`;
    if (!completionSet.has(key)) {
      failures.push(`row ${id}: no completion event (deliver/ok) for session+generation — may be manual reconcile`);
      continue;
    }

    // All three attribution checks pass for this row — it counts as positive evidence
  }

  // If any claimed row failed verification, hold
  if (failures.length > 0) {
    const detail = failures.join('; ');
    return {
      release: false,
      reason: `attribution check failed: ${detail}`
    };
  }

  // ── All claimed rows are positively attributed. Check session activity. ──
  // Session recently active = extra blocker (never release evidence, just a hold reason)
  const threshold = typeof quietThresholdMs === 'number' && quietThresholdMs > 0 ? quietThresholdMs : 0;
  if (session && threshold > 0) {
    const ageMs = typeof session.ageMs === 'number' ? session.ageMs : 0;
    if (ageMs < threshold) {
      return {
        release: false,
        reason: `session found and recently active (ageMs=${ageMs} < quietThreshold=${threshold}) — may still be live`
      };
    }
  }

  // ── Release: all rows done by this session+generation with completion events,
  //    and session is either absent or stale ──
  const sessionNote = session ? `session stale (ageMs=${session.ageMs})` : 'session absent';
  return {
    release: true,
    reason: `all ${claimedIds.length} claimed rows positively completed by session ${holdSessionId} at issued generation, ${sessionNote}`
  };
}

module.exports = { decideRelease };
