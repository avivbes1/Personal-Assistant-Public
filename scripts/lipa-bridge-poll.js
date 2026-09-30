#!/usr/bin/env node
'use strict';
/**
 * lipa-bridge-poll.js — the Lipa Bridge DUE-TIME GATE.
 *
 * ── ACTUAL scheduler mechanism (as of OpenClaw 2026.5.6) ──────────────────────
 * This runs as the agent's FIRST action inside an agent turn — NOT as a pre-model
 * shell gate. The real control flow is:
 *
 *   1. An OpenClaw cron job (id 7d840526) fires an UNCONDITIONAL agentTurn every
 *      2 minutes. There is no command-based precondition on the cron.
 *   2. The agent therefore ALWAYS wakes — one LLM turn is consumed per fire,
 *      whether or not there is Lipa work to do.
 *   3. This poll script is what the agent runs first. It claims any due row and
 *      prints the payload; if there is nothing due it exits 0 with no stdout and
 *      the agent turn simply ends quickly — but the LLM turn was ALREADY spent.
 *
 * So the LIPA_BRIDGE_WAKE sentinel below is INFORMATIONAL ONLY. OpenClaw does not
 * parse stdout to decide whether to wake: it cannot gate the turn on this script's
 * output. The sentinel just frames the `pending_commands` block for the agent/logs.
 *
 * GAP: a true pre-model gate (skip the LLM turn entirely on an empty queue) would
 * require OpenClaw support for command-based conditional waking — running a shell
 * command and only spawning the agent turn when it exits 0 / prints a sentinel.
 * That is NOT available as of 2026.5.6, so the "no empty-queue LLM wake" property
 * is aspirational, not enforced. What IS enforced here is the cheaper guarantee:
 * an empty cycle does no DB work beyond a read, claims nothing, and releases the
 * worker lock (see the empty-claim branch below) — see "empty cycles are safe".
 *
 * Empty cycles are safe: there is NO launch counter anywhere in this system — an
 * empty poll increments nothing and mutates nothing. The only durable side effect
 * an empty cycle can have is the worker lock, and that is released immediately
 * when no rows are claimed (below), so a no-op poll never holds it for the TTL.
 *
 * Because it also CLAIMS the rows it emits (single global worker lock + a lease
 * + a fresh claim_generation per row), the agent must echo the claim_generation
 * and session_id back to scripts/lipa-bridge-respond.js so the completion can be
 * fenced against stale/late writes.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { initDB } = require('../src/db');
const rel = require('../src/bridge/lipaReliability');
const accounting = require('../src/bridge/lipaAccounting');
const { ensureLipaTables } = require('../src/bridge/lipaLane');

const WAKE_SENTINEL = 'LIPA_BRIDGE_WAKE';        // informational marker only — OpenClaw does NOT gate the turn on it (see header)

function exitQuiet(code = 0) { process.exit(code); }

initDB();
ensureLipaTables();

const now = Date.now();

// 0) Reclaim leases from a dead/vanished worker before deciding anything. A PID
//    is not remote-session liveness; the lease is. Reconciled rows re-become due
//    and are fenced against their original worker's late completion.
try { rel.reconcileStaleClaims({ now }); } catch (e) { console.error('[Lipa gate] reconcile failed:', e.message); }

// 0b) Execution hold gate — if the preflight set a hold (timeout/bad exit), do
//     not claim new work inside the agent turn either. This prevents an in-turn
//     poll from bypassing the hold that the preflight wrapper enforces externally.
if (rel.getExecutionHold && rel.getExecutionHold()) {
  const h = rel.getExecutionHold();
  console.error(`[Lipa gate] EXECUTION HOLD active (reason: ${h.reason || 'unknown'}) — not claiming work`);
  exitQuiet(0);
}

// 1) Circuit breaker: paused lane never wakes the agent.
if (rel.isPaused()) {
  const c = rel.getCircuit();
  console.error(`[Lipa gate] lane PAUSED (billing): ${c.reason || 'unknown'} — not waking agent`);
  exitQuiet(0);
}

// 2) Due-time gate. Nothing due → clean silent exit, no LLM wake.
if (rel.getDueCount(now) === 0) exitQuiet(0);

// 2b) Advisory daily cost cap. Once today's recorded lower-bound spend reaches
//     the cap, do NOT wake the agent for new work (in-flight work is untouched).
try {
  const cap = accounting.checkDailyCap(now);
  if (cap.blocked) {
    console.error(`[Lipa gate] daily cost cap reached ($${cap.spend.toFixed(2)}/$${cap.cap}) — not waking agent`);
    exitQuiet(0);
  }
} catch (e) { console.error('[Lipa gate] daily cap check failed:', e.message); }

// 3) Single global worker. If another live worker holds the lock, stand down.
const sessionId = process.env.OPENCLAW_SESSION_ID || `poll-${process.pid}-${now}`;
const runId = process.env.OPENCLAW_RUN_ID || null;
if (!rel.acquireWorkerLock(sessionId)) exitQuiet(0);

// One request per agent turn. The worker lock is intentionally NOT released here:
// the actual LLM execution happens AFTER this process exits (in the agent turn),
// so releasing now would let the next poll cycle claim more rows mid-execution.
// scripts/lipa-bridge-respond.js releases the lock on completion; WORKER_LOCK_TTL_MS
// is the crash safety net if the agent turn never lands.
// Check if the preflight already claimed rows for this session (v3+ flow).
// If so, read them back instead of claiming again.
const { initDB: _initDB, getDB: _getDB } = require('../src/db');
const alreadyClaimed = _getDB().prepare(
  "SELECT * FROM bridge_lipa_inbox WHERE status='claimed' AND session_id = ?"
).all(sessionId);

let claimedRows;
if (alreadyClaimed.length > 0) {
  // Preflight pre-claimed. Verify session match and use these rows.
  claimedRows = alreadyClaimed.map(r => {
    const args = (() => { try { return JSON.parse(r.args_json || '{}'); } catch (_) { return {}; } })();
    return { ...r, args };
  });
} else {
  // Legacy path: claim here (for backward compat with old cron or direct invocation)
  const claim = rel.claimDue({ limit: 1, sessionId, runId, now });
  if (claim.paused || claim.rows.length === 0) {
    rel.releaseWorkerLock(sessionId);
    exitQuiet(0);
  }
  claimedRows = claim.rows;
}

if (claimedRows.length === 0) {
  rel.releaseWorkerLock(sessionId);
  exitQuiet(0);
}

const commands = claimedRows.map(row => ({
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

// Emit the sentinel + payload for the (already-running) agent turn to consume.
// NOTE: this does not TRIGGER the turn — the turn is already live (the cron fired
// it unconditionally); this is just the work handoff. See the header for why.
console.log(WAKE_SENTINEL);
console.log(JSON.stringify({ pending_commands: commands }, null, 2));
exitQuiet(0);
