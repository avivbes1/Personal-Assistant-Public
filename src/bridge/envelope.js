'use strict';

/**
 * RAW-ONLY body sanitiser: strip AI-generated descriptions from media messages.
 * Images processed by vision arrive with body like "[תמונה: <long AI description>]";
 * RAW-ONLY mode should forward only the sender's caption or a bare marker.
 */
function _rawBody(body, mediaType) {
  if (!body || !mediaType) return body;
  if (mediaType === 'image' || mediaType === 'sticker') {
    // "[תמונה: <AI desc>] (caption: <real caption>)" → keep caption only
    const captionMatch = body.match(/\(caption:\s*(.+?)\)\s*$/);
    if (captionMatch) return captionMatch[1].trim();
    // "[תמונה: <AI desc>]" with no caption → bare marker
    if (/^\[תמונה[:\s]/.test(body)) return '[תמונה]';
  }
  return body;
}

/**
 * bridge/envelope.js — event record + envelope construction for the Instinct
 * Bridge, plus deterministic hashing and delivery-id generation.
 *
 * An "event record" is the per-event JSON we persist in bridge_outbox
 * (one row = one record). The exporter later claims a batch of records and
 * wraps them in a single "envelope" — the top-level JSON emailed to Instinct.
 *
 * All record builders redact sensitive text via bridge/policy so nothing
 * unredacted is ever persisted to the outbox.
 */

const crypto = require('crypto');

const SCHEMA_VERSION = '1.0';

/**
 * Deterministically stringify a value with object keys sorted, so the same
 * logical payload always produces the same string (and therefore the same
 * hash) regardless of key insertion order.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** sha256 hex of a payload (object or string). Deterministic for equal payloads. */
function computePayloadHash(payload) {
  const str = typeof payload === 'string' ? payload : stableStringify(payload);
  return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Generate a ULID-like unique id: a base36 timestamp prefix (lexically
 * sortable by creation time) followed by random hex. Uniqueness is what
 * callers rely on; sortability is a bonus.
 */
function generateDeliveryId() {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rand = crypto.randomBytes(10).toString('hex');
  return `del_${ts}${rand}`;
}

/**
 * Build a message event record (message.created / message.updated).
 * @param {object} msg       message row: {id, group_id, sender, body, timestamp, stanza_id}
 * @param {object} groupInfo {jid, name}
 */
function buildMessageRecord(msg, groupInfo = {}) {
  const policy = require('./policy');
  const ts = msg.timestamp != null ? Number(msg.timestamp) : null;
  return {
    kind: 'message',
    message_id: msg.id != null ? Number(msg.id) : null,
    stanza_id: msg.stanza_id || null,
    group: {
      jid: groupInfo.jid || msg.group_id || null,
      name: groupInfo.name || null,
    },
    sender: policy.redactSensitive(msg.sender || ''),
    sender_phone: msg.sender_phone || null,
    sender_lid: msg.sender_lid || null,
    body: _rawBody(policy.redactSensitive(msg.body || ''), msg.media_type),
    timestamp: ts,
    timestamp_iso: ts ? new Date(ts).toISOString() : null,
    // RAW-ONLY media attachment path (2026-10-02): carried so the email
    // transport can attach the original file without any model processing.
    media_path: msg.media_path || null,
    media_type: msg.media_type || null,
  };
}

/**
 * Build a notice event record (notice.upserted).
 * @param {object} notice           notice row
 * @param {number[]} sourceMessageIds  contributing message ids (may be empty)
 */
function buildNoticeRecord(notice, sourceMessageIds = []) {
  const policy = require('./policy');
  return {
    kind: 'notice',
    notice_id: notice.id != null ? Number(notice.id) : null,
    group_name: notice.group_name || null,
    content: policy.redactSensitive(notice.content || ''),
    tier: notice.tier || null,
    urgency_hint: notice.urgency_hint || null,
    relevance_date: notice.relevance_date || null,
    relevance_time: notice.relevance_time || null,
    primary_child: notice.primary_child || null,
    event_type: notice.event_type || null,
    calendar_worthy: notice.calendar_worthy ? 1 : 0,
    source_message_ids: Array.isArray(sourceMessageIds) ? sourceMessageIds.map(Number) : [],
    source_timestamp: notice.source_timestamp != null ? Number(notice.source_timestamp) : null,
    created_at: notice.created_at != null ? Number(notice.created_at) : null,
  };
}

/**
 * Wrap a list of event records into a single delivery envelope.
 * @param {string} stream  logical stream name (e.g. 'family-notices')
 * @param {object[]} events  event records (from buildMessageRecord/buildNoticeRecord)
 */
function buildEnvelope(stream, events = []) {
  const list = Array.isArray(events) ? events : [];
  return {
    schema_version: SCHEMA_VERSION,
    source: 'familybot',
    stream: stream || 'default',
    delivery_id: generateDeliveryId(),
    generated_at: new Date().toISOString(),
    event_count: list.length,
    events: list,
  };
}

module.exports = {
  SCHEMA_VERSION,
  stableStringify,
  computePayloadHash,
  generateDeliveryId,
  buildMessageRecord,
  buildNoticeRecord,
  buildEnvelope,
};
