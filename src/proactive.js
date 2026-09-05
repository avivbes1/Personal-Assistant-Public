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

const config = require('./config');
const { getDB } = require('./db');
const { guardedSendProactive } = require('./delivery/guardedSend');
const { israelDateIso, addDaysIso } = require('./timeUtils');
const { extractExplicitDate, extractHebrewWeekday, nextOccurrence } = require('./date-parse');

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
 * Detect an explicit deadline in notice content and extract its date + a short
 * obligation description. Returns { deadlineDate:'YYYY-MM-DD', obligationText }
 * or null when there's no deadline-like phrasing with a parseable date.
 *
 * The date is parsed from the text AFTER the trigger phrase (so "החזרת ספרים עד
 * 7.9" reads the 7.9, not some earlier date), preferring an explicit digit date
 * and falling back to a Hebrew weekday name's next occurrence.
 */
function detectObligationDeadline(content) {
  const text = String(content || '');
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

  // Parse a date from the trigger onward; fall back to whole text if needed.
  const tail = text.slice(triggerIdx);
  let deadlineDate = null;
  const explicit = extractExplicitDate(tail) || extractExplicitDate(text);
  if (explicit) {
    deadlineDate = explicit.iso;
  } else {
    const wd = extractHebrewWeekday(tail);
    if (wd != null) deadlineDate = nextOccurrence(wd).iso;
  }
  if (!deadlineDate) return null;

  return { deadlineDate, obligationText: summarize(text, 80) };
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
 * G3: record a T-24h obligation nudge. UNIQUE(notice_id, deadline_date) +
 * INSERT OR IGNORE make this idempotent — at most one row per (notice, deadline).
 */
function recordObligationNudge(noticeId, { deadlineDate, obligationText, childName } = {}) {
  if (!noticeId || !deadlineDate) return null;
  const db = getDB();
  const r = db.prepare(
    `INSERT OR IGNORE INTO obligation_nudges (notice_id, deadline_date, child_name, obligation_text, status)
     VALUES (?, ?, ?, ?, 'pending')`
  ).run(noticeId, deadlineDate, childName || null, obligationText || null);
  if (r.changes > 0) {
    console.log(`[Proactive] Recorded obligation nudge for notice #${noticeId} due ${deadlineDate}`);
    return r.lastInsertRowid;
  }
  return null;
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

    const result = await guardedSendProactive({ text, noticeId: row.notice_id, promptType: 'missing_time' });
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
      const r = await updateCalendarEvent(config.AVIV_CALENDAR_ID, config.AVIV_TOKEN_PATH, notice.calendar_event_id, patch);
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
 * Send obligation nudges whose deadline is tomorrow (Israel time) and still
 * pending. One nudge per notice ever — the UNIQUE constraint prevents duplicate
 * rows and the pending→sent transition prevents re-sends. Returns { checked, sent }.
 */
async function checkObligationNudges() {
  const db = getDB();
  const tomorrow = addDaysIso(israelDateIso(), 1);
  const rows = db.prepare(
    `SELECT o.id AS nudge_id, o.notice_id, o.obligation_text, o.child_name, n.dismissed
       FROM obligation_nudges o
       JOIN notices n ON n.id = o.notice_id
      WHERE o.deadline_date = ? AND o.status = 'pending'
      ORDER BY o.created_at ASC`
  ).all(tomorrow);

  let sent = 0;
  for (const row of rows) {
    if (row.dismissed) {
      db.prepare("UPDATE obligation_nudges SET status='skipped' WHERE id=?").run(row.nudge_id);
      continue;
    }
    const childSuffix = row.child_name ? ` (${row.child_name})` : '';
    const text = `⏰ תזכורת: מחר מועד אחרון — ${row.obligation_text || 'משימה'}${childSuffix}`;
    const result = await guardedSendProactive({ text, noticeId: row.notice_id, promptType: 'obligation_nudge' });
    if (result.sent) {
      db.prepare("UPDATE obligation_nudges SET status='sent', sent_at=? WHERE id=?").run(Date.now(), row.nudge_id);
      sent++;
    }
  }

  if (rows.length) console.log(`[Proactive] obligation_nudge: due=${tomorrow} checked=${rows.length} sent=${sent}`);
  return { checked: rows.length, sent };
}

module.exports = {
  detectObligationDeadline,
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
