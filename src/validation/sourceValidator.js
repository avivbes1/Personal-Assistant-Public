'use strict';
/**
 * sourceValidator.js — the core of the Hallucination Guard.
 *
 * A proactive outbound reminder is only allowed if it is grounded in a real,
 * current, not-yet-sent DB record. This module is the single place that decides
 * whether a (sourceType, sourceId) pair is a legitimate thing to remind about.
 *
 * Schema note: the task spec referenced a `calendar_events` table, but the
 * actual calendar-source table in data/family.db is `calendar_intents`
 * (columns: event_title, event_date, event_start ISO, calendar_event_id).
 * VALID_SOURCE_TYPES therefore maps to the real tables that exist.
 */

const crypto = require('crypto');
const { getDB } = require('../db');

// Logical source type → concrete table config (looked up from the live schema).
const SOURCE_TABLES = {
  // Child rows of a notice: dated/timed events extracted from monitored groups.
  notice_event: {
    table: 'notice_event',
    titleCol: 'event_title',
    // event time is derived from event_date (YYYY-MM-DD) + event_time (HH:MM|null)
    dateCol: 'event_date',
    timeCol: 'event_time',
  },
  // Calendar intents queued for / applied to Google Calendar.
  calendar_intents: {
    table: 'calendar_intents',
    titleCol: 'event_title',
    // Prefer the ISO event_start; fall back to event_date when start is null.
    dateCol: 'event_date',
    timeCol: null,
    startCol: 'event_start',
  },
};

const VALID_SOURCE_TYPES = Object.keys(SOURCE_TABLES);

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the epoch-ms "event moment" for a record, in Israel time.
 * Returns null if no usable date is present.
 */
function resolveEventTime(sourceType, record) {
  const cfg = SOURCE_TABLES[sourceType];

  // calendar_intents: prefer ISO event_start
  if (cfg.startCol && record[cfg.startCol]) {
    const t = new Date(record[cfg.startCol]).getTime();
    if (!Number.isNaN(t)) return t;
  }

  const dateStr = record[cfg.dateCol];
  if (!dateStr) return null;

  const timeStr = cfg.timeCol ? record[cfg.timeCol] : null;
  // Israel is UTC+3 (IDT) in summer / UTC+2 (IST) in winter. The rest of the
  // codebase anchors on +03:00 (see db.js saveNoticeEvents), so we match it.
  const hhmm = timeStr && /^\d{1,2}:\d{2}$/.test(timeStr) ? timeStr : '00:00';
  const [h, m] = hhmm.split(':').map(Number);
  const iso = `${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+03:00`;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * validateSource(sourceType, sourceId)
 * Returns { valid: true, record } or { valid: false, reason }.
 *
 * Checks, in order:
 *   1. sourceType is a known, valid table
 *   2. the record actually exists
 *   3. the event time is within -2h .. +24h of now
 *   4. it has not already been sent (sent_reminders ledger)
 */
function validateSource(sourceType, sourceId) {
  if (!VALID_SOURCE_TYPES.includes(sourceType)) {
    return { valid: false, reason: `invalid source_type "${sourceType}" (valid: ${VALID_SOURCE_TYPES.join(', ')})` };
  }

  const id = Number(sourceId);
  if (!Number.isInteger(id) || id <= 0) {
    return { valid: false, reason: `invalid source_id "${sourceId}"` };
  }

  const cfg = SOURCE_TABLES[sourceType];
  const db = getDB();

  const record = db.prepare(`SELECT * FROM ${cfg.table} WHERE id = ?`).get(id);
  if (!record) {
    return { valid: false, reason: `no ${sourceType} record with id=${id}` };
  }

  const eventTime = resolveEventTime(sourceType, record);
  if (eventTime == null) {
    return { valid: false, reason: `${sourceType} #${id} has no usable event time` };
  }

  const now = Date.now();
  const delta = eventTime - now;
  if (delta < -TWO_HOURS_MS) {
    return { valid: false, reason: `${sourceType} #${id} is in the past (>2h ago)` };
  }
  if (delta > TWENTY_FOUR_HOURS_MS) {
    return { valid: false, reason: `${sourceType} #${id} is more than 24h away` };
  }

  const already = db.prepare(
    'SELECT 1 FROM sent_reminders WHERE source_type = ? AND source_id = ?'
  ).get(sourceType, id);
  if (already) {
    return { valid: false, reason: `${sourceType} #${id} already reminded (in sent_reminders)` };
  }

  return { valid: true, record };
}

/**
 * recordSent — mark a (sourceType, sourceId) as reminded. Idempotent via the
 * UNIQUE(source_type, source_id) constraint.
 */
function recordSent(sourceType, sourceId, messageHash) {
  const hash = messageHash || crypto.createHash('sha256').update(String(messageHash || '')).digest('hex').slice(0, 16);
  const result = getDB().prepare(
    'INSERT OR IGNORE INTO sent_reminders (source_type, source_id, sent_at, message_hash) VALUES (?, ?, ?, ?)'
  ).run(sourceType, Number(sourceId), Date.now(), hash);
  return result.changes > 0;
}

/**
 * logBlocked — audit a refused proactive action.
 */
function logBlocked(actionType, payload, reason) {
  try {
    getDB().prepare(
      'INSERT INTO blocked_actions (action_type, payload_json, block_reason, created_at) VALUES (?, ?, ?, ?)'
    ).run(
      actionType || 'unknown',
      typeof payload === 'string' ? payload : JSON.stringify(payload || {}),
      reason || 'unspecified',
      Date.now()
    );
  } catch (e) {
    console.error('[sourceValidator] logBlocked error:', e.message);
  }
}

module.exports = { validateSource, recordSent, logBlocked, VALID_SOURCE_TYPES };
