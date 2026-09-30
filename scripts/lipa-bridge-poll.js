#!/usr/bin/env node
'use strict';
/**
 * lipa-bridge-poll.js — the Lipa Bridge DUE-TIME GATE.
 *
 * Invoked by the OpenClaw scheduled task every 2 minutes. It runs OUTSIDE any
 * agentTurn: it is a plain Node process, no LLM. Its job is to decide whether
 * there is anything worth waking the agent for, and only then to emit the work.
 *
 * OpenClaw trigger contract (the actual supported mechanism): a scheduled task
 * runs a shell command; OpenClaw spawns an agent turn to consume the output
 * ONLY when the command exits 0 AND prints the wake sentinel on stdout. This
 * script prints the sentinel + a `pending_commands` JSON block ONLY when due
 * work exists. When the queue has nothing due (or the lane is paused, or
 * another worker holds the lock) it exits 0 with NO stdout → NO agent turn is
 * spawned. That is the "no empty-queue LLM wake" guarantee.
 *
 * Because it also CLAIMS the rows it emits (single global worker lock + a lease
 * + a fresh claim_generation per row), the agent must echo the claim_generation
 * and session_id back to scripts/lipa-bridge-respond.js so the completion can be
 * fenced against stale/late writes.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { initDB } = require('../src/db');
const rel = require('../src/bridge/lipaReliability');
const { ensureLipaTables } = require('../src/bridge/lipaLane');

const WAKE_SENTINEL = 'LIPA_BRIDGE_WAKE';        // OpenClaw wakes the agent only when it sees this

function exitQuiet(code = 0) { process.exit(code); }

initDB();
ensureLipaTables();

const now = Date.now();

// 0) Reclaim leases from a dead/vanished worker before deciding anything. A PID
//    is not remote-session liveness; the lease is. Reconciled rows re-become due
//    and are fenced against their original worker's late completion.
try { rel.reconcileStaleClaims({ now }); } catch (e) { console.error('[Lipa gate] reconcile failed:', e.message); }

// 1) Circuit breaker: paused lane never wakes the agent.
if (rel.isPaused()) {
  const c = rel.getCircuit();
  console.error(`[Lipa gate] lane PAUSED (billing): ${c.reason || 'unknown'} — not waking agent`);
  exitQuiet(0);
}

// 2) Due-time gate. Nothing due → clean silent exit, no LLM wake.
if (rel.getDueCount(now) === 0) exitQuiet(0);

// 3) Single global worker. If another live worker holds the lock, stand down.
const sessionId = process.env.OPENCLAW_SESSION_ID || `poll-${process.pid}-${now}`;
const runId = process.env.OPENCLAW_RUN_ID || null;
if (!rel.acquireWorkerLock(sessionId)) exitQuiet(0);

let claim;
try {
  claim = rel.claimDue({ limit: 10, sessionId, runId, now });
} finally {
  // Lock is held for the lease window via the row leases; release the process
  // lock so a crash here doesn't wedge the lane (the per-row lease still fences).
  rel.releaseWorkerLock(sessionId);
}

if (claim.paused || claim.rows.length === 0) exitQuiet(0);

const commands = claim.rows.map(row => ({
  inbox_id: row.id,
  request_id: row.request_id,
  claim_generation: row.claim_generation,   // MUST be echoed back to respond.js (fencing)
  session_id: sessionId,
  attempt: row.attempts,
  command: row.command,
  args: row.args,
  from: row.from_addr,
  subject: row.subject,
  gmail_message_id: row.gmail_message_id,
  created_at: row.created_at,
}));

// Emit the wake sentinel + payload — this is what triggers the agent turn.
console.log(WAKE_SENTINEL);
console.log(JSON.stringify({ pending_commands: commands }, null, 2));
exitQuiet(0);
