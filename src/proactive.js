'use strict';
/**
 * proactive.js — Phase G proactivity: the bot reaches out first.
 *
 * Two grounded, send-once proactive behaviours:
 *   G1 missing_time    — a calendar-worthy notice has a date but no time yet.
 *                        We flag it, then quietly resolve it when the time lands.
 *   G3 obligation_nudge — a notice states an explicit deadline; one T-24h reminder.
 *
 * Every outbound message goes through guardedSendProactive (delivery/guardedSend),
 * which grounds it against a real, undismissed notice. Message text here is
 * deterministic (built from DB fields) — never authored by an LLM.
 */

const crypto = require('crypto');
const config = require('./config');
const { getDB } = require('./db');
// Referenced through the module object (not destructured) so tests can stub the
// grounded send path without a live voice-server. The grounding guarantee lives
// inside guardedSendProactive; callers here still build deterministic text.
const guardedSend = require('./delivery/guardedSend');
const { israelDateIso, addDaysIso } = require('./timeUtils');
const { extractExplicitDate, extractHebrewWeekday, nextOccurrence, resolveNoticeDate } = require('./date-parse');

const TZ = config.TIMEZONE || 'Asia/Jerusalem';
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Formatting helpers ────────────────────────────────────────────────────────

/** A YYYY-MM-DD date as a Hebrew "יום שני, 7.9" label (Israel time). */
function formatHebrewDate(dateIso) {
  if (!dateIso) return '';
  try {
    return new Date(`${dateIso}T12:00:00+03:00`).toLocaleDateString('he-IL', {
      weekday: 'long', day: 'numeric', month: 'numeric', timeZone: TZ,
    });
  } catch (_) {
    return dateIso;
  }
}

/** First line of a notice, trimmed to `max` chars for a one-line summary. */
function summarize(content, max = 60) {
  const firstLine = String(content || '').split('\n')[0].trim();
  return firstLine.length > max ? firstLine.slice(0, max).trim() + '…' : firstLine;
}

// ── G3: deadline detection ────────────────────────────────────────────────────

// Explicit "there is a deadline" phrasings. Each is a strong signal on its own;
// "עד <date>" / "עד יום" are only trusted when a date actually follows.
const DEADLINE_TRIGGERS = [
  /מועד\s+אחרון/,
  /להגיש\s+עד/,
  /להחזיר\s+עד/,
  /לשלוח\s+עד/,
  /לשלם\s+עד/,
  /עד\s+יום/,
  /עד\s+ל?תאריך/,
];

/**
 * Detect an explicit deadline in a notice and extract its date + a short
 * obligation description. Returns { deadlineDate:'YYYY-MM-DD', obligationText,
 * deadlineSource } or null when there's no deadline-like phrasing.
 *
 * Q1: accepts the full notice row (a bare content string is still tolerated for
 * unit tests). The deadline PHRASING is always detected from the content — not
 * every dated notice is an obligation — but the DATE itself is resolved through
 * resolveNoticeDate() first, so a weekday correction already stored on the notice
 * (or its notice_event) wins over re-parsing the raw text. Only when nothing
 * structured is available do we fall back to parsing the date from the text
 * after the trigger phrase (so "החזרת ספרים עד 7.9" reads the 7.9), preferring
 * an explicit digit date and then a Hebrew weekday name's next occurrence.
 *
 * @param {object|string} notice a notices row, or (legacy) raw content
 */
