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
 *     "uncertain":          true,   // uncertain MUTATING work → needs_review, no send
 *     "uncertain_reason":  "…"
 *   }
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
  const res = rel.completeClaim({
    inboxId,
    claimGeneration: opts.claim_generation,
    sessionId: opts.session_id || null,
    response,
    originalSubject: originalSubject || null,
    inReplyTo: inReplyTo || null,
    providerMessageId: opts.provider_message_id || 'unknown',
    cacheReadTokens: opts.cache_read_tokens == null ? null : opts.cache_read_tokens,
    cacheWriteTokens: opts.cache_write_tokens == null ? null : opts.cache_write_tokens,
    uncertain: !!opts.uncertain,
    uncertainReason: opts.uncertain_reason || null,
  });
  if (res.fenced) {
    console.error(`[Lipa Bridge] IGNORED stale/late completion for inbox_id=${inboxId} (fenced)`);
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
