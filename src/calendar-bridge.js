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
const { addSharedEvent, updateCalendarEvent } = require('./calendar');
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
  { type: 'meeting',      re: /אסיפ[הת]|אספ[הת]|ישיב[הת]|מפגש.?הורים|יום.?הורים|אסיפה.?כללית|ערב.?הורים/i },
  { type: 'class',        re: /חוג|אימון|שיעור|תרגול|קורס|סדנ[האת]/i },
  { type: 'holiday',      re: /חופש[הת]?|חג|סוכות|פסח|ראש.?השנה|שבועות|חנוכה|פורים|יום.?הזיכרון|יום.?העצמאות|יום.?כיפור/i },
  { type: 'exam',         re: /מבחן|בחינ[הת]|מבדק/i },
  { type: 'health',       re: /חיסון|בדיק[הת]|רופא|טיפול.?שיניים/i },
  { type: 'deadline',     re: /עד.?תאריך|תשלום.?עד|הרשמה.?עד|רישום.?עד|אחרון.?ל/i },
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
 * BUG-FIX 2026-08-13: fingerprint now ignores group_name so the same event
 * mentioned in different WhatsApp groups produces the same fingerprint.
 * Uses normalized content (stripped Hebrew prefixes ה/ו, punctuation) for
 * better cross-group matching.
 */