function detectObligationDeadline(notice) {
  const isRow = notice && typeof notice === 'object';
  const text = String((isRow ? notice.content : notice) || '');
  if (!text) return null;

  // Find the earliest trigger, plus a generic "עד <digit-date>" fallback.
  let triggerIdx = -1;
  for (const rx of DEADLINE_TRIGGERS) {
    const m = rx.exec(text);
    if (m && (triggerIdx === -1 || m.index < triggerIdx)) triggerIdx = m.index;
  }
  if (triggerIdx === -1) {
    const generic = /עד\s+\S{0,4}\d{1,2}[./]\d{1,2}/.exec(text);
    if (generic) triggerIdx = generic.index;
  }
  if (triggerIdx === -1) return null;

  // Q1: prefer the notice's already-resolved date (weekday corrections included).
  let deadlineDate = null;
  let deadlineSource = null;
  if (isRow) {
    const resolved = resolveNoticeDate(notice);
    if (resolved && resolved.iso) { deadlineDate = resolved.iso; deadlineSource = resolved.source; }
  }

  // Fallback: parse a date from the trigger onward; fall back to whole text.
  if (!deadlineDate) {
    const tail = text.slice(triggerIdx);
    const explicit = extractExplicitDate(tail) || extractExplicitDate(text);
    if (explicit) {
      deadlineDate = explicit.iso;
      deadlineSource = 'content_explicit';
    } else {
      const wd = extractHebrewWeekday(tail);
      if (wd != null) { deadlineDate = nextOccurrence(wd).iso; deadlineSource = 'content_weekday'; }
    }
  }
  if (!deadlineDate) return null;

  return { deadlineDate, obligationText: summarize(text, 80), deadlineSource };
}

/**
 * Q2: stable key identifying the OBLIGATION a nudge is about, so three notices
 * describing the same task (different notice_ids, even different thread_keys)
 * dedup to one nudge. Prefers the thread_key when present; otherwise a sha1 of
 * (child, deadline, normalized obligation text) using the same content
 * normalization the calendar fingerprint uses.
 */
function computeObligationKey({ threadKey, childName, deadlineDate, obligationText } = {}) {
  if (threadKey) return String(threadKey);
  const { _normalizeForFingerprint } = require('./calendar-bridge');
  const raw = [
    childName || '',
    deadlineDate || '',
    _normalizeForFingerprint(obligationText || ''),
  ].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex').substring(0, 16);
}

// ── Recording (called from agent.js after saveNotice) ─────────────────────────

/**
 * G1: record a pending missing_time prompt for a notice, unless one already
 * exists for it. Returns the row id, the existing id, or null.
 */
function recordMissingTimePrompt(noticeId) {
  if (!noticeId) return null;
  const db = getDB();
  const existing = db.prepare(
    "SELECT id FROM proactive_prompts WHERE notice_id = ? AND prompt_type = 'missing_time' LIMIT 1"
  ).get(noticeId);
  if (existing) return existing.id;
  const r = db.prepare(
    "INSERT INTO proactive_prompts (notice_id, prompt_type, status) VALUES (?, 'missing_time', 'pending')"
  ).run(noticeId);
  console.log(`[Proactive] Recorded missing_time prompt for notice #${noticeId}`);
  return r.lastInsertRowid;
}

/**
 * G3/Q2: record a T-24h obligation nudge, deduped by OBLIGATION rather than by
 * notice. UNIQUE(obligation_key, deadline_date) + INSERT OR IGNORE make this
 * idempotent — at most one row per (obligation, deadline). When a second notice
 * about the same obligation lands, we don't create a new nudge; we append its id
 * to the existing row's notice_ids for traceability.
 */
function recordObligationNudge(noticeId, { deadlineDate, obligationText, childName, deadlineSource } = {}) {
  if (!noticeId || !deadlineDate) return null;
  const db = getDB();

  let threadKey = null;
  try { threadKey = db.prepare('SELECT thread_key FROM notices WHERE id=?').get(noticeId)?.thread_key || null; } catch (_) {}
  const obligationKey = computeObligationKey({ threadKey, childName, deadlineDate, obligationText });

  const r = db.prepare(
    `INSERT OR IGNORE INTO obligation_nudges
       (notice_id, notice_ids, obligation_key, deadline_date, deadline_source, child_name, obligation_text, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).run(noticeId, JSON.stringify([noticeId]), obligationKey, deadlineDate, deadlineSource || null, childName || null, obligationText || null);

  if (r.changes > 0) {
    console.log(`[Proactive] Recorded obligation nudge for notice #${noticeId} due ${deadlineDate} (key=${obligationKey}, source=${deadlineSource || 'content'})`);
    return r.lastInsertRowid;
  }

  // Q2: collision — same obligation+deadline already tracked. Record this notice
  // as a contributor so the row stays traceable to every source.
  const existing = db.prepare(
    'SELECT id, notice_ids FROM obligation_nudges WHERE obligation_key = ? AND deadline_date = ?'
  ).get(obligationKey, deadlineDate);
  if (existing) {
    _addContributingNotice(db, existing, noticeId);
    console.log(`[Proactive] Obligation nudge #${existing.id} already tracks ${deadlineDate} (key=${obligationKey}); linked notice #${noticeId}`);
  }
  return null;
}

