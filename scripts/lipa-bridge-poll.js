#!/usr/bin/env node
'use strict';
/**
 * lipa-bridge-poll.js — the Lipa Bridge DUE-TIME GATE.
 *
 * Two modes:
 * 1. BOUND mode (preflight v4+): OPENCLAW_SESSION_ID is set and the preflight
 *    already claimed rows for this session. poll.js loads the preclaimed rows
 *    by session_id, validates ID/generation/session, and emits the payload.
 *    It NEVER claims another row or re-queries getDueCount.
 * 2. LEGACY mode (old cron / direct invocation): the original flow — check
 *    circuit, due count, cost cap, acquire lock, claim, emit.
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
const sessionId = process.env.OPENCLAW_SESSION_ID || `poll-${process.pid}-${now}`;
const runId = process.env.OPENCLAW_RUN_ID || null;
const db = getDB();

// ── BOUND MODE: preflight pre-claimed rows for this session ──────────────────
const preclaimed = db.prepare(
  "SELECT * FROM bridge_lipa_inbox WHERE status='claimed' AND session_id = ?"
).all(sessionId);

if (preclaimed.length > 0) {
  // Validate each preclaimed row
  const commands = [];
  for (const row of preclaimed) {
    // Verify the row has a claim_generation (was claimed by the reliability layer)
    if (!row.claim_generation) {
      console.error(`[Lipa gate] BOUND: row ${row.id} has no claim_generation — skipping (unsafe)`);
      continue;
    }
    commands.push({
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
    });
  }

  if (commands.length === 0) {
    console.error('[Lipa gate] BOUND: no valid preclaimed rows for session — exiting');
    exitQuiet(0);
  }

  console.log(WAKE_SENTINEL);
  console.log(JSON.stringify({ pending_commands: commands }, null, 2));
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
if (!rel.acquireWorkerLock(sessionId)) exitQuiet(0);

// 4) Claim one row
const claim = rel.claimDue({ limit: 1, sessionId, runId, now });
if (claim.paused || claim.rows.length === 0) {
  rel.releaseWorkerLock(sessionId);
  exitQuiet(0);
}

const commands = claim.rows.map(row => ({
  inbox_id: row.id,
  request_id: row.request_id,
  claim_generation: row.claim_generation,
  session_id: sessionId,
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
