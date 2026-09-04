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

// ── G1: calendar-write source grounding ─────────────────────────────────────────
// A calendar event proposed by an *agent* (Lipa / OpenClaw) — as opposed to one
// derived by calendar-bridge.js from a notice's own fields — must be grounded in
// a real source notice. Every non-null proposed field (date, time, location) has
// to appear in that notice; a value the source does not contain is treated as
// fabricated and the write is rejected. This is the guard that would have caught
// ISSUE-025 (Lipa inventing an 18:30 parent-meeting time the notice never stated).

/**
 * Plausible textual forms an ISO date (YYYY-MM-DD) could take in a Hebrew
 * WhatsApp notice: "9.9", "09/09", "9.9.2026", "9.9.26", the ISO itself, etc.
 * Israel writes day-first (D.M / D.M.Y), so we only emit day-before-month forms.
 */
function dateVariants(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) return [];
  const [, yyyy, mm, dd] = m;
  const yy = yyyy.slice(2);
  const days = [String(Number(dd)), dd];    // "9" and "09"
  const months = [String(Number(mm)), mm];  // "9" and "09"
  const seps = ['.', '/', '-'];
  const out = new Set([isoDate]);
  for (const d of days) {
    for (const mo of months) {
      for (const sep of seps) {
        out.add(`${d}${sep}${mo}`);
        out.add(`${d}${sep}${mo}${sep}${yyyy}`);
        out.add(`${d}${sep}${mo}${sep}${yy}`);
      }
    }
  }
  return [...out];
}

/** Plausible textual forms of an HH:MM time ("18:30", "18.30", "8:30", "08:30"). */
function timeVariants(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return [String(hhmm || '').trim()].filter(Boolean);
  const [, h, min] = m;
  const hp = h.padStart(2, '0');
  return [...new Set([`${h}:${min}`, `${hp}:${min}`, `${h}.${min}`, `${hp}.${min}`])];
}

function anyAppearsIn(haystack, variants) {
  if (!haystack) return false;
  const s = String(haystack);
  return variants.some(v => v && s.includes(v));
}

/**
 * validateCalendarWrite(sourceNoticeId, proposedFields)
 * Returns { valid: true } or { valid: false, reason, ungrounded_fields: [...] }.
 *
 * proposedFields: { date?: 'YYYY-MM-DD', time?: 'HH:MM', location?: string, summary?: string }
 *
 * Grounding rules (P-015 — a value absent from the source is never inferred):
 *   - date     : must equal notice.relevance_date, or appear (in any plausible
 *                Hebrew form) in notice.content.
 *   - time     : must equal notice.relevance_time, or appear in notice.content.
 *                A time the source never states is a REJECTION.
 *   - location : must appear (case-insensitive substring) in notice.content.
 * summary is not grounded — it is a human-facing label, not a factual claim.
 */
function validateCalendarWrite(sourceNoticeId, proposedFields = {}) {
  const id = Number(sourceNoticeId);
  if (!Number.isInteger(id) || id <= 0) {
    return { valid: false, reason: `invalid source_notice_id "${sourceNoticeId}"`, ungrounded_fields: [] };
  }

  const notice = getDB().prepare('SELECT * FROM notices WHERE id = ?').get(id);
  if (!notice) {
    return { valid: false, reason: `no notice with id=${id}`, ungrounded_fields: [] };
  }

  const content = notice.content || '';
  const ungrounded = [];

  if (proposedFields.date) {
    const grounded =
      (notice.relevance_date && notice.relevance_date === proposedFields.date) ||
      anyAppearsIn(content, dateVariants(proposedFields.date));
    if (!grounded) ungrounded.push('date');
  }

  if (proposedFields.time) {
    const grounded =
      (notice.relevance_time && notice.relevance_time === proposedFields.time) ||
      anyAppearsIn(content, timeVariants(proposedFields.time));
    if (!grounded) ungrounded.push('time');
  }

  if (proposedFields.location) {
    const loc = String(proposedFields.location).trim();
    if (loc && !content.toLowerCase().includes(loc.toLowerCase())) {
      ungrounded.push('location');
    }
  }

  if (ungrounded.length > 0) {
    return {
      valid: false,
      reason: `calendar write for notice #${id} proposes field(s) absent from the source: ${ungrounded.join(', ')}`,
      ungrounded_fields: ungrounded,
    };
  }
  return { valid: true };
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

module.exports = { validateSource, validateCalendarWrite, recordSent, logBlocked, VALID_SOURCE_TYPES };
