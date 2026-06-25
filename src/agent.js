/**
 * agent.js - Unified Claude agent for FamilyBot.
 * Replaces the two-stage parser+handler pipeline with a single Claude call.
 * Claude responds naturally and emits JSON action blocks as side-effects.
 */

'use strict';

const https = require('https');
const config = require('./config');
const { buildContext, buildQuerySpecificContext } = require('./query');
const { getFamilyContext } = require('./family-profiles');
const { render: renderPrompt } = require('./llm/prompts');
const { searchCalendarEvents, updateCalendarEvent, deleteCalendarEvent, listEventsForDate } = require('./calendar');
const { processEventAction } = require('./calendarGate');
const { saveActionItem, saveMessage, getDB, saveBotTask, saveNotice, saveHomework, getPendingHomework, saveOrGetThread, dismissThread, linkNoticeToThread, getMostRecentDeliveredThread, markMessageProcessing, markMessageTerminal, markMessageFailed, getConfigValue } = require('./db');
const { scheduleRemindersForEvent, scheduleFollowUpForEvent } = require('./scheduler');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ISSUE-013: validate that a stated day name matches the actual date
const HE_DAY_INDEX = { 'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3, 'חמישי': 4, 'שישי': 5, 'שבת': 6 };
function validateEventDate(event) {
  if (!event || !event.date) return event;
  if (!event.dayName || HE_DAY_INDEX[event.dayName] === undefined) return event;
  const dateObj = new Date(event.date + 'T12:00:00+03:00');
  const actualIdx = dateObj.getDay(); // JS: 0=Sun
  const expectedIdx = HE_DAY_INDEX[event.dayName];
  if (actualIdx !== expectedIdx) {
    console.warn(`[Agent] Date mismatch: ${event.dayName} (expected idx ${expectedIdx}) but ${event.date} is idx ${actualIdx}. Auto-correcting.`);
    let diff = expectedIdx - actualIdx;
    if (diff > 3) diff -= 7;
    if (diff < -3) diff += 7;
    const corrected = new Date(dateObj);
    corrected.setDate(corrected.getDate() + diff);
    event.date = corrected.toISOString().substring(0, 10);
    console.warn(`[Agent] Corrected date: ${event.date}`);
  }
  return event;
}

// ISSUE-014: alert Aviv when Anthropic credits exhausted (max once/hour)
let _creditAlertSentAt = 0;
function alertCreditExhausted(errMsg) {
  const now = Date.now();
  if (now - _creditAlertSentAt < 3600000) return;
  _creditAlertSentAt = now;
  try {
    const http = require('http');
    const payload = JSON.stringify({
      to: config.AVIV_PHONE,
      text: `⚠️ Anthropic API credit error - bot is in degraded mode.\n${errMsg}`
    });
    const req = http.request({ hostname: 'localhost', port: 3001, path: '/send-message', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, () => {});
    req.on('error', () => {});
    req.write(payload);
    req.end();
    console.error('[Agent] Sent credit exhaustion alert DM to Aviv');
  } catch (e) {
    console.error('[Agent] Failed to send credit alert:', e.message);
  }
}

const FAMILY_PHONES = {
  aviv:  config.AVIV_PHONE,
  liat:  config.LIAT_PHONE,
  אביב: config.AVIV_PHONE,
  ליאת: config.LIAT_PHONE,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Look up the master group ID from DB (group with related_to='master'). */
function getMasterGroupId() {
  try {
    const row = getDB().prepare("SELECT id FROM groups WHERE related_to='master' LIMIT 1").get();
    return row ? row.id : 'agent_tasks';
  } catch (_) {
    return 'agent_tasks';
  }
}

/**
 * Extract JSON action blocks from text.
 * Handles nested objects correctly by tracking brace depth.
 * Returns array of { json, start, end }.
 */
function extractActionBlocks(text) {
  const blocks = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start === -1) break;

    let depth = 0;
    let end = -1;
    let inString = false;
    let escaped = false;

    for (let j = start; j < text.length; j++) {
      const ch = text[j];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }

    if (end === -1) break;

    const candidate = text.slice(start, end + 1);
    try {
      const obj = JSON.parse(candidate);
      if (obj.action) blocks.push({ json: obj, start, end });
    } catch (_) {}

    i = end + 1;
  }
  return blocks;
}

/**
 * Remove action blocks from text (reverse order to preserve indices).
 */
function stripActionBlocks(text, blocks) {
  if (blocks.length === 0) return text;
  let result = text;
  for (const block of [...blocks].reverse()) {
    result = result.slice(0, block.start) + result.slice(block.end + 1);
  }
  // Strip any leftover markdown code fences (e.g. ```json\n\n```) after JSON extraction
  result = result.replace(/```(?:json)?\s*```/g, '');
  result = result.replace(/```(?:json)?\n[\s\S]*?```/g, '');
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

// ── Action executor ───────────────────────────────────────────────────────────

/**
 * Execute a parsed action block.
 * Returns a result object, or { isSideEffect: true } for actions that need
 * the WhatsApp client (handled by whatsapp.js).
 */
/**
 * Deterministic urgency classifier - replaces LLM urgency_hint.
 * Rules:
 *   immediate    = cancellation/emergency keywords, OR event within 3h
 *   time_sensitive = event today or tomorrow
 *   routine      = everything else
 */
function computeUrgencyHint(action, nowMs) {
  const content = action.content || '';
  const ISRAEL_TZ = 'Asia/Jerusalem';

  // 1. Keyword override - always immediate regardless of date
  const URGENT_KEYWORDS = /סגור|ביטול|נדחה|בוטל|איסוף מוקדם|חירום|דחוף|חד פעמי|בית ספר סגור|פינוי|אזעקה|נעילה|מצב חירום/i;
  if (URGENT_KEYWORDS.test(content)) return 'immediate';

  // 2. Datetime-based rules
  const relevantMs = action.relevant_datetime && action.relevant_datetime !== 'null'
    ? Date.parse(action.relevant_datetime) : null;

  if (relevantMs && !isNaN(relevantMs)) {
    const diffMs = relevantMs - nowMs;
    // Within 3h (or just passed by up to 1h) → immediate
    if (diffMs <= 3 * 3600000 && diffMs > -3600000) return 'immediate';
    // Within 24h and upcoming → time_sensitive
    if (diffMs <= 24 * 3600000 && diffMs > 0) return 'time_sensitive';
  }

  // 3. Date-only rules (no time specified)
  if (action.relevance_date) {
    const todayIso = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: ISRAEL_TZ });
    const tomorrowIso = new Date(nowMs + 86400000).toLocaleDateString('en-CA', { timeZone: ISRAEL_TZ });
    if (action.relevance_date === todayIso) return 'time_sensitive';
    if (action.relevance_date === tomorrowIso) return 'time_sensitive';
  }

  // 4. Backlog messages that didn't qualify above - force routine (event already passed or too far)
  if (action._isBacklog) {
    const urgencyHint = 'routine'; // explicit for test visibility
    return urgencyHint;
  }

  return 'routine';
}

