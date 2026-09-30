#!/usr/bin/env node
'use strict';
/**
 * lipa-bridge-respond.js — Write a fenced response to the Lipa Bridge outbox.
 *
 * Usage:
 *   node scripts/lipa-bridge-respond.js <inbox_id> <request_id> '<response_json>' \
 *        [original_subject] [in_reply_to] ['<options_json>']
 *
 * options_json (optional) carries the reliability metadata handed to the agent
 * by the gate (scripts/lipa-bridge-poll.js):
 *   {
 *     "claim_generation":  <int>,   // REQUIRED for fencing — from pending_commands
 *     "session_id":        "…",
 *     "provider_message_id": "…",   // tracked for forensics; 'unknown' if absent
 *     "cache_read_tokens":  <int>,  // separate field; omit/null → stored as unknown
 *     "cache_write_tokens": <int>,
 *     "input_tokens":       <int>,  // provider prompt input tokens; omit/null → unknown
 *     "output_tokens":      <int>,  // provider completion output tokens; omit/null → unknown
 *     "model":             "…",     // advisory cost accounting: model id (optional)
 *     "cost_usd":           <num>,  // advisory cost accounting: real cost if known;
 *                                   //   omitted → a lower bound is estimated from tokens
 *     "uncertain":          true,   // uncertain MUTATING work → needs_review, no send
 *     "uncertain_reason":  "…"
 *   }
 *
 * LOCK RELEASE: This script no longer releases the global worker lock. The
 * preflight wrapper (lipa-bridge-preflight.js) owns lock release and verifies
 * DB state on clean exit before releasing. This prevents a race where respond.js
 * releases the lock mid-turn before the preflight can verify completion.
 *
 * FENCE ENFORCEMENT: claim_generation is REQUIRED for rows that have
 * claim_generation set in the DB. Providing no claim_generation for a fenced row
 * exits 3 (rejected). The legacy fallback path (no claim_generation, direct
 * completeInboxRow) has been removed — all completions must be fenced.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { initDB, getDB } = require('../src/db');
const rel = require('../src/bridge/lipaReliability');
const accounting = require('../src/bridge/lipaAccounting');

const [, , inboxIdStr, requestId, responseJson, originalSubject, inReplyTo, optionsJson] = process.argv;

if (!inboxIdStr || !responseJson) {
  console.error("Usage: lipa-bridge-respond.js <inbox_id> <request_id> '<response_json>' [original_subject] [in_reply_to] ['<options_json>']");
  process.exit(1);
}

initDB();

const inboxId = parseInt(inboxIdStr, 10);
const response = JSON.parse(responseJson);
const opts = optionsJson ? JSON.parse(optionsJson) : {};

// Resolve session_id: prefer options_json field, fall back to env var.
const sessionId = opts.session_id || process.env.OPENCLAW_SESSION_ID || null;

// ── Fence enforcement ─────────────────────────────────────────────────────────
// Look up the current row to check if it has claim_generation set in the DB.
// If it does and no claim_generation was provided in options, reject.
const dbRow = (() => {
  try { return getDB().prepare('SELECT claim_generation, status FROM bridge_lipa_inbox WHERE id = ?').get(inboxId); }
  catch (e) { return null; }
})();

if (opts.claim_generation == null) {
  // If the row has claim_generation set, the caller MUST provide it.
  if (dbRow && dbRow.claim_generation != null) {
    console.error(`[Lipa Bridge] FENCE REJECT: inbox_id=${inboxId} has claim_generation=${dbRow.claim_generation} in DB but none provided in options_json. Exiting 3.`);
    process.exit(3);
  }
  // Also reject if session_id is not available for any reason (belt-and-suspenders).
  if (!sessionId) {
    console.error(`[Lipa Bridge] FENCE REJECT: no claim_generation and no session_id (OPENCLAW_SESSION_ID unset and not in options_json). Exiting 3.`);
    process.exit(3);
  }
}

if (opts.claim_generation != null) {
  const cacheReadTokens = opts.cache_read_tokens == null ? null : opts.cache_read_tokens;
  const cacheWriteTokens = opts.cache_write_tokens == null ? null : opts.cache_write_tokens;
  const inputTokens = opts.input_tokens == null ? null : opts.input_tokens;
  const outputTokens = opts.output_tokens == null ? null : opts.output_tokens;

  const res = rel.completeClaim({
    inboxId,
    claimGeneration: opts.claim_generation,
    sessionId,
    response,
    originalSubject: originalSubject || null,
    inReplyTo: inReplyTo || null,
    providerMessageId: opts.provider_message_id || 'unknown',
    cacheReadTokens,
    cacheWriteTokens,
    inputTokens,
    outputTokens,
    uncertain: !!opts.uncertain,
    uncertainReason: opts.uncertain_reason || null,
  });

  // NOTE: Worker lock is NOT released here. The preflight wrapper owns lock
  // release and verifies DB state on clean exit before releasing.

  // Advisory cost accounting (never blocks/retries). Recorded on EVERY outcome —
  // a delivered response, an uncertain needs_review, OR a fenced/discarded late
  // completion — because the agent turn consumed provider tokens regardless of
  // whether its result was applied. Recording before the fenced early-exit is the
  // fix for spend being invisible whenever a completion loses the fence race.
  try {
    const rec = accounting.recordRequestCost({
      inboxId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
      model: opts.model || null,
      costUsd: opts.cost_usd == null ? null : opts.cost_usd,
    });
    const capCheck = accounting.checkRequestCap({ inboxId, cost: rec.cost });
    if (capCheck.alert) {
      console.error(`[Lipa Bridge] ⚠️ cumulative cost $${capCheck.cost.toFixed(2)} exceeded $${capCheck.cap} cap for inbox_id=${inboxId} (advisory — response still delivered)`);
    }
  } catch (e) { console.error('[Lipa Bridge] cost accounting failed:', e.message); }

  if (res.fenced) {
    console.error(`[Lipa Bridge] IGNORED stale/late completion for inbox_id=${inboxId} (fenced — cost still recorded)`);
    process.exit(2);
  }

  if (res.needsReview) {
    console.log(`[Lipa Bridge] inbox_id=${inboxId} → needs_review (uncertain side effect, not sent)`);
    process.exit(0);
  }
  console.log(`[Lipa Bridge] Response queued for inbox_id=${inboxId}${res.deduped ? ' (deduped — outbox already existed)' : ''}`);
  process.exit(0);
}

// No claim_generation provided, but the row also has no claim_generation in DB
// (fresh row, never claimed via the reliability layer). This path handles any
// rows that were enqueued before fencing was introduced — all such rows must not
// have claim_generation set in the DB (enforced above). We still require a
// session_id for minimal accountability.
console.error(`[Lipa Bridge] FENCE REJECT: inbox_id=${inboxId} — all completions must go through fenced path. Use claim_generation from poll.js output. Exiting 3.`);
process.exit(3);