/** Append noticeId to a nudge row's notice_ids JSON array (idempotent). */
function _addContributingNotice(db, row, noticeId) {
  let ids = [];
  try { ids = JSON.parse(row.notice_ids || '[]'); } catch (_) { ids = []; }
  if (!Array.isArray(ids)) ids = [];
  if (!ids.includes(noticeId)) {
    ids.push(noticeId);
    db.prepare('UPDATE obligation_nudges SET notice_ids=? WHERE id=?').run(JSON.stringify(ids), row.id);
  }
}

// ── G1: missing_time send + resolve ───────────────────────────────────────────

/**
 * Send pending missing_time prompts to the master group. Only considers notices
 * created in the last 48h that are calendar-worthy, dated, still time-less and
 * not dismissed. A prompt whose notice already gained a time is marked resolved
 * instead of sent (self-healing). Returns { checked, sent, resolved }.
 */
async function checkMissingTimePrompts() {
  const db = getDB();
  const cutoff = Date.now() - 2 * DAY_MS;
  const rows = db.prepare(
    `SELECT pp.id AS prompt_id, n.id AS notice_id, n.content, n.relevance_date, n.relevance_time,
            n.primary_child, n.group_name, n.dismissed, n.calendar_worthy
       FROM proactive_prompts pp
       JOIN notices n ON n.id = pp.notice_id
      WHERE pp.prompt_type = 'missing_time'
        AND pp.status = 'pending'
        AND n.created_at >= ?
      ORDER BY pp.created_at ASC`
  ).all(cutoff);

  let sent = 0, resolved = 0;
  for (const row of rows) {
    // Self-heal: the gap was filled (or the notice went away) before we sent.
    if (row.dismissed || (row.relevance_time && row.relevance_time !== '')) {
      db.prepare(
        "UPDATE proactive_prompts SET status='resolved', resolved_at=?, resolved_value=? WHERE id=?"
      ).run(Date.now(), row.relevance_time || null, row.prompt_id);
      resolved++;
      continue;
    }
    if (!row.calendar_worthy || !row.relevance_date) continue;

    const who = row.primary_child || row.group_name || 'עדכון';
    const text = `📋 ${who}: ${summarize(row.content)} ב-${formatHebrewDate(row.relevance_date)} — שעה טרם פורסמה. אעדכן כשתתפרסם.`;

    const result = await guardedSend.guardedSendProactive({ text, noticeId: row.notice_id, promptType: 'missing_time' });
    if (result.sent) {
      db.prepare(
        "UPDATE proactive_prompts SET status='sent', sent_at=?, message_text=? WHERE id=?"
      ).run(Date.now(), text, row.prompt_id);
      sent++;
    }
  }

  if (rows.length) console.log(`[Proactive] missing_time: checked=${rows.length} sent=${sent} resolved=${resolved}`);
  return { checked: rows.length, sent, resolved };
}

/**
 * Resolve a missing_time prompt: fill the notice's relevance_time and mark any
 * pending/sent missing_time prompt for it resolved. Best-effort: if the notice
 * already has a calendar event, patch its time too. Returns { resolved, patched }.
 */
