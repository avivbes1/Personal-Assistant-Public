'use strict';
/**
 * guardedSend.js — the ONLY sanctioned path for proactive reminder sends.
 *
 * Takes a (sourceType, sourceId), validates it against the DB via the
 * Hallucination Guard, renders a message from a Mustache template (the LLM
 * never writes message text), sends it through the same voice-client the
 * delivery scripts use, and records the send so it can't repeat.
 *
 * Contract:
 *   guardedSend(sourceType, sourceId, { to, reason }) -> Promise<{ sent, ... }>
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Mustache = require('mustache');

const config = require('../config');
const { validateSource, recordSent, logBlocked } = require('../validation/sourceValidator');

// The production voice-client (lib/voice-client) ships only on the prod box; a
// fresh checkout / CI DB lacks it, which used to make requiring this module throw
// (and take down anything that imported it — see notice-B1). Mirror the
// triage-engine fallback: prefer the real client, else POST directly to the local
// voice-server (:3001), the same contract the delivery launchers use.
function _httpVoiceSend(jid, text) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const body = JSON.stringify({ to: jid, text });
    const req = http.request({
      hostname: 'localhost', port: 3001, path: '/send-message',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(JSON.parse(data || '{}'));
        else reject(new Error(`send-message returned ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('send-message timeout')); });
    req.end(body);
  });
}
let sendMessage;
try {
  sendMessage = require('../../lib/voice-client').sendMessage;
} catch (_) {
  console.warn('[guardedSend] lib/voice-client not found — using direct voice-server HTTP fallback');
  sendMessage = _httpVoiceSend;
}

const MASTER_GROUP_JID = process.env.MASTER_GROUP_JID || '120363426994367917@g.us';
const TEMPLATE_DIR = path.join(__dirname, '..', '..', 'templates');

// Map each source type to its template file.
const TEMPLATES = {
  notice_event: 'reminder_notice_event.mustache',
  calendar_intents: 'reminder_calendar.mustache',
};

// Cache compiled template strings.
const _templateCache = {};
function loadTemplate(sourceType) {
  if (_templateCache[sourceType]) return _templateCache[sourceType];
  const file = TEMPLATES[sourceType];
  if (!file) throw new Error(`no template for source_type "${sourceType}"`);
  const str = fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf8');
  _templateCache[sourceType] = str;
  return str;
}

/**
 * Build the template view (data) from a validated DB record. Templates never
 * see raw records — only the fields we explicitly expose.
 */
function buildView(sourceType, sourceId, record) {
  if (sourceType === 'notice_event') {
    return {
      title: record.event_title || '',
      date: record.event_date || '',
      time: record.event_time || '',
      source_type: sourceType,
      source_id: sourceId,
    };
  }
  // calendar_intents
  let date = record.event_date || '';
  let time = '';
  if (record.event_start) {
    // ISO datetime — split into date + HH:MM for display (Israel time)
    const d = new Date(record.event_start);
    if (!Number.isNaN(d.getTime())) {
      date = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
      time = d.toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
    }
  }
  return {
    summary: record.event_title || '',
    date,
    time,
    source_type: sourceType,
    source_id: sourceId,
  };
}

/**
 * guardedSend(sourceType, sourceId, opts)
 * @param {string} sourceType
 * @param {number} sourceId
 * @param {object} [opts]
 * @param {string} [opts.to]      - WhatsApp JID (default: master group)
 * @param {string} [opts.reason]  - why the reminder was chosen (for audit)
 * @returns {Promise<{sent: boolean, reason?: string, text?: string}>}
 */