async function executeAction(action, senderName) {
  try {
    switch (action.action) {

      case 'add_event': {
        // Route through calendarGate - 4-stage flow:
        // extract → fetch calendar state → semantic dedup decision → execute/ask
        try {
          const { sendToMasterGroup } = require('./whatsapp');
          const result = await processEventAction(action, {
            rawMessage: action._rawMessage || null,
            groupName:  action._groupName  || null,
            sendToMasterGroup,
          });

          const ok = ['created', 'updated'].includes(result.action);
          const gcalEvent = result.event || null;

          // Schedule reminders/follow-up only for new creates
          if (result.action === 'created' && gcalEvent) {
            scheduleRemindersForEvent(gcalEvent, action.owner || 'both');
            scheduleFollowUpForEvent(gcalEvent, action.owner || 'both');
          }

          return { type: 'add_event', ok, action: result.action, title: action.summary || action.title };
        } catch (err) {
          console.error('[Agent] processEventAction error:', err.message);
          return { type: 'add_event', ok: false, error: err.message };
        }
      }

      case 'add_notice': {
        const noticeContent = action.content || action.summary || '';
        if (noticeContent) {
          // Pre-save dedup: skip if a notice for this group+date+time already
          // exists and was delivered or is pending (within 24h window).
          // Prevents conflicting same-event duplicates with wrong dates.
          const existingForSlot = (() => {
            try {
              const since = Date.now() - 24 * 3600000;
              const rows = getDB().prepare(
                `SELECT id, relevance_date, relevance_time FROM notices
                 WHERE group_name = ?
                   AND delivery_status IN ('pending', 'delivered_immediate', 'delivered_batch')
                   AND dismissed = 0
                   AND created_at > ?
                 ORDER BY created_at DESC LIMIT 10`
              ).all(action.group_name || 'unknown', since);
              if (action.relevance_date && action.relevance_time) {
                const targetMs = new Date(action.relevance_date + 'T00:00:00').getTime();
                return rows.find(r => {
                  if (r.relevance_time !== action.relevance_time) return false;
                  if (!r.relevance_date) return false;
                  const rMs = new Date(r.relevance_date + 'T00:00:00').getTime();
                  return Math.abs(rMs - targetMs) <= 86400000;
                });
              }
              return null;
            } catch (_) { return null; }
          })();
          if (existingForSlot) {
            console.log('[Agent] Dedup: skipping notice for ' + action.group_name + ' ' + action.relevance_date + ' ' + action.relevance_time + ' - existing #' + existingForSlot.id + ' (date=' + existingForSlot.relevance_date + ') already covers this slot');
            return { type: 'add_notice', ok: true, content: noticeContent, isSideEffect: true, deduped: true };
          }
          // Rules-based urgency classifier - deterministic, no LLM guessing
          const urgencyHint = computeUrgencyHint(action, Date.now());
          // Parse relevant_datetime to epoch ms
          let relevantDatetime = null;
          if (action.relevant_datetime && action.relevant_datetime !== 'null') {
            const parsed = Date.parse(action.relevant_datetime);
            if (!isNaN(parsed)) relevantDatetime = parsed;
          } else if (action.relevance_date && action.relevance_time) {
            const parsed = Date.parse(`${action.relevance_date}T${action.relevance_time}:00`);
            if (!isNaN(parsed)) relevantDatetime = parsed;
          } else if (action.relevance_date) {
            const parsed = Date.parse(`${action.relevance_date}T00:00:00`);
            if (!isNaN(parsed)) relevantDatetime = parsed;
          }
          const noticeId = saveNotice({
            group_name:        action.group_name || 'unknown',
            content:           noticeContent,
            relevance_date:    action.relevance_date || null,
            relevance_time:    action.relevance_time || null,
            source_timestamp:  action.source_timestamp || Date.now(),
            urgency_hint:      urgencyHint,
            relevant_datetime: relevantDatetime,
            message_timestamp: action.source_timestamp || Date.now(),
            delivery_status:   'pending',
          });
          // Link to thread for topic continuity
          if (action.thread_key && noticeId) {
            try {
              const thread = saveOrGetThread(action.thread_key, noticeContent.substring(0, 80), action.group_name || 'unknown');
              if (thread) linkNoticeToThread(noticeId, action.thread_key, thread.id);
            } catch (e) {
              console.warn('[Agent] thread link error:', e.message);
            }
          }
          console.log(`[Agent] Saved notice: "${noticeContent.substring(0, 60)}" thread=${action.thread_key || 'none'} rel=${action.relevance_date || 'undated'}`);
        }
        return { type: 'add_notice', ok: true, content: noticeContent, isSideEffect: true };
      }

      case 'add_homework': {
        const child = action.child || action.child_name || '';
        const desc  = (action.description || '').trim();
        if (!child || !desc) {
          console.warn('[Agent] add_homework: missing child or description', action);
          return null;
        }
        const hwId = saveHomework({
          child_name:   child,
          subject:      action.subject   || null,
          description:  desc,
          due_date:     action.due_date  || null,
          source_group: action._groupName || null,
          message_id:   null,
        });
        console.log(`[Agent] Saved homework id=${hwId}: ${child} / ${action.subject || '?'} due ${action.due_date || 'undated'}`);
        return { type: 'add_homework', ok: true, homework_id: hwId, isSideEffect: true };
      }

      case 'mark_homework_done': {
        const db = getDB();
        const child   = action.child || action.child_name || '';
        const subject = action.subject || null;
        const dueDate = action.due_date || null;
        const hwId    = action.homework_id || null;
        const { sendToMasterGroup } = require('./whatsapp');

        let changed = 0;
        if (hwId) {
          changed = db.prepare('UPDATE homework SET done=1, updated_at=? WHERE id=? AND done=0').run(Date.now(), hwId).changes;
        } else if (child && subject && dueDate) {
          changed = db.prepare('UPDATE homework SET done=1, updated_at=? WHERE done=0 AND child_name=? AND subject=? AND due_date=?').run(Date.now(), child, subject, dueDate).changes;
        } else if (child && subject) {
          changed = db.prepare('UPDATE homework SET done=1, updated_at=? WHERE id=(SELECT id FROM homework WHERE done=0 AND child_name=? AND subject=? ORDER BY due_date ASC LIMIT 1)').run(Date.now(), child, subject).changes;
        } else {
          // Not enough context - list open homework and ask
          const open = db.prepare("SELECT id, subject, due_date FROM homework WHERE done=0 AND child_name=? AND (due_date IS NULL OR due_date >= date('now','-1 day')) ORDER BY due_date ASC LIMIT 5").all(child || '');
          if (open.length > 0) {
            const list = open.map(h => `• ${h.subject || 'ללא נושא'}${h.due_date ? ' (ל' + h.due_date + ')' : ''} [id:${h.id}]`).join('\n');
            try { await sendToMasterGroup(`‏מה סיימו? השיעורים הפתוחים של ${child || 'הילד'}:\n${list}`); } catch (_) {}
          }
          return { type: 'mark_homework_done', ok: false, reason: 'ambiguous' };
        }

        if (changed > 0) {
          const label = subject ? `${subject}${dueDate ? ' ל-' + dueDate : ''}` : 'שיעורי הבית';
          try { await sendToMasterGroup(`‏✅ סימנתי ש${child || 'הילד'} סיימו ${label}.`); } catch (_) {}
          console.log(`[Agent] mark_homework_done: ${changed} row(s) done (child=${child}, subject=${subject})`);
        } else {
          try { await sendToMasterGroup('‏לא מצאתי שיעורי בית פתוחים תואמים.'); } catch (_) {}
        }
        return { type: 'mark_homework_done', ok: changed > 0, rows_updated: changed };
      }

      case 'book_babysitter': {
        // Book a babysitter via the microservice
        const http = require('http');
        const { date, start, end, day } = action;
        if (!date || !start || !end) {
          return { type: 'book_babysitter', ok: false, error: 'Missing date/start/end' };
        }
        const dayName = day || new Date(date).toLocaleDateString('he-IL', { weekday: 'long', timeZone: 'Asia/Jerusalem' });
        const payload = JSON.stringify({
          requested_by: action._senderPhone || process.env.AVIV_PHONE || '',
          day: dayName, date, start, end,
        });
        try {
          await new Promise((resolve, reject) => {
            const req = http.request({
              hostname: 'localhost', port: 3002, path: '/bookings', method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'x-shared-token': process.env.SHARED_SECRET || '',
              },
            }, (res) => {
              let d = ''; res.on('data', c => d += c);
              res.on('end', () => {
                try {
                  const r = JSON.parse(d);
                  if (r.ok) resolve(r);
                  else reject(new Error(r.error || 'Booking failed'));
                } catch (e) { reject(e); }
              });
            });
            req.setTimeout(10000, () => { req.destroy(); reject(new Error('Booking service timeout')); });
            req.on('error', reject);
            req.write(payload); req.end();
          });
          console.log(`[Agent] Babysitter booking created for ${date} ${start}-${end}`);
          return { type: 'book_babysitter', ok: true };
        } catch (err) {
          console.error('[Agent] book_babysitter error:', err.message);
          return { type: 'book_babysitter', ok: false, error: err.message };
        }
      }

      case 'add_task': {
        const text = action.text || action.description || '';
        const masterGroupId = getMasterGroupId();
        const msgId = saveMessage({
          group_id:  masterGroupId,
          sender:    senderName || 'agent',
          body:      text,
          timestamp: Date.now(),
        });
        saveActionItem({ message_id: msgId, description: text, due_date: action.due_date || null });
        console.log(`[Agent] Saved task: "${text.substring(0, 60)}"`);
        return { type: 'add_task', ok: true, text };
      }

      case 'mark_done': {
        const taskId = action.task_id;
        if (taskId) {
          getDB().prepare('UPDATE action_items SET done=1 WHERE id=?').run(taskId);
          console.log(`[Agent] Marked task done: id=${taskId}`);
          return { type: 'mark_done', ok: true, task_id: taskId };
        }
        return null;
      }

      case 'update_event': {
        if (!action.search_title) return null;
        const results = await searchCalendarEvents(action.search_title);
        if (results.length === 0) return { type: 'update_event', ok: false, reason: 'not_found' };

        const changes = action.changes || {};
        const patch = {};
        if (changes.title)       patch.summary  = changes.title;
        if (changes.description) patch.description = changes.description;
        if (changes.location)    patch.location  = changes.location;
        if (changes.start_time) {
          const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(changes.start_time);
          patch.start = isDateOnly
            ? { date: changes.start_time }
            : { dateTime: changes.start_time, timeZone: config.TIMEZONE };
        }
        if (changes.end_time) {
          const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(changes.end_time);
          patch.end = isDateOnly
            ? { date: changes.end_time }
            : { dateTime: changes.end_time, timeZone: config.TIMEZONE };
        }

        const updated = [];
        for (const r of results.slice(0, 3)) {
          const res = await updateCalendarEvent(r.calendarId, r.tokenPath, r.event.id, patch);
          if (res) updated.push(res.summary || r.event.summary);
        }
        console.log(`[Agent] Updated events: ${updated.join(', ')}`);
        return { type: 'update_event', ok: updated.length > 0, updated };
      }

      case 'delete_event': {
        if (!action.search_title) return null;
        const results = await searchCalendarEvents(action.search_title);
        if (results.length === 0) return { type: 'delete_event', ok: false, reason: 'not_found' };

        const deleted = [];
        for (const r of results.slice(0, 3)) {
          const ok = await deleteCalendarEvent(r.calendarId, r.tokenPath, r.event.id);
          if (ok) deleted.push(r.event.summary);
        }
        console.log(`[Agent] Deleted events: ${deleted.join(', ')}`);
        return { type: 'delete_event', ok: deleted.length > 0, deleted };
      }

      case 'check_in': {
        // Personal check-in: ask the user at a specific time if they did something.
        // No calendar event - stored in bot_tasks.
        const message  = action.message || action.text || '';
        const runAtRaw = action.run_at;
        if (!message || !runAtRaw) return null;

        const runAt = new Date(runAtRaw).getTime();
        if (isNaN(runAt)) {
          console.warn('[Agent] check_in: invalid run_at:', runAtRaw);
          return null;
        }

        const taskId = saveBotTask({
          description:      action.description || message,
          check_in_message: message,
          run_at:           runAt,
          recurring:        action.recurring ? 1 : 0,
          interval_ms:      action.interval_ms || 0,
          stop_on_confirm:  action.stop_on_confirm ? 1 : 0,
          group_key:        action.group_key || null,
        });
        const runAtStr = new Date(runAt).toLocaleString('he-IL', { timeZone: config.TIMEZONE });
        console.log(`[Agent] Check-in saved (id=${taskId}): "${message.substring(0, 60)}" at ${runAtStr}`);
        return { type: 'check_in', ok: true, task_id: taskId, run_at: runAtStr };
      }

      case 'schedule_whatsapp': {
        // Schedule a WhatsApp message to a family member at a future time.
        const toKey   = (action.to || '').toLowerCase();
        const phone   = FAMILY_PHONES[toKey];
        const msgText = action.text || '';
        const runAtRaw = action.run_at;
        if (!phone)   return { type: 'schedule_whatsapp', ok: false, error: `Unknown recipient: ${action.to}` };
        if (!msgText) return { type: 'schedule_whatsapp', ok: false, error: 'Missing text' };
        if (!runAtRaw) return { type: 'schedule_whatsapp', ok: false, error: 'Missing run_at' };

        const runAt = new Date(runAtRaw).getTime();
        if (isNaN(runAt)) return { type: 'schedule_whatsapp', ok: false, error: `Invalid run_at: ${runAtRaw}` };
        if (runAt <= Date.now()) return { type: 'schedule_whatsapp', ok: false, error: 'run_at must be in the future' };

        const taskId = saveBotTask({
          description:      `WhatsApp to ${action.to}: ${msgText.substring(0, 60)}`,
          check_in_message: msgText,
          run_at:           runAt,
          recurring:        0,
          interval_ms:      0,
          stop_on_confirm:  0,
          group_key:        null,
          target_phone:     phone,
          task_type:        'scheduled_whatsapp',
        });
        const runAtStr = new Date(runAt).toLocaleString('he-IL', { timeZone: config.TIMEZONE });
        console.log(`[Agent] Scheduled WhatsApp to ${action.to} (${phone}) at ${runAtStr}: "${msgText.substring(0, 60)}"`);
        return { type: 'schedule_whatsapp', ok: true, task_id: taskId, run_at: runAtStr, to: action.to };
      }

      case 'send_whatsapp': {
        // Needs the WA client - return as side effect for whatsapp.js to handle
        const key   = (action.to || '').toLowerCase();
        const phone = FAMILY_PHONES[key];
        return { type: 'send_whatsapp', isSideEffect: true, phone, to: action.to, text: action.text };
      }

      default:
        console.warn(`[Agent] Unknown action type: "${action.action}"`);
        return null;
    }
  } catch (err) {
    console.error(`[Agent] executeAction(${action.action}) error:`, err.message);
    return { type: action.action, ok: false, error: err.message };
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(context) {
  return `${renderPrompt("agent-system", { BOT_NAME: config.BOT_NAME, BOT_NAME_ALT: config.BOT_NAME_ALT, FAMILY_CONTEXT: getFamilyContext() })}

## אופי ואיך לתקשר:
- **קצר וישיר** - 1-3 משפטים. אין מילות מילוי ("בהחלט!", "שאלה מצוינת!", "בשמחה אעזור").
- **יש לך דעה** - אתה מותר לא להסכים, להציע, לשאול כשלא ברור.
- **אל תנחש** - אם לא ברור מה רוצים, שאל שאלה קצרה אחת.
- **אל תחזור על עצמך** - אם שאלת כבר, אל תשאל שוב באותה שיחה.
- **עקוב אחרי ההקשר** - אם ההודעה הקודמת שלך הייתה שאלה, ותגובת המשתמש היא "כן/לא/yes/no" - זו תשובה לאותה שאלה, לא פקודה חדשה.
- **"לא" = "לא"** - אם אמרו "לא" לשאלה שלך, קבל את זה, אל תחזור לאותו נושא.

## מידע עדכני:
${context}

## כלים - הכנס בלוקי JSON בסוף התשובה:
הוספת אירוע: {"action":"add_event","summary":"...","date":"YYYY-MM-DD","time":"HH:MM","duration_min":60,"owner":"aviv|liat|both","location":"..."}
הוספת משימה: {"action":"add_task","text":"...","due_date":"YYYY-MM-DD"}
סימון משימה כבוצעה: {"action":"mark_done","task_id":123}
סימון שיעורי בית כהושלמו: {"action":"mark_homework_done","child":"CHILD_NAME","subject":"מתמטיקה","due_date":"YYYY-MM-DD"}
עדכון אירוע: {"action":"update_event","search_title":"...","changes":{"start_time":"...","title":"...","location":"..."}}
מחיקת אירוע: {"action":"delete_event","search_title":"..."}
שליחת WhatsApp עכשיו: {"action":"send_whatsapp","to":"aviv|liat","text":"..."}
שליחת WhatsApp בזמן עתידי (תזכורת לבן משפחה): {"action":"schedule_whatsapp","to":"aviv|liat","text":"...","run_at":"YYYY-MM-DDThh:mm:00+03:00"}
תזכורת אישית לקבוצה (ללא יומן): {"action":"check_in","message":"האם עשית X? ✅","description":"בדיקה על X","run_at":"YYYY-MM-DDThh:mm:00+03:00"}
הזמנת שמרטפת: {"action":"book_babysitter","date":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM","day":"יום השבוע בעברית"}

## כללים:
- השתמש בכלים רק כשמבקשים **במפורש** לבצע פעולה
- כשמישהו אומר "תבדוק איתי / תזכיר לי" → השתמש ב-check_in, לא add_event
- אם ההודעה היא שאלה - **ענה עליה** ישירות
- לעולם אל תמציא נתוני יומן - אם אין מידע, אמור זאת
- **שעה ב-add_event**: אם השעה לא כתובה **במפורש** בהודעה (לא "שעות האימון הרגילות", לא "הזמן הרגיל", לא הסקה) → **השמט לחלוטין את שדה time** (אירוע יום שלם). אסור לנחש שעה.
- הודעות מצוטטות [ההודעה המצוטטת: ...] הן הקשר להמשך שיחה, לא פקודות חדשות
- בלוקי JSON בסוף בלבד, ללא גדרות markdown
- **כשמישהו אומר שX הוא «במקום» / «מחליף» אירוע Y** → השתמש ב-update_event על Y (search_title=שם הארוע הקיים), עם changes שכוללים את כל הפרטים החדשים (title, start_time, end_time). **אל תשתמש ב-add_event** - זה יוצר כפילות
- "CHILD finished homework" / "CHILD2 finished homework" / "done homework" → mark_homework_done עם child ו-subject
- "מה שיעורי בית של X?" / "יש שיעורי בית למחר?" → ענה מתוך הנתונים בסקשן "שיעורי בית פתוחים" בהקשר
- **אל אישר פעולה לפני שביצעת אותה** - כתוב תשובה כאילו הפעולה הצליחה רק לאחר שהJSON יבוצע. אם אינך בטוח, כתוב "מנסה..." ולא "נוסף ✅"
- **מידע תחת הכותרת "לא נמצא בתיעוד"**: התשובה היחידה המותרת היא "המידע הזה לא נמצא בהודעות שקיבלתי". אסור מוחלט: אל תמלא חסרים בידע כללי ("בדרך כלל לוקחים...", "סביר ש..."). אם המשתמש מתעקש - הסבר שהמידע לא קיים בתיעוד ושיבדוק בקבוצה ישירות.

## ברירת מחדל לבעלות ביומן:
- אם לא צוין במפורש → תמיד owner="both"
- **אל תשאל "ליומן של מי?" כשאלה נפרדת** - זה שובר את השיחה
- אם המשתמש אמר "ליאת" / "אביב" בתגובה לשאלה שלך - זו הבעלות, תוסיף מיד
- אם המשתמש אמר "כן" סתם - הוסף לשניהם`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

/**
 * Handle a message from the master group or direct message.
 * Replaces the extractFromText → if/else handler chain.
 *
 * @param {string} text               - Message text (may include [ההודעה המצוטטת: ...] suffix)
 * @param {string} quotedMsg          - Quoted bot message body (if reply-to-bot), or ''
 * @param {string} senderName         - Display name of sender
 * @param {Array}  conversationHistory - Recent [{role, content}] pairs
 * @returns {Promise<{text: string, sideEffects: Array}>}
 */
async function handleMessage(text, quotedMsg, senderName, conversationHistory = []) {
  if (!ANTHROPIC_API_KEY) {
    console.error('[Agent] No ANTHROPIC_API_KEY');
    return { text: 'שגיאת הגדרות - אין מפתח API.', sideEffects: [] };
  }

  let context;
  try {
    context = await buildContext();
  } catch (err) {
    console.error('[Agent] buildContext error:', err.message);
    context = '(שגיאה בטעינת הנתונים)';
  }

  // ISSUE-010: Append query-specific context with explicit "not found" markers
  // This prevents the LLM from fabricating details when data is missing from DB
  try {
    const queryCtx = buildQuerySpecificContext(text);
    if (queryCtx) context += queryCtx;
  } catch (err) {
    console.warn('[Agent] buildQuerySpecificContext error:', err.message);
  }

  const systemPrompt = buildSystemPrompt(context);

  // Build messages array with recent history
  const messages = [];
  for (const h of conversationHistory.slice(-6)) {
    const role = (h.role === 'assistant' || h.role === 'bot') ? 'assistant' : 'user';
    messages.push({ role, content: String(h.content || '') });
  }
  messages.push({ role: 'user', content: String(text || '') });

  const bodyStr = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 768,
    system: systemPrompt,
    messages,
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', async () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            console.error('[Agent] API error:', parsed.error.message);
            return resolve({ text: 'מצטער, הייתה שגיאה. נסו שוב.', sideEffects: [] });
          }

          const rawText = parsed.content?.[0]?.text?.trim() || 'מצטער, לא הצלחתי לענות.';
          console.log(`[Agent] Raw response (${rawText.length} chars): ${rawText.substring(0, 100)}`);

          // Extract action blocks, execute them, strip from text
          const blocks = extractActionBlocks(rawText);
          const sideEffects = [];

          const failedActions = [];
          for (const block of blocks) {
            if (block.json.action === 'book_babysitter') {
              // Inject sender phone so microservice knows who requested
              block.json._senderPhone = senderPhone || process.env.AVIV_PHONE || '';
            }
            const result = await executeAction(block.json, senderName);
            if (result) {
              if (result.isSideEffect) sideEffects.push(result);
              // Step 5: track failures for confirmation override
              if (result.ok === false) failedActions.push(block.json.action);
              console.log(`[Agent] Action result (${block.json.action}):`, JSON.stringify(result));
            }
          }

          let cleanText = stripActionBlocks(rawText, blocks) || 'בוצע.';
          // Step 5: If any action failed, override optimistic LLM confirmation
          if (failedActions.length > 0) {
            console.warn('[Agent] Action(s) failed:', failedActions.join(', '), '- overriding confirmation text');
            cleanText = 'מצטער, הייתה בעיה בביצוע הפעולה (' + failedActions.join(', ') + '). אנסה שוב.';
          }
          // Fix B: For schedule_whatsapp, override LLM text with factual result (confirm-after-results)
          // The LLM writes optimistic text before knowing if the schedule succeeded.
          // We replace it with text derived from the actual action result.
          const scheduleResult = blocks
            .map((b, i) => ({ block: b, result: (result => result)(executeAction.name) }))
            .find(x => x.block.json.action === 'schedule_whatsapp');
          // Find the actual result by re-checking the results array we built
          const actionResults = blocks.map(b => b.json.action);
          const swIdx = actionResults.indexOf('schedule_whatsapp');
          if (swIdx !== -1 && failedActions.length === 0) {
            // Get the result from sideEffects or find it in what was executed
            const swBlock = blocks[swIdx].json;
            const toName = swBlock.to === 'liat' || swBlock.to === 'ליאת' ? 'ליאת' :
                           swBlock.to === 'aviv' || swBlock.to === 'אביב' ? 'לאביב' : swBlock.to;
            const runAtFormatted = swBlock.run_at
              ? new Date(swBlock.run_at).toLocaleString('he-IL', { timeZone: config.TIMEZONE, hour: '2-digit', minute: '2-digit', weekday: 'short', day: 'numeric', month: 'numeric' })
              : swBlock.run_at;
            cleanText = `‏✅ תזכורת נקבעה ${toName} ל-${runAtFormatted}`;
            console.log('[Agent] schedule_whatsapp confirmed with factual text:', cleanText);
          }
          resolve({ text: cleanText, sideEffects });
        } catch (e) {
          console.error('[Agent] Response parse error:', e.message);
          resolve({ text: 'מצטער, הייתה שגיאה בעיבוד התשובה.', sideEffects: [] });
        }
      });
    });

    req.on('error', (err) => {
      console.error('[Agent] Request error:', err.message);
      resolve({ text: 'מצטער, הייתה שגיאה בחיבור.', sideEffects: [] });
    });

    req.write(bodyStr);
    req.end();
  });
}

