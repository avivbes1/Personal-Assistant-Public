'use strict';

/**
 * holdReleasePolicy.js — Pure decision function for execution hold release.
 *
 * NO imports of DB, network, child_process, or app modules.
 * Takes pre-fetched data, returns { release: boolean, reason: string }.
 *
 * SAFETY INVARIANT: Release ONLY on POSITIVE GROUNDED EVIDENCE that the old
 * turn finished or was terminated. Fail closed on anything ambiguous.
 *
 * Positive evidence accepted:
 *   1. Completion record: ALL claimed rows have status 'done' (respond.js
 *      wrote a successful completion) or 'dead' (max attempts exhausted,
 *      work definitively abandoned — no uncertain side effects).
 *
 * NOT accepted as release evidence (any of these alone → hold preserved):
 *   - abortedLastRun alone (CLI kill doesn't prove the turn stopped acting)
 *   - session not found in `openclaw sessions` (cleanup race, not proof)
 *   - ageMs exceeding any threshold (stale ≠ terminated)
 *   - needs_review rows (uncertain side effects — not proven safe)
 *   - process or file inactivity
 *   - parse/CLI errors (fail closed)
 *
 * Session JSON shape (openclaw sessions --json, as of 2026-10-28):
 *   Fields: sessionId, key, updatedAt, ageMs, abortedLastRun, totalTokens,
 *           totalTokensFresh, model, modelProvider, contextTokens, agentId,
 *           agentRuntime, kind
 *   ABSENT: status, endedAt, runtime duration — no explicit terminal indicator.
 *   Therefore session state CANNOT serve as positive terminal evidence.
 */

/**
 * @param {object} input
 * @param {object|null} input.hold - The execution hold object
 * @param {object|null} input.session - Session record from `openclaw sessions --json`
 *   (null if session not found or CLI failed)
 * @param {Array<{id: number, status: string}>} input.rows - Current DB state of claimed rows
 * @param {boolean} input.sessionLookupFailed - True if the CLI call itself errored
 * @returns {{ release: boolean, reason: string }}
 */
function decideRelease({ hold, session, rows, sessionLookupFailed }) {
  // ── Guard: no hold or corrupt hold → never release ──
  if (!hold) {
    return { release: false, reason: 'no hold present' };
  }
  if (hold.corrupt) {
    return { release: false, reason: 'corrupt hold requires manual intervention' };
  }
  if (!hold.session_id) {
    return { release: false, reason: 'hold has no session_id — cannot verify' };
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

  // ── Core: check all claimed rows for positive completion evidence ──
  // Every claimed row must be accounted for with a definitive terminal status.
  // 'done' = respond.js wrote successful completion (strongest evidence)
  // 'dead' = max attempts exhausted, work abandoned (no uncertain effects)
  // Rows not found in DB are treated as gone/cleaned-up — acceptable only if
  // at least one row IS found and is terminal (pure absence is not evidence).
  const POSITIVE_TERMINAL = new Set(['done', 'dead']);
  let foundCount = 0;
  const nonTerminal = [];

  for (const id of claimedIds) {
    const row = rows.find(r => r.id === id || r.id === Number(id));
    if (!row) {
      // Row gone / cleaned up — not blocking, but not positive evidence either
      continue;
    }
    foundCount++;
    if (!POSITIVE_TERMINAL.has(row.status)) {
      nonTerminal.push({ id: row.id, status: row.status });
    }
  }

  // If we found zero rows at all, we have no positive evidence
  if (foundCount === 0) {
    return {
      release: false,
      reason: `all ${claimedIds.length} claimed rows missing from DB — no positive completion evidence`
    };
  }

  // If any found row is non-terminal, hold stays
  if (nonTerminal.length > 0) {
    const detail = nonTerminal.map(r => `row ${r.id}: ${r.status}`).join(', ');
    return {
      release: false,
      reason: `non-terminal rows block release: ${detail}`
    };
  }

  // All found rows are in positive terminal states → release
  const goneCount = claimedIds.length - foundCount;
  const goneSuffix = goneCount > 0 ? `, ${goneCount} rows cleaned up` : '';
  return {
    release: true,
    reason: `all ${foundCount} claimed rows in positive terminal state (done/dead)${goneSuffix}`
  };
}

module.exports = { decideRelease };
