#!/usr/bin/env node
'use strict';
/**
 * lipa-bridge-poll.js — the Lipa Bridge DUE-TIME GATE.
 *
 * Two modes:
 * 1. BOUND mode (preflight v5+): LIPA_BRIDGE_BOUND=1 is set by the preflight
 *    before spawn. poll.js REQUIRES LIPA_BRIDGE_CLAIM_ID, LIPA_BRIDGE_CLAIM_GEN,
 *    and OPENCLAW_SESSION_ID to be set. It checks hold/circuit FIRST, then
 *    validates the preclaimed row matches all three env vars exactly. If the
 *    preclaim is missing or mismatched (wrong ID, wrong generation, wrong session),
 *    it refuses with exit 1. NEVER falls back to legacy claiming in bound mode.
 * 2. LEGACY mode (old cron / direct invocation, no LIPA_BRIDGE_BOUND): the
 *    original flow — check circuit, due count, cost cap, acquire lock, claim, emit.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { initDB, getDB } = require('../src/db');
const rel = require('../src/bridge/lipaReliability');
const accounting = require('../src/bridge/lipaAccounting');
const { ensureLipaTables } = require('../src/bridge/lipaLane');

const WAKE_SENTINEL = 'LIPA_BRIDGE_WAKE';

function exitQuiet(code = 0) { process.exit(code); }
function safeParse(j) { try { return JSON.parse(j || '{}'); } catch (_) { return {}; } }

initDB();
ensureLipaTables();

const now = Date.now();
const sessionId = process.env.OPENCLAW_SESSION_ID || null;
const runId = process.env.OPENCLAW_RUN_ID || null;
const db = getDB();

// ── BOUND MODE: explicitly invoked by preflight with pre-claimed rows ─────────
// LIPA_BRIDGE_BOUND=1 is set by the preflight. In this mode we NEVER fall back
// to legacy claiming — if the required env vars are missing or the preclaim
// doesn't match, we refuse immediately.
if (process.env.LIPA_BRIDGE_BOUND === '1') {
  // Require all bound-mode env vars
  if (!sessionId) {
    console.error('[Lipa gate] BOUND: OPENCLAW_SESSION_ID is required in bound mode — exit 1');
    process.exit(1);
  }
  const claimIdStr = process.env.LIPA_BRIDGE_CLAIM_ID;
  const claimGenStr = process.env.LIPA_BRIDGE_CLAIM_GEN;
  if (!claimIdStr || !claimGenStr) {
    console.error('[Lipa gate] BOUND: LIPA_BRIDGE_CLAIM_ID and LIPA_BRIDGE_CLAIM_GEN are required — exit 1');
    process.exit(1);
  }
  const expectedId = parseInt(claimIdStr, 10);
  const expectedGen = parseInt(claimGenStr, 10);
  if (!Number.isFinite(expectedId) || !Number.isFinite(expectedGen)) {
    console.error('[Lipa gate] BOUND: LIPA_BRIDGE_CLAIM_ID and LIPA_BRIDGE_CLAIM_GEN must be integers — exit 1');
    process.exit(1);
  }

  // Check hold BEFORE reading preclaims (hold is higher priority)
  if (rel.getExecutionHold && rel.getExecutionHold()) {
    console.error('[Lipa gate] BOUND: EXECUTION HOLD active — refusing to emit work');
    process.exit(1);
  }

  // Check circuit breaker
  if (rel.isPaused()) {
    console.error('[Lipa gate] BOUND: lane PAUSED (billing) — refusing to emit work');
    process.exit(1);
  }

  // Look up the specific preclaimed row by session_id + inbox_id
  const row = db.prepare(
    "SELECT * FROM bridge_lipa_inbox WHERE id = ? AND status = 'claimed' AND session_id = ?"
  ).get(expectedId, sessionId);

  if (!row) {
    console.error(`[Lipa gate] BOUND: no claimed row with id=${expectedId} for session=${sessionId} — exit 1`);
    process.exit(1);
  }

  // Validate claim_generation matches
  if (row.claim_generation !== expectedGen) {
    console.error(`[Lipa gate] BOUND: claim_generation mismatch: expected=${expectedGen} got=${row.claim_generation} — exit 1`);
    process.exit(1);
  }

  // Validate session_id matches (belt and suspenders — already filtered in query)
  if (row.session_id !== sessionId) {
    console.error(`[Lipa gate] BOUND: session_id mismatch: expected=${sessionId} got=${row.session_id} — exit 1`);
    process.exit(1);
  }

  // Valid preclaim — emit it
  const command = {
    inbox_id: row.id,
    request_id: row.request_id,
    claim_generation: row.claim_generation,
    session_id: sessionId,
    attempt: row.attempts,
    command: row.command,
    args: safeParse(row.args_json),
    from: row.from_addr,
    subject: row.subject,
    gmail_message_id: row.gmail_message_id,
    created_at: row.created_at,
  };

  console.log(WAKE_SENTINEL);
  console.log(JSON.stringify({ pending_commands: [command] }, null, 2));
  exitQuiet(0);
}

// ── LEGACY MODE: original flow (old cron / direct invocation) ────────────────

// 0) Reconcile stale leases
try { rel.reconcileStaleClaims({ now }); } catch (e) { console.error('[Lipa gate] reconcile failed:', e.message); }

// 0b) Execution hold gate
if (rel.getExecutionHold && rel.getExecutionHold()) {
  console.error(`[Lipa gate] EXECUTION HOLD active — not claiming work`);
  exitQuiet(0);
}

// 1) Circuit breaker
if (rel.isPaused()) {
  console.error(`[Lipa gate] lane PAUSED (billing) — not waking agent`);
  exitQuiet(0);
}

// 2) Due-time gate
if (rel.getDueCount(now) === 0) exitQuiet(0);

// 2b) Daily cost cap
try {
  const cap = accounting.checkDailyCap(now);
  if (cap.blocked) {
    console.error(`[Lipa gate] daily cost cap reached — not waking agent`);
    exitQuiet(0);
  }
} catch (e) { console.error('[Lipa gate] daily cap check failed:', e.message); }

// 3) Acquire lock
if (!rel.acquireWorkerLock(sessionId || `poll-${process.pid}-${now}`)) exitQuiet(0);

// 4) Claim one row
const claim = rel.claimDue({ limit: 1, sessionId: sessionId || `poll-${process.pid}-${now}`, runId, now });
if (claim.paused || claim.rows.length === 0) {
  rel.releaseWorkerLock(sessionId || `poll-${process.pid}-${now}`);
  exitQuiet(0);
}

const commands = claim.rows.map(row => ({
  inbox_id: row.id,
  request_id: row.request_id,
  claim_generation: row.claim_generation,
  session_id: sessionId || `poll-${process.pid}-${now}`,
  attempt: row.attempts,
  command: row.command,
  args: row.args,
  from: row.from_addr,
  subject: row.subject,
  gmail_message_id: row.gmail_message_id,
  created_at: row.created_at,
}));

console.log(WAKE_SENTINEL);
console.log(JSON.stringify({ pending_commands: commands }, null, 2));
exitQuiet(0);