async function resolveMissingTime(noticeId, time) {
  if (!noticeId || !time) return { resolved: false, patched: false };
  const db = getDB();
  const notice = db.prepare('SELECT * FROM notices WHERE id = ?').get(Number(noticeId));
  if (!notice) return { resolved: false, patched: false };

  // Fill the time if the notice still lacks one.
  if (!notice.relevance_time) {
    db.prepare('UPDATE notices SET relevance_time = ? WHERE id = ?').run(time, notice.id);
  }
  const upd = db.prepare(
    "UPDATE proactive_prompts SET status='resolved', resolved_at=?, resolved_value=? " +
    "WHERE notice_id=? AND prompt_type='missing_time' AND status IN ('pending','sent')"
  ).run(Date.now(), time, notice.id);
  const resolved = upd.changes > 0;
  if (resolved) console.log(`[Proactive] Resolved missing_time for notice #${notice.id} → ${time}`);

  // Best-effort calendar patch: only if a calendar event was already created.
  let patched = false;
  if (notice.calendar_event_id && notice.relevance_date) {
    try {
      const { updateCalendarEvent } = require('./calendar');
      const startIso = `${notice.relevance_date}T${time}:00`;
      const endIso = `${notice.relevance_date}T${_addHour(time)}:00`;
      const patch = {
        start: { dateTime: new Date(startIso).toISOString(), timeZone: TZ },
        end: { dateTime: new Date(endIso).toISOString(), timeZone: TZ },
      };
      // Events are created on Aviv's calendar by default (addSharedEvent).
      // P-015 / H1: this patch is grounded in the notice that supplied the time.
      const r = await updateCalendarEvent(config.AVIV_CALENDAR_ID, config.AVIV_TOKEN_PATH, notice.calendar_event_id, patch, notice.id);
      patched = !!(r && r.ok !== false);
    } catch (e) {
      console.warn('[Proactive] resolveMissingTime calendar patch failed (non-fatal):', e.message);
    }
  }
  return { resolved, patched };
}