// ── Monitored group handler ───────────────────────────────────────────────────

/**
 * Handle a message from a monitored (non-master) WhatsApp group.
 * Proactively extracts events/tasks and adds them without waiting for
 * an explicit user request.
 *
 * @param {string} body             - Message text (may include media description)
 * @param {string} groupName        - Name of the WhatsApp group
 * @param {string} sender           - Display name of sender
 * @param {string|null} groupDescription - Optional group context/description
 * @param {Array} recentMessages    - Recent messages from this group for context [{sender, body, timestamp}]
 * @param {boolean} isImageMsg       - True if this message is an image (body will be '[תמונה]')
 * @returns {Promise<{text: string, sideEffects: Array, acted: boolean, downloadImage: boolean}>}
 */
// Tool definitions for tool-calling extraction (ISSUE-019)
// Using tools instead of free-form JSON eliminates truncation risk entirely.
const GROUP_TOOLS = [
  {
    name: 'add_notice',
    description: 'חובה לקרוא כאשר ההודעה מכילה מידע שרלוונטי למשפחה. תמיד העדף זה על שתיקה.',
    input_schema: {
      type: 'object',
      properties: {
        content:           { type: 'string',  description: 'תיאור תמציתי וברור בעברית. כלול את כל פרטי הפעולה (מועדים, מה להביא, איש קשר). עובדות בלבד.' },
        thread_key:        { type: 'string',  description: 'kebab-case slug ייחודי לנושא, עקבי על פני הודעות דומות. דוגמה: vo-bni-end-year-show' },
        relevance_date:    { type: 'string',  description: 'YYYY-MM-DD - תאריך שבו המידע רלוונטי. מחר=מחר, היום=היום.' },
        relevance_time:    { type: ['string', 'null'], description: 'HH:MM רק אם שעה מפורשת בטקסט. אחרת null.' },
        urgency_hint:      { type: 'string',  enum: ['immediate', 'time_sensitive', 'routine'], description: 'routine לרוב. immediate רק אם דחוף ל-24ש.' },
        relevant_datetime: { type: ['string', 'null'], description: 'ISO datetime של מתי האירוע קורה, או null.' }
      },
      required: ['content', 'thread_key', 'relevance_date', 'urgency_hint']
    }
  },
  {
    name: 'no_action',
    description: 'ההודעה לא רלוונטית למשפחה - שיחת חולין, תודות, סירובים של אנשים אחרים, עדכוני בנייה שגרתיים.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'סיבה קצרה' } },
      required: ['reason']
    }
  },
  {
    name: 'add_event',
    description: 'הוסף אירוע ליומן. רק כשהמשפחה חייבת להגיע (לא הזמנה אופציונלית).',
    input_schema: {
      type: 'object',
      properties: {
        summary:      { type: 'string' },
        date:         { type: 'string', description: 'YYYY-MM-DD' },
        time:         { type: 'string', description: 'HH:MM' },
        duration_min: { type: 'integer' },
        owner:        { type: 'string', enum: ['both', 'aviv', 'liat'] },
        location:     { type: 'string' }
      },
      required: ['summary', 'date', 'owner']
    }
  },
  {
    name: 'add_task',
    description: 'הוסף משימה לביצוע.',
    input_schema: {
      type: 'object',
      properties: {
        text:     { type: 'string' },
        due_date: { type: 'string', description: 'YYYY-MM-DD' }
      },
      required: ['text']
    }
  },
  {
    name: 'add_homework',
    description: 'רשום שיעורי בית לאחד הילדים.',
    input_schema: {
      type: 'object',
      properties: {
        child:       { type: 'string', description: 'שם הילד' },
        subject:     { type: 'string' },
        description: { type: 'string' },
        due_date:    { type: 'string', description: 'YYYY-MM-DD' }
      },
      required: ['child', 'subject', 'description']
    }
  },
  {
    name: 'download_image',
    description: 'הורד ונתח את התמונה - רק אם מורה/מנהל שולח תמונה בודדת עם רמז לתוכן רלוונטי.',
    input_schema: { type: 'object', properties: {}, required: [] }
  }
];

