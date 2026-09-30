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
 * On completion this script also RELEASES the global worker lock (held across the
 * agent turn by scripts/lipa-bridge-poll.js) and records an advisory lower-bound
 * cost for the request (soft daily/per-request caps — never blocks or retries).
 *
 * When claim_generation is present the write goes through completeClaim(), which
 * FENCES stale/late completions (a completion for a row that was already retried
 * or reconciled is ignored, not applied). Without it we fall back to the legacy
 * completeInboxRow() path for backward compatibility.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { initDB } = require('../src/db');
const { completeInboxRow } = require('../src/bridge/lipaLane');
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

if (opts.claim_generation != null) {
  const sessionId = opts.session_id || null;
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

  // The agent turn has now finished executing: release the global worker lock so
  // the next poll cycle can proceed (the lock was deliberately held across the
  // turn by lipa-bridge-poll.js). WORKER_LOCK_TTL_MS is the crash safety net.
  try { rel.releaseWorkerLock(sessionId); } catch (_) {}

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
    const capCheck = accounting.checkRequestCap(rec.cost);
    if (capCheck.alert) {
      console.error(`[Lipa Bridge] ⚠️ request cost $${capCheck.cost.toFixed(2)} exceeded $${capCheck.cap} cap for inbox_id=${inboxId} (advisory — response still delivered)`);
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

// Legacy fallback (no fencing) — kept so older callers keep working.
completeInboxRow(inboxId, requestId || null, response, originalSubject || null, inReplyTo || null);
console.log(`[Lipa Bridge] Response queued for inbox_id=${inboxId} (legacy path)`);