/** Add one hour to an "HH:MM" string (clamped to 23:59). */
function _addHour(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return hhmm;
  let total = Math.min(Number(m[1]) * 60 + Number(m[2]) + 60, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * When a fresh message supplies a time, resolve a matching pending missing_time
 * prompt on an EARLIER notice (same thread first, else same group) within 48h.
 * Called from agent.js after a new notice with a time is saved.
 * @returns {Promise<{resolved:boolean, noticeId?:number}>}
 */
async function tryResolveMissingTime({ groupName, threadKey, time, excludeNoticeId } = {}) {
  if (!time) return { resolved: false };
  const db = getDB();
  const since = Date.now() - 2 * DAY_MS;

  const find = (whereExtra, param) => db.prepare(
    `SELECT pp.notice_id AS notice_id
       FROM proactive_prompts pp
       JOIN notices n ON n.id = pp.notice_id
      WHERE pp.prompt_type = 'missing_time' AND pp.status IN ('pending','sent')
        AND n.dismissed = 0 AND (n.relevance_time IS NULL OR n.relevance_time = '')
        AND n.created_at >= ? AND pp.notice_id != ? AND ${whereExtra}
      ORDER BY pp.created_at DESC LIMIT 1`
  ).get(since, Number(excludeNoticeId) || 0, param);

  let match = null;
  if (threadKey) match = find('n.thread_key = ?', threadKey);
  if (!match && groupName) match = find('n.group_name = ?', groupName);
  if (!match) return { resolved: false };

  const r = await resolveMissingTime(match.notice_id, time);
  return { resolved: r.resolved, noticeId: match.notice_id };
}

// ── G3: obligation nudge send ─────────────────────────────────────────────────

/**
 * Send obligation nudges that are due within the T-24h window and still pending.
 *
 * Q4: the window is [today, tomorrow], not just "tomorrow" — so a sweep that was
 * skipped for a day still fires a (late) nudge on the deadline day rather than
 * losing it forever. Deadlines that have already fully passed (< today) are
 * marked 'missed' with a logged count instead of firing stale reminders.
 *
 * Q3: immediately before sending, each nudge's deadline is re-resolved from the
 * current notice state (via the Q1 resolver). If a correction landed after the
 * nudge was recorded, the row is updated and re-evaluated — send now, leave
 * pending for a future day, or cancel if the corrected deadline is already past.
 *
 * Returns { checked, sent, rescheduled, cancelled, missed }.
 */
async function checkObligationNudges() {
  const db = getDB();
  const today = israelDateIso();
  const tomorrow = addDaysIso(today, 1);

  // Q4: sweep away deadlines that already lapsed while still pending.
  const overdue = db.prepare(
    "UPDATE obligation_nudges SET status='missed' WHERE status='pending' AND deadline_date < ?"
  ).run(today);
  if (overdue.changes > 0) {
    console.log(`[Proactive] obligation_nudge: marked ${overdue.changes} overdue nudge(s) as missed`);
  }

  const rows = db.prepare(
    `SELECT o.id AS nudge_id, o.notice_id, o.deadline_date, o.obligation_text, o.child_name, o.deadline_source
       FROM obligation_nudges o
      WHERE o.deadline_date >= ? AND o.deadline_date <= ? AND o.status = 'pending'
      ORDER BY o.created_at ASC`
  ).all(today, tomorrow);

  let sent = 0, rescheduled = 0, cancelled = 0;
  for (const row of rows) {
    const notice = db.prepare('SELECT * FROM notices WHERE id = ?').get(row.notice_id);
    if (!notice || notice.dismissed) {
      db.prepare("UPDATE obligation_nudges SET status='skipped' WHERE id=?").run(row.nudge_id);
      continue;
    }

    // Q3: re-resolve the deadline from the current notice state and persist any
    // change before deciding whether to send.
    let effectiveDeadline = row.deadline_date;
    try {
      const redetected = detectObligationDeadline(notice);
      if (redetected && redetected.deadlineDate && redetected.deadlineDate !== row.deadline_date) {
        console.log(`[Proactive] obligation_nudge #${row.nudge_id}: deadline ${row.deadline_date} → ${redetected.deadlineDate} (source: ${redetected.deadlineSource || 'content'})`);
        db.prepare('UPDATE obligation_nudges SET deadline_date=?, deadline_source=? WHERE id=?')
          .run(redetected.deadlineDate, redetected.deadlineSource || null, row.nudge_id);
        effectiveDeadline = redetected.deadlineDate;
      }
    } catch (e) {
      console.warn('[Proactive] obligation re-resolve failed (non-fatal):', e.message);
    }

    // Q3: re-evaluate T-24h against the (possibly corrected) deadline.
    if (effectiveDeadline < today) {
      db.prepare("UPDATE obligation_nudges SET status='missed' WHERE id=?").run(row.nudge_id);
      console.log(`[Proactive] obligation_nudge #${row.nudge_id}: corrected deadline ${effectiveDeadline} already past → missed`);
      cancelled++;
      continue;
    }
    if (effectiveDeadline > tomorrow) {
      // Correction pushed it out — not yet in the window; leave pending.
      rescheduled++;
      continue;
    }

    const childSuffix = row.child_name ? ` (${row.child_name})` : '';
    const when = effectiveDeadline === today ? 'היום' : 'מחר';
    const text = `⏰ תזכורת: ${when} מועד אחרון — ${row.obligation_text || 'משימה'}${childSuffix}`;
    const result = await guardedSend.guardedSendProactive({ text, noticeId: row.notice_id, promptType: 'obligation_nudge' });
    if (result.sent) {
      db.prepare("UPDATE obligation_nudges SET status='sent', sent_at=? WHERE id=?").run(Date.now(), row.nudge_id);
      sent++;
    }
  }

  if (rows.length || overdue.changes) {
    console.log(`[Proactive] obligation_nudge: window=${today}..${tomorrow} checked=${rows.length} sent=${sent} rescheduled=${rescheduled} cancelled=${cancelled} missed=${overdue.changes}`);
  }
  return { checked: rows.length, sent, rescheduled, cancelled, missed: overdue.changes };
}

module.exports = {
  detectObligationDeadline,
  computeObligationKey,
  recordMissingTimePrompt,
  recordObligationNudge,
  checkMissingTimePrompts,
  resolveMissingTime,
  tryResolveMissingTime,
  checkObligationNudges,
  // exported for tests
  formatHebrewDate,
  summarize,
};
