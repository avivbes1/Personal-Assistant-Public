/**
 * llm-trace.js — Append-only trace of every LLM API call.
 *
 * Companion to audit-log.js: where the audit log records executed *actions*,
 * this records the *LLM calls* themselves — model, call site, token usage,
 * latency, tool calls, and success/failure. Lets us answer "what did we ask
 * the model, how long did it take, and what did it cost" after the fact.
 *
 * Each call appends one JSON line to data/llm-trace.jsonl. Logging must never
 * break the actual call flow, so every write is wrapped defensively.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR   = path.join(__dirname, '../data');
const TRACE_FILE = path.join(DATA_DIR, 'llm-trace.jsonl');

// Ensure data/ exists (idempotent; recursive avoids EEXIST races)
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

/** Generate a unique correlation id for a single LLM call. */
function makeCorrelationId() {
  try {
    return crypto.randomUUID();
  } catch (_) {
    return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  }
}

/**
 * Append one trace record for an LLM API call.
 *
 * @param {object} opts
 * @param {string} [opts.correlationId] Unique id for this call (auto-generated if omitted)
 * @param {string} opts.model           Model ID used
 * @param {string} opts.callSite        Where the call originated (e.g. 'agent.classify', 'media.vision')
 * @param {number} [opts.inputTokens]
 * @param {number} [opts.outputTokens]
 * @param {number} [opts.durationMs]    Wall-clock duration of the call
 * @param {Array}  [opts.toolCalls]     Tool names called (for tool_choice calls)
 * @param {boolean}[opts.success]       Whether the call succeeded
 * @param {string} [opts.error]         Error message if the call failed
 * @param {string} [opts.groupId]       Optional: which group triggered this
 * @param {string} [opts.messageId]     Optional: which message triggered this
 * @returns {string} The correlationId used for the record
 */
function traceCall(opts = {}) {
  const correlationId = opts.correlationId || makeCorrelationId();
  const record = {
    ts:            new Date().toISOString(),
    correlationId,
    model:         opts.model || null,
    callSite:      opts.callSite || 'unknown',
    inputTokens:   (typeof opts.inputTokens  === 'number') ? opts.inputTokens  : null,
    outputTokens:  (typeof opts.outputTokens === 'number') ? opts.outputTokens : null,
    durationMs:    (typeof opts.durationMs    === 'number') ? opts.durationMs   : null,
    toolCalls:     Array.isArray(opts.toolCalls) ? opts.toolCalls : [],
    success:       (typeof opts.success === 'boolean') ? opts.success : null,
    error:         opts.error || null,
    groupId:       opts.groupId   || null,
    messageId:     opts.messageId || null,
  };
  try {
    fs.appendFileSync(TRACE_FILE, JSON.stringify(record) + '\n');
  } catch (err) {
    // Never let trace logging break the actual call flow
    console.error('[LLMTrace] Failed to write trace record:', err.message);
  }
  return correlationId;
}

/**
 * Wrap src/llm/anthropic.js complete() with timing and automatic tracing.
 * Returns the same result complete() returns; on error, records the failure
 * trace and re-throws so callers see identical behavior.
 *
 * @param {object} opts     Passed straight through to complete()
 * @param {string} callSite Where the call originated (e.g. 'triage.summarize')
 * @param {object} [context]  Optional { groupId, messageId, correlationId }
 * @returns {Promise<object>} The result of complete()
 */
async function tracedComplete(opts, callSite, context = {}) {
  const { complete } = require('./llm/anthropic');
  const startMs = Date.now();
  try {
    const res = await complete(opts);
    const toolCalls = (res.content || [])
      .filter(c => c && c.type === 'tool_use')
      .map(c => c.name);
    traceCall({
      correlationId: context.correlationId,
      model:        opts.model || 'claude-haiku-4-5',
      callSite,
      inputTokens:  res.inputTokens,
      outputTokens: res.outputTokens,
      durationMs:   Date.now() - startMs,
      toolCalls,
      success:      true,
      groupId:      context.groupId,
      messageId:    context.messageId,
    });
    return res;
  } catch (err) {
    traceCall({
      correlationId: context.correlationId,
      model:        opts.model || 'claude-haiku-4-5',
      callSite,
      durationMs:   Date.now() - startMs,
      success:      false,
      error:        err.message,
      groupId:      context.groupId,
      messageId:    context.messageId,
    });
    throw err;
  }
}

module.exports = { traceCall, tracedComplete, makeCorrelationId, TRACE_FILE };