async function guardedSend(sourceType, sourceId, opts = {}) {
  const to = opts.to || MASTER_GROUP_JID;

  // Feature flag: when the guard is OFF we do not validate. We still refuse to
  // fabricate text — there is no ungrounded send path — but we log loudly.
  let record = null;
  if (!config.HALLUCINATION_GUARD_ENABLED) {
    console.warn('[guardedSend] HALLUCINATION_GUARD disabled — skipping validation for', sourceType, sourceId);
    const { getDB } = require('../db');
    const table = sourceType === 'notice_event' ? 'notice_event' : 'calendar_intents';
    record = getDB().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(sourceId));
  } else {
    const result = validateSource(sourceType, sourceId);
    if (!result.valid) {
      logBlocked('send_reminder', { source_type: sourceType, source_id: sourceId, reason: opts.reason }, result.reason);
      console.warn(`[guardedSend] BLOCKED ${sourceType} #${sourceId}: ${result.reason}`);
      return { sent: false, reason: result.reason };
    }
    record = result.record;
  }

  if (!record) {
    logBlocked('send_reminder', { source_type: sourceType, source_id: sourceId }, 'record vanished before render');
    return { sent: false, reason: 'record not found at render time' };
  }

  const template = loadTemplate(sourceType);
  const text = Mustache.render(template, buildView(sourceType, sourceId, record)).trim();
  const messageHash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

  try {
    await sendMessage(to, text);
  } catch (err) {
    console.error(`[guardedSend] send failed for ${sourceType} #${sourceId}:`, err.message);
    return { sent: false, reason: `send failed: ${err.message}` };
  }

  recordSent(sourceType, sourceId, messageHash);
  console.log(`[guardedSend] Sent reminder for ${sourceType} #${sourceId}`);
  return { sent: true, text };
}

/**
 * guardedSendProactive — grounded send path for Phase-G proactive prompts
 * (missing-time nudges, obligation nudges, conflict alerts).
 *
 * These messages don't fit the reminder contract above: they can concern events
 * with no time yet (missing_time) or a deadline more than 24h away (obligation),
 * so the -2h..+24h source window would wrongly reject them. But they must still
 * be GROUNDED — we only send about a notice that actually exists and isn't
 * dismissed — and the text is still deterministic (built by the caller from DB
 * fields, never authored by an LLM), preserving guardedSend's core guarantee.
 *
 * Send-once is the caller's responsibility via the proactive_prompts /
 * obligation_nudges status columns; this function does not itself dedup.
 *
 * @param {object} opts
 * @param {string} opts.text       fully-rendered message text (required, deterministic)
 * @param {number} opts.noticeId   the notice this prompt is grounded in (required)
 * @param {string} [opts.promptType] label for audit logs
 * @param {string} [opts.to]       WhatsApp JID (default: master group)
 * @returns {Promise<{sent:boolean, text?:string, reason?:string}>}
 */
async function guardedSendProactive({ text, noticeId, promptType = 'proactive', to } = {}) {
  const target = to || MASTER_GROUP_JID;

  if (!text || !String(text).trim()) {
    return { sent: false, reason: 'empty text — refusing to send' };
  }

  // Grounding: the notice must be real and not dismissed. A prompt about a
  // vanished/dismissed notice is stale and must never leave.
  const id = Number(noticeId);
  if (!Number.isInteger(id) || id <= 0) {
    logBlocked(promptType, { notice_id: noticeId }, 'invalid notice_id');
    return { sent: false, reason: `invalid notice_id "${noticeId}"` };
  }
  const { getDB } = require('../db');
  const notice = getDB().prepare('SELECT id, dismissed FROM notices WHERE id = ?').get(id);
  if (!notice) {
    logBlocked(promptType, { notice_id: id }, 'no such notice');
    return { sent: false, reason: `no notice with id=${id}` };
  }
  if (notice.dismissed) {
    logBlocked(promptType, { notice_id: id }, 'notice dismissed');
    return { sent: false, reason: `notice #${id} is dismissed` };
  }

  const body = String(text).trim();
  try {
    await sendMessage(target, body);
  } catch (err) {
    console.error(`[guardedSend] proactive ${promptType} send failed for notice #${id}:`, err.message);
    return { sent: false, reason: `send failed: ${err.message}` };
  }
  console.log(`[guardedSend] Sent proactive ${promptType} for notice #${id}`);
  return { sent: true, text: body };
}

module.exports = { guardedSend, guardedSendProactive };
