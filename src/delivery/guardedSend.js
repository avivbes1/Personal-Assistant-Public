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
const { sendMessage } = require('../../lib/voice-client');

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

module.exports = { guardedSend };
