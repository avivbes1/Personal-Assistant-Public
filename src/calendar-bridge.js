/**
 * calendar-bridge.js
 *
 * Safety-net that sweeps notices with relevance_date and creates calendar entries
 * for any event-like notice that slipped past the realtime add_event tool.
 *
 * Design:
 *  - Uses the calendar_intents outbox table for idempotency and retry tracking
 *  - Fingerprint = SHA1(group_name + date + content_prefix) stored on calendar_intents
 *  - Called from:
 *    1. noticeDelivery.js afterDeliveryHook() — right after a notice is delivered
 *    2. Heartbeat sweeper — catches anything the hook missed
 */

'use strict';

const crypto  = require('crypto');
const { getDB } = require('./db');
const { addSharedEvent } = require('./calendar');
const config  = require('./config');

const MAX_ATTEMPTS = 3;

// ─── Event-type classification ────────────────────────────────────────────────
// Keywords that signal a calendar-worthy event in a notice's content.
const EVENT_PATTERNS = [
  { type: 'birthday',     re: /יום.?הולדת|מסיבת.?יום.?הולדת/i },
  { type: 'ceremony',     re: /טקס|סיום|בת.?מצווה|בר.?מצווה|מסיבת.?סיום|הצגת.?סיום/i },
  { type: 'trip',         re: /טיול|נסיעה|סיור/i },
  { type: 'school_event', re: /הפנינג|יום.?גיבוש|יום.?כיף|ספורטיאדה|חגיגה|אירוע/i },
  { type: 'appointment',  re: /פגישה|תור|ביקור/i },
];

/**
 * Classify notice content. Returns event_type string or null if not calendar-worthy.
 */
function classifyEvent(content) {
  if (!content) return null;
  for (const { type, re } of EVENT_PATTERNS) {
    if (re.test(content)) return type;
  }
  return null;
}

/**
 * Generate a stable fingerprint for deduplication.
 */
function fingerprint(groupName, date, contentPrefix) {
  const raw = [
    (groupName || '').trim(),
    (date || '').trim(),
    (contentPrefix || '').substring(0, 60).trim(),
  ].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex').substring(0, 16);
}

/**
 * Build a Google Calendar event payload from a notice row.
 */
function buildEventPayload(notice) {
  const title   = notice.event_title || _inferTitle(notice);
  const date    = notice.relevance_date;
  const time    = notice.relevance_time;
  const location = notice.event_location || null;

  const startIso = time ? `${date}T${time}:00` : date;
  const endIso   = time
    ? _addMinutes(`${date}T${time}:00`, 90)
    : date;

  return {
    title,
    start_time: startIso,
    end_time:   endIso,
    location,
    description: `מקור: ${notice.group_name || 'קבוצה'}\n${notice.content || ''}`,
  };
}

function _inferTitle(notice) {
  // Try to pull a short title from the content
  const content = notice.content || '';
  // First sentence or up to 40 chars
  const first = content.split(/[.\n]/)[0].trim();
  return first.length > 5 ? first.substring(0, 50) : content.substring(0, 50);
}

function _addMinutes(isoStr, mins) {
  try {
    return new Date(new Date(isoStr).getTime() + mins * 60000).toISOString().substring(0, 19);
  } catch {
    return isoStr;
  }
}

/**
 * Check whether a notice should get a calendar entry.
 * Returns { worthy: bool, event_type: string|null }
 */
function shouldCreateCalendar(notice) {
  // Must have a future relevance_date
  if (!notice.relevance_date) return { worthy: false };
  const dateMs = new Date(notice.relevance_date + 'T00:00:00').getTime();
  // Allow up to 1 day in the past (same-day events might be classified after the fact)
  if (dateMs < Date.now() - 86400000) return { worthy: false };

  // Already has a calendar entry on the notices row
  if (notice.calendar_status === 'applied') return { worthy: false };

  // Explicit flag from LLM extraction
  if (notice.calendar_worthy === 1) {
    return { worthy: true, event_type: notice.event_type || 'other' };
  }

  // Fallback: pattern-match the content
  const event_type = classifyEvent(notice.content);
  if (event_type) return { worthy: true, event_type };

  return { worthy: false };
}

/**
 * Create a calendar intent record (outbox) and attempt delivery.
 * Idempotent — will skip if fingerprint already exists.
 */
async function createCalendarForNotice(notice) {
  const db = getDB();

  const { worthy, event_type } = shouldCreateCalendar(notice);
  if (!worthy) {
    return { status: 'skipped', reason: 'not_calendar_worthy' };
  }

  const fp = fingerprint(notice.group_name, notice.relevance_date, notice.content);

  // Check for existing intent with same fingerprint
  const existing = db.prepare(
    'SELECT id, status, calendar_event_id FROM calendar_intents WHERE fingerprint = ?'
  ).get(fp);

  if (existing) {
    if (existing.status === 'applied') {
      // Mark the notice row too (in case it wasn't updated)
      db.prepare(
        'UPDATE notices SET calendar_status=?, calendar_event_id=? WHERE id=?'
      ).run('applied', existing.calendar_event_id, notice.id);
      return { status: 'already_applied', intentId: existing.id };
    }
    if (existing.status === 'pending' || existing.status === 'failed') {
      // Will be retried by sweeper — skip for now unless attempts < MAX
      const intent = db.prepare('SELECT * FROM calendar_intents WHERE id=?').get(existing.id);
      if ((intent.attempts || 0) >= MAX_ATTEMPTS) {
        return { status: 'max_attempts_reached', intentId: existing.id };
      }
    }
  }

  // Create intent record if it doesn't exist
  let intentId = existing ? existing.id : null;
  if (!intentId) {
    const payload = buildEventPayload(notice);
    const now = Date.now();
    const result = db.prepare(`
      INSERT INTO calendar_intents
        (source, event_title, event_date, event_start, event_end, raw_message,
         status, created_at, notice_id, fingerprint, event_location, attempts, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, 0, ?)
    `).run(
      'calendar_bridge',
      payload.title,
      notice.relevance_date,
      payload.start_time,
      payload.end_time,
      notice.content,
      now,
      notice.id,
      fp,
      payload.location || null,
      now
    );
    intentId = result.lastInsertRowid;

    // Update notices row
    db.prepare(
      'UPDATE notices SET fingerprint=?, event_type=?, calendar_status=? WHERE id=?'
    ).run(fp, event_type, 'pending', notice.id);
  }

  // Attempt calendar creation
  return await _attemptCalendarCreate(intentId, notice);
}