function _normalizeForFingerprint(text) {
  if (!text) return '';
  return text
    .replace(/[\u0591-\u05C7]/g, '')   // strip niqqud
    .replace(/[-–—:,.!?"'״]/g, ' ')    // punctuation to spaces
    .replace(/\bה/g, '')               // strip definite article
    .replace(/\bו/g, '')               // strip conjunction
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim()
    .substring(0, 40);                  // shorter prefix for fuzzy matching
}

function fingerprint(groupName, date, contentPrefix) {
  // NOTE: groupName is intentionally excluded from the hash so that
  // the same event from different groups gets the same fingerprint.
  const raw = [
    (date || '').trim(),
    _normalizeForFingerprint(contentPrefix),
  ].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex').substring(0, 16);
}

/**
 * Build a Google Calendar event payload from a notice row.
 */
function buildEventPayload(notice) {
  const baseTitle = notice.event_title || _inferTitle(notice);
  const date      = notice.relevance_date;
  const time      = notice.relevance_time;
  const location  = notice.event_location || null;

  // K3: a known date with no time is an all-day event, never a fabricated time.
  // Flag it in the title so the family knows the hour is still pending, and
  // record time_status so a later update can fill it in.
  const timeKnown = !!time;
  const title     = timeKnown ? baseTitle : `${baseTitle} — שעה טרם פורסמה`;

  const startIso = time ? `${date}T${time}:00` : date;
  const endIso   = time
    ? _addMinutes(`${date}T${time}:00`, 90)
    : date;

  return {
    title,
    start_time:  startIso,
    end_time:    endIso,
    location,
    description: `מקור: ${notice.group_name || 'קבוצה'}\n${notice.content || ''}`,
    time_status: timeKnown ? 'known' : 'unknown',
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
    if (existing.status === 'applied' || existing.status === 'adopted') {
      // Mark the notice row too (in case it wasn't updated)
      db.prepare(
        'UPDATE notices SET calendar_status=?, calendar_event_id=? WHERE id=?'
      ).run(existing.status, existing.calendar_event_id, notice.id);

      // H3: Check if this notice supplies a time that the existing intent lacks
      const correctionResult = await _tryTimeCorrection(db, existing, notice);
      if (correctionResult) return correctionResult;

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

  // H3: Even if fingerprint didn't match, check for existing intents on the same
  // date. Different notices about the same event (e.g. 1839 vs 2724 about the
  // same parents meeting) have different fingerprints but should trigger a time
  // correction rather than creating a duplicate.
  //
  // Match strategy: compare notice_event rows from this notice against existing
  // intent titles (notice_event titles are clean, like "אסיפת הורים", which
  // match calendar event summaries much better than raw notice content).
  if (!existing) {
    const sameDateIntents = db.prepare(
      "SELECT id, status, calendar_event_id, event_title FROM calendar_intents WHERE event_date = ? AND (status = 'applied' OR status = 'adopted') AND calendar_event_id IS NOT NULL"
    ).all(notice.relevance_date);

    if (sameDateIntents.length > 0) {
      // Check notice_event rows from this notice
      const neRows = db.prepare(
        'SELECT event_title, event_time FROM notice_event WHERE notice_id = ? AND event_date = ?'
      ).all(notice.id, notice.relevance_date);

      for (const ne of neRows) {
        const normNeTitle = _normalizeForFingerprint(ne.event_title);
        if (!normNeTitle) continue;
        for (const candidate of sameDateIntents) {
          const normCandidate = _normalizeForFingerprint(candidate.event_title);
          if (normCandidate && (normCandidate.includes(normNeTitle) || normNeTitle.includes(normCandidate))) {
            // Found a matching intent via notice_event — try time correction
            db.prepare('UPDATE notices SET calendar_status=?, calendar_event_id=? WHERE id=?')
              .run(candidate.status, candidate.calendar_event_id, notice.id);
            const correctionResult = await _tryTimeCorrection(db, candidate, notice);
            if (correctionResult) return correctionResult;
            return { status: 'already_applied', intentId: candidate.id };
          }
        }
      }

      // Also try raw title match (for notices without notice_event rows)
      const payload = buildEventPayload(notice);
      const normTitle = _normalizeForFingerprint(payload.title);
      if (normTitle) {
        for (const candidate of sameDateIntents) {
          const normCandidate = _normalizeForFingerprint(candidate.event_title);
          if (normCandidate && (normCandidate.includes(normTitle) || normTitle.includes(normCandidate))) {
            db.prepare('UPDATE notices SET calendar_status=?, calendar_event_id=? WHERE id=?')
              .run(candidate.status, candidate.calendar_event_id, notice.id);
            const correctionResult = await _tryTimeCorrection(db, candidate, notice);
            if (correctionResult) return correctionResult;
            return { status: 'already_applied', intentId: candidate.id };
          }
        }
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
         status, created_at, notice_id, fingerprint, event_location, attempts, updated_at, time_status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, 0, ?, ?)
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
      now,
      payload.time_status || 'known'
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

    // P-015 / H1: ground the write in the notice this intent came from.
    const gcalResult = await addSharedEvent(payload, 'both', intent.notice_id ?? notice?.id ?? null);
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

/**
 * H3: Try to correct the time on an existing calendar event when a new notice
 * supplies an explicit time that the intent doesn't have (or differs from).
 *
 * Sources checked: notice.relevance_time and notice_event rows for the same date.
 */
async function _tryTimeCorrection(db, existingIntent, notice) {
  // Load full intent row
  const intent = db.prepare('SELECT * FROM calendar_intents WHERE id = ?').get(existingIntent.id);
  if (!intent || !intent.calendar_event_id) return null;

  // Only correct if current time_status is 'unknown' or time differs
  const currentTimeStatus = intent.time_status || 'unknown';

  // Collect explicit times from this notice and its notice_event rows
  let newTime = null;
  let timeSource = null;

  // Check notice.relevance_time
  if (notice.relevance_time && /^\d{2}:\d{2}$/.test(notice.relevance_time)) {
    newTime = notice.relevance_time;
    timeSource = `notice #${notice.id} relevance_time`;
  }

  // Check notice_event rows for this date
  if (!newTime) {
    const neRows = db.prepare(
      'SELECT event_time, event_title, notice_id FROM notice_event WHERE event_date = ? AND event_time IS NOT NULL AND length(event_time) > 0'
    ).all(intent.event_date);

    // Find a notice_event whose title matches the intent's event
    const normIntentTitle = _normalizeForFingerprint(intent.event_title);
    for (const ne of neRows) {
      const normNeTitle = _normalizeForFingerprint(ne.event_title);
      if (normIntentTitle && normNeTitle &&
          (normIntentTitle.includes(normNeTitle) || normNeTitle.includes(normIntentTitle))) {
        newTime = ne.event_time;
        timeSource = `notice_event from notice #${ne.notice_id}`;
        break;
      }
    }
  }

  if (!newTime) return null;

  // Check if the existing event already has the correct time
  if (intent.event_start) {
    const existingTime = intent.event_start.includes('T')
      ? intent.event_start.split('T')[1].substring(0, 5)
      : null;
    if (existingTime === newTime && currentTimeStatus === 'known') {
      return null; // already correct
    }
  }

  // Patch the calendar event
  const newStartIso = `${intent.event_date}T${newTime}:00+03:00`;
  const endMinutes = 60; // default 1h for meetings
  const [h, m] = newTime.split(':').map(Number);
  const endMins = h * 60 + m + endMinutes;
  const newEndIso = `${intent.event_date}T${String(Math.floor(endMins / 60) % 24).padStart(2, '0')}:${String(endMins % 60).padStart(2, '0')}:00+03:00`;

  const oldTime = intent.event_start ? intent.event_start.split('T')[1]?.substring(0, 5) : 'unknown';

  try {
    const patch = {
      start: { dateTime: newStartIso, timeZone: 'Asia/Jerusalem' },
      end:   { dateTime: newEndIso, timeZone: 'Asia/Jerusalem' },
    };

    // Remove " — שעה טרם פורסמה" from title if present
    if (intent.event_title && intent.event_title.includes('שעה טרם פורסמה')) {
      patch.summary = intent.event_title.replace(/\s*—\s*שעה טרם פורסמה/, '').trim();
    }

    const result = await updateCalendarEvent(
      config.AVIV_CALENDAR_ID, config.AVIV_TOKEN_PATH,
      intent.calendar_event_id, patch, notice.id
    );

    if (result && result.ok !== false) {
      // Update the intent
      const now = Date.now();
      db.prepare(`
        UPDATE calendar_intents
        SET event_start = ?, event_end = ?, time_status = 'known', updated_at = ?,
            event_title = COALESCE(?, event_title)
        WHERE id = ?
      `).run(newStartIso, newEndIso, now, patch.summary || null, intent.id);

      console.log(`[CalendarBridge] ✅ H3 TIME CORRECTED: "${intent.event_title}" ${intent.event_date} — ${oldTime} → ${newTime} (source: ${timeSource})`);

      return {
        status: 'time_corrected',
        intentId: intent.id,
        oldTime,
        newTime,
        source: timeSource,
        // Notification text for guardedSend
        notification: `עדכנתי — ${intent.event_title} ${intent.event_date} מ-${oldTime} ל-${newTime} (לפי הודעה מהקבוצה).`,
      };
    }
  } catch (err) {
    console.error(`[CalendarBridge] H3 time correction failed for intent #${intent.id}:`, err.message);
  }

  return null;
}

module.exports = {
  createCalendarForNotice,
  sweepPendingIntents,
  shouldCreateCalendar,
  buildEventPayload,
  fingerprint,
  classifyEvent,
};
