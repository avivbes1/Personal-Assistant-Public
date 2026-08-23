/**
 * audit-log.js — Append-only audit trail for every tool/action execution.
 *
 * Motivation (calendar permission hallucination incident):
 * The LLM claimed it deleted an event without ever emitting/executing a
 * delete_event action block. A durable, structured audit trail lets us prove
 * after the fact whether an action was actually attempted and what it returned.
 *
 * Each executed action appends one JSON line to data/tool-audit.jsonl.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR   = path.join(__dirname, '../data');
const AUDIT_FILE = path.join(DATA_DIR, 'tool-audit.jsonl');

// Ensure data/ exists (idempotent; recursive avoids EEXIST races)
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

const MAX_STR = 300;

/**
 * Produce a shallow, log-safe copy of the action args:
 *  - drop internal plumbing fields (leading underscore, e.g. _rawMessage)
 *  - drop the raw API key if it ever leaked in
 *  - truncate long strings so the log stays readable
 */
function sanitizeArgs(args) {
  if (!args || typeof args !== 'object') return args ?? null;
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (key.startsWith('_')) continue;            // internal fields (_rawMessage, _correlationId, ...)
    if (/key|token|secret|password/i.test(key)) { out[key] = '[redacted]'; continue; }
    if (typeof value === 'string') {
      out[key] = value.length > MAX_STR ? value.slice(0, MAX_STR) + '…' : value;
    } else if (value && typeof value === 'object') {
      // one level deep is enough for our action blocks
      try { out[key] = JSON.parse(JSON.stringify(value)); } catch (_) { out[key] = '[unserializable]'; }
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Derive a short human-readable summary from an action result.
 * Results are heterogeneous across action types, so we pull the few
 * fields that carry meaning without dumping the whole object.
 */
function summarizeResult(result) {
  if (result == null) return { ok: null, summary: 'no result (null)' };
  if (typeof result !== 'object') return { ok: null, summary: String(result) };

  const parts = [];
  if (result.type)     parts.push(`type=${result.type}`);
  if (result.action)   parts.push(`action=${result.action}`);
  if (result.reason)   parts.push(`reason=${result.reason}`);
  if (result.error)    parts.push(`error=${result.error}`);
  if (Array.isArray(result.deleted)) parts.push(`deleted=[${result.deleted.join(', ')}]`);
  if (Array.isArray(result.updated)) parts.push(`updated=[${result.updated.join(', ')}]`);
  if (result.title)    parts.push(`title=${result.title}`);

  // Prefer explicit ok; otherwise infer from calendarGate-style action outcome
  let ok = (typeof result.ok === 'boolean') ? result.ok : null;
  if (ok === null && result.action) ok = ['created', 'updated'].includes(result.action);

  return { ok, summary: parts.join(' ') || 'ok' };
}

/**
 * Append one audit record for a tool/action execution.
 *
 * @param {string} action        Action name (e.g. 'delete_event')
 * @param {object} args          The raw action block / tool args (sanitized before write)
 * @param {object} result        The result returned by the executor
 * @param {string} correlationId Correlates all actions from a single message turn
 * @param {number} [durationMs]  Wall-clock duration of the execution
 */
function logToolCall(action, args, result, correlationId, durationMs) {
  const { ok, summary } = summarizeResult(result);
  const record = {
    timestamp:     new Date().toISOString(),
    action:        action || (args && args.action) || 'unknown',
    args:          sanitizeArgs(args),
    ok,
    resultSummary: summary,
    durationMs:    (typeof durationMs === 'number') ? durationMs : null,
    correlationId: correlationId || null,
  };
  try {
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(record) + '\n');
  } catch (err) {
    // Never let audit logging break the actual action flow
    console.error('[AuditLog] Failed to write audit record:', err.message);
  }
}

/** Generate a correlation id for one message-handling turn. */
let _counter = 0;
function makeCorrelationId() {
  _counter = (_counter + 1) % 1e6;
  return `${Date.now().toString(36)}-${_counter.toString(36)}`;
}

module.exports = { logToolCall, makeCorrelationId, sanitizeArgs, summarizeResult, AUDIT_FILE };