async function handleGroupEvent(body, groupName, sender, groupDescription = null, recentMessages = [], msgTimestamp = null, isImageMsg = false, isBacklog = false, primaryChild = null, messageId = null) {
  if (!ANTHROPIC_API_KEY) {
    console.error('[Agent] No ANTHROPIC_API_KEY');
    return { text: '', sideEffects: [], acted: false };
  }

  const ts = msgTimestamp || Date.now();
  const today = new Date(ts).toLocaleDateString('he-IL', {
    timeZone: config.TIMEZONE || 'Asia/Jerusalem',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const todayIso = new Date(ts).toLocaleDateString('en-CA', { timeZone: config.TIMEZONE || 'Asia/Jerusalem' }); // YYYY-MM-DD
  const tomorrowIso = new Date(ts + 86400000).toLocaleDateString('en-CA', { timeZone: config.TIMEZONE || 'Asia/Jerusalem' });

  const groupCtx = groupDescription ? `תיאור הקבוצה: ${groupDescription}` : '';
  const childCtx = primaryChild ? `
הילד הקשור לקבוצה זו: *${primaryChild}*. בכל add_homework השתמש child:"${primaryChild}".` : "";

  // Build recent chat context (last N messages before the current one)
  let recentCtx = '';
  if (recentMessages && recentMessages.length > 0) {
    const lines = recentMessages.map(m => {
      const timeStr = new Date(m.timestamp).toLocaleString('he-IL', {
        timeZone: config.TIMEZONE || 'Asia/Jerusalem',
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      });
      const snippet = (m.body || '').substring(0, 200).replace(/\n/g, ' ');
      return `[${timeStr}] ${m.sender}: ${snippet}`;
    });
    recentCtx = `\n## הודעות אחרונות בקבוצה (הקשר):\n${lines.join('\n')}\n`;
  }

  // ISSUE-019: System prompt is now tool-oriented — no prose, no JSON blocks in text.
  // The model MUST call add_notice or no_action. Other tools are optional.
  const systemPrompt = `אתה ${config.BOT_NAME}, עוזר משפחתי אוטומטי שמנטר קבוצות WhatsApp.

קבוצה: "${groupName}"
שולח: ${sender}
היום: ${today} (${todayIso})
מחר: ${tomorrowIso}
${groupCtx}${childCtx}${recentCtx}
בני המשפחה: ${getFamilyContext()}

## הוראות

עליך לקרוא לאחד מהכלים הבאים — תמיד:
- **add_notice**: אם ההודעה מכילה מידע רלוונטי למשפחה (גם אם אתה גם מוסיף אירוע/משימה)
- **no_action**: אם ההודעה אינה רלוונטית למשפחה כלל

**add_notice בנוסף לכלים אחרים:** כשאתה מוסיף אירוע ליומן, תמיד גם קרא ל-add_notice לתיעוד.

**מתי add_event:** אירוע שהמשפחה חייבת להגיע אליו (לא הזמנה אופציונלית). קרא גם ל-add_notice.

**מתי no_action (בלבד):**
- שיחת חולין, תודות, "ראיתי"
- סירוב/התנצלות של מישהו אחר
- עדכוני בנייה/תשתית שאינם דחופים
- ספק? → no_action

**שינוי לאירוע קיים:** אם ההודעה מתארת שינוי לאירוע קיים ("האימון בוטל", "הטורניר במקום האימון", "שיעור מוזז") — קרא ל-add_notice בלבד, לא ל-add_event. **אל תוסיף אירוע חדש אם ההודעה מדברת על שינוי לאירוע קיים** — העדכון ייעשה על ידי המשתמש.

**שיקולי add_notice:**
- content: כל הפרטים הרלוונטיים בעברית. עובדות בלבד, לא מסקנות שלך.
- relevance_date: "מחר" = ${tomorrowIso}, "היום/הערב" = ${todayIso}. ברירת מחדל: ${todayIso}.
- relevance_time: רק אם שעה מפורשת בטקסט. אחרת null.
- thread_key: kebab-case, עקבי לנושא. דוגמאות: "vo2-end-year-show", "nevo-football-game-jun".
- urgency_hint: routine ברירת מחדל. immediate רק אם הדחיפות היא <24ש'.

${isImageMsg ? `**תמונה:** קרא ל-download_image רק אם המשלח הוא מורה/מנהל ויש סיכוי שהתמונה מכילה מידע אקדמי/לוגיסטי. אחרת no_action.` : ''}

**אין לכתוב טקסט חופשי** — רק tool calls.`;

  // Guard: don't call API with empty body - returns billing error
  if (!body || !body.trim()) {
    if (messageId) markMessageTerminal(messageId, 'NOT_ACTIONABLE', 'empty body');
    return { text: '', sideEffects: [], acted: false, downloadImage: false };
  }

  // P-008: Mark PROCESSING before API call so stuck-message scanner can detect hangs
  if (messageId) markMessageProcessing(messageId);

  // Read max_tokens from config table (allows autonomous tuning)
  let maxTokens = 2048;
  try { const cfg = getConfigValue('haiku_max_tokens'); if (cfg) maxTokens = cfg; } catch (_) {}

  // ISSUE-019: Use tool calling instead of free-form JSON.
  // Tool calls are structured, schema-validated, and cannot be truncated mid-output.
  // The model MUST call at least one tool (tool_choice: "any").
  const reqBody = {
    model: 'claude-haiku-4-5',
    max_tokens: maxTokens,
    system: systemPrompt,
    tools: GROUP_TOOLS,
    tool_choice: { type: 'any' }, // force at least one tool call - eliminates empty/prose responses
    messages: [{ role: 'user', content: body.trim() }],
  };
  const bodyStr = JSON.stringify(reqBody);

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', async () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            console.error('[Agent] handleGroupEvent API error:', parsed.error.message);
            if (parsed.error.message && parsed.error.message.includes('credit balance')) {
              alertCreditExhausted(parsed.error.message);
            }
            if (messageId) markMessageFailed(messageId, JSON.stringify({ code: 'API_ERROR', detail: parsed.error.message }));
            return resolve({ text: '', sideEffects: [], acted: false, downloadImage: false });
          }

          // Extract all tool_use blocks from the response
          const toolUseBlocks = (parsed.content || []).filter(c => c.type === 'tool_use');
          console.log(`[Agent] Group "${groupName}" tools called: ${toolUseBlocks.map(t => t.name).join(', ') || '(none)'} stop=${parsed.stop_reason}`);

          if (toolUseBlocks.length === 0) {
            // Model returned no tools despite tool_choice=any - shouldn't happen but handle gracefully
            console.warn(`[Agent] Group "${groupName}": no tool calls returned (stop=${parsed.stop_reason}). Marking NOT_ACTIONABLE.`);
            if (messageId) markMessageTerminal(messageId, 'NOT_ACTIONABLE', 'model returned no tool calls');
            return resolve({ text: '', sideEffects: [], acted: false, downloadImage: false });
          }

          const sideEffects = [];
          let downloadImage = false;
          let pipelineState = 'NOT_ACTIONABLE'; // will be updated if notice/event created
          let noticeCreatedId = null;

          for (const tool of toolUseBlocks) {
            const input = tool.input || {};

            if (tool.name === 'no_action') {
              console.log(`[Agent] Group "${groupName}": no_action - ${input.reason || ''}`);
              continue; // terminal - pipelineState stays NOT_ACTIONABLE
            }

            if (tool.name === 'download_image') {
              downloadImage = true;
              continue; // signal only, handled by whatsapp.js
            }

            if (tool.name === 'add_notice') {
              // Build the same action object the old system used
              const noticeAction = {
                action: 'add_notice',
                content:           input.content,
                thread_key:        input.thread_key,
                relevance_date:    input.relevance_date,
                relevance_time:    input.relevance_time || null,
                urgency_hint:      input.urgency_hint || 'routine',
                relevant_datetime: input.relevant_datetime || null,
                group_name:        groupName,
                source_timestamp:  ts,
                _isBacklog:        isBacklog,
              };
              const result = await executeAction(noticeAction, sender);
              if (result) {
                if (result.isSideEffect) sideEffects.push(result);
                noticeCreatedId = result.noticeId || null;
                pipelineState = 'NOTICE_CREATED';
                console.log(`[Agent] Group action (add_notice):`, JSON.stringify(result));
              }
              continue;
            }

            if (tool.name === 'add_event') {
              const eventAction = { action: 'add_event', ...input, _isBacklog: isBacklog, _rawMessage: body, _groupName: groupName };
              const result = await executeAction(eventAction, sender);
              if (result) {
                if (result.isSideEffect) sideEffects.push(result);
                console.log(`[Agent] Group action (add_event):`, JSON.stringify(result));
              }
              continue;
            }

            if (tool.name === 'add_task') {
              const taskAction = { action: 'add_task', ...input, _isBacklog: isBacklog };
              const result = await executeAction(taskAction, sender);
              if (result) {
                if (result.isSideEffect) sideEffects.push(result);
                console.log(`[Agent] Group action (add_task):`, JSON.stringify(result));
              }
              continue;
            }

            if (tool.name === 'add_homework') {
              const hwAction = { action: 'add_homework', ...input, _isBacklog: isBacklog };
              const result = await executeAction(hwAction, sender);
              if (result) {
                if (result.isSideEffect) sideEffects.push(result);
                console.log(`[Agent] Group action (add_homework):`, JSON.stringify(result));
              }
              continue;
            }

            console.warn(`[Agent] Unknown tool: ${tool.name}`);
          }

          // P-008: mark terminal state
          if (messageId) markMessageTerminal(messageId, pipelineState, null, noticeCreatedId);

          resolve({ text: '', sideEffects, acted: sideEffects.length > 0 || downloadImage, downloadImage });
        } catch (e) {
          console.error('[Agent] handleGroupEvent parse error:', e.message);
          if (messageId) markMessageFailed(messageId, JSON.stringify({ code: 'PARSE_ERROR', detail: e.message }));
          resolve({ text: '', sideEffects: [], acted: false, downloadImage: false });
        }
      });
    });

    req.on('error', (err) => {
      console.error('[Agent] handleGroupEvent request error:', err.message);
      if (messageId) markMessageFailed(messageId, JSON.stringify({ code: 'REQUEST_ERROR', detail: err.message }));
      resolve({ text: '', sideEffects: [], acted: false, downloadImage: false });
    });

    req.write(bodyStr);
    req.end();
  });
}

module.exports = { handleMessage, handleGroupEvent };