/**
 * Attempt to create a Google Calendar event for a given calendar_intents row.
 */
async function _attemptCalendarCreate(intentId, noticeHint) {
  const db = getDB();
  const intent = db.prepare('SELECT * FROM calendar_intents WHERE id=?').get(intentId);
  if (!intent) return { status: 'intent_not_found' };

  db.prepare('UPDATE calendar_intents SET attempts=attempts+1, updated_at=? WHERE id=?')
    .run(Date.now(), intentId);

  const notice = noticeHint || db.prepare('SELECT * FROM notices WHERE id=?').get(intent.notice_id);

  try {
    const payload = {
      title:       intent.event_title,
      start_time:  intent.event_start || intent.event_date,
      end_time:    intent.event_end   || intent.event_date,
      location:    intent.event_location || null,
      description: intent.raw_message
        ? `מקור: ${notice?.group_name || 'קבוצה'}\n${intent.raw_message}`
        : undefined,
    };

    const gcalResult = await addSharedEvent(payload, 'both');
    const gcalId = gcalResult?.id || null;

    // Mark success
    db.prepare(
      'UPDATE calendar_intents SET status=?, calendar_event_id=?, updated_at=? WHERE id=?'
    ).run('applied', gcalId, Date.now(), intentId);

    if (notice?.id) {
      db.prepare(
        'UPDATE notices SET calendar_status=?, calendar_event_id=?, calendar_attempts=calendar_attempts+1 WHERE id=?'
      ).run('applied', gcalId, notice.id);
    }

    console.log(`[CalendarBridge] ✅ Created calendar event for notice #${notice?.id} (intent #${intentId}): "${payload.title}" on ${intent.event_date}`);
    return { status: 'applied', gcalId, intentId };

  } catch (err) {
    const errMsg = err.message || String(err);
    const isNonRetriable = /invalid_grant|unauthorized|forbidden/i.test(errMsg);
    const newStatus = isNonRetriable ? 'failed' : 'pending'; // keep pending for retry

    db.prepare(
      'UPDATE calendar_intents SET status=?, last_error=?, updated_at=? WHERE id=?'
    ).run(newStatus, errMsg.substring(0, 200), Date.now(), intentId);

    if (notice?.id) {
      db.prepare(
        'UPDATE notices SET calendar_status=?, calendar_error=?, calendar_attempts=calendar_attempts+1 WHERE id=?'
      ).run('error', errMsg.substring(0, 200), notice.id);
    }

    console.error(`[CalendarBridge] ❌ Failed for notice #${notice?.id} (intent #${intentId}):`, errMsg);
    return { status: 'error', error: errMsg, intentId };
  }
}

/**
 * Sweeper — call from heartbeat.
 * Processes:
 *   1. Pending calendar_intents that haven't been applied yet
 *   2. Notices with relevance_date that are calendar_worthy but have no intent
 */
async function sweepPendingIntents() {
  const db = getDB();
  const results = [];

  // 1. Retry pending intents (not yet applied, under max attempts)
  const pendingIntents = db.prepare(`
    SELECT ci.*, n.content as notice_content, n.group_name as notice_group
    FROM calendar_intents ci
    LEFT JOIN notices n ON n.id = ci.notice_id
    WHERE ci.status = 'pending'
      AND (ci.attempts IS NULL OR ci.attempts < ?)
      AND ci.event_date >= date('now', '-1 day')
    ORDER BY ci.created_at ASC
    LIMIT 20
  `).all(MAX_ATTEMPTS);

  for (const intent of pendingIntents) {
    const notice = intent.notice_id
      ? db.prepare('SELECT * FROM notices WHERE id=?').get(intent.notice_id)
      : null;
    const r = await _attemptCalendarCreate(intent.id, notice);
    results.push({ intentId: intent.id, ...r });
    await _sleep(1000);
  }

  // 2. Notices with relevance_date that should have a calendar entry but don't
  const unprocessed = db.prepare(`
    SELECT * FROM notices
    WHERE relevance_date >= date('now', '-1 day')
      AND (calendar_status IS NULL OR calendar_status = 'n/a')
      AND delivery_status IN ('delivered_batch', 'delivered_immediate', 'delivered')
    ORDER BY relevance_date ASC
    LIMIT 30
  `).all();

  for (const notice of unprocessed) {
    const r = await createCalendarForNotice(notice);
    if (r.status !== 'skipped') {
      results.push({ noticeId: notice.id, ...r });
      await _sleep(1000);
    }
  }

  return results;
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  createCalendarForNotice,
  sweepPendingIntents,
  shouldCreateCalendar,
  buildEventPayload,
  fingerprint,
  classifyEvent,
};
