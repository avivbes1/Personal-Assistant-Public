'use strict';
/**
 * bridge/lipaLane.js — Lipa lane for the Instinct Bridge.
 *
 * Routes [Instinct->Lipa] emails to the OpenClaw agent (Lipa) instead of
 * the Tudat bot handler. Uses a SQLite inbox/outbox as the handoff queue:
 *
 *   Inbound:  poller writes to bridge_lipa_inbox  → OpenClaw cron reads it
 *   Outbound: OpenClaw writes to bridge_lipa_outbox → poller sends reply email
 *
 * The OpenClaw cron job runs every 2 minutes and processes pending rows.
 * Auth uses a separate token (LIPA_BRIDGE_TOKEN) — not Tudat's SHARED_SECRET.
 *
 * Purely additive — never touches the existing Tudat lane.
 */

const lipaConfig = require('./lipaConfig');

// ── DB tables ────────────────────────────────────────────────────────────────

function ensureLipaTables() {
  const { getDB } = require('../db');
  getDB().exec(`
    CREATE TABLE IF NOT EXISTS bridge_lipa_inbox (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id      TEXT,
      command         TEXT NOT NULL,
      args_json       TEXT,
      from_addr       TEXT,
      subject         TEXT,
      gmail_message_id TEXT,
      created_at      INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      processed_at    INTEGER
    )
  `);
  getDB().exec(`
    CREATE TABLE IF NOT EXISTS bridge_lipa_outbox (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      inbox_id        INTEGER NOT NULL,
      request_id      TEXT,
      response_json   TEXT NOT NULL,
      original_subject TEXT,
      in_reply_to     TEXT,
      created_at      INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      sent_at         INTEGER,
      FOREIGN KEY (inbox_id) REFERENCES bridge_lipa_inbox(id)
    )
  `);
  getDB().exec(`
    CREATE INDEX IF NOT EXISTS idx_lipa_inbox_status ON bridge_lipa_inbox (status)
  `);
  getDB().exec(`
    CREATE INDEX IF NOT EXISTS idx_lipa_outbox_status ON bridge_lipa_outbox (status)
  `);
}

// ── Inbound: poller writes here ──────────────────────────────────────────────

/**
 * Queue an inbound command for Lipa processing.
 * Called by the inbound poller when it sees [Instinct->Lipa].
 */
function enqueueForLipa({ requestId, command, args, fromAddr, subject, messageId }) {
  const { getDB } = require('../db');
  ensureLipaTables();
  getDB().prepare(`
    INSERT INTO bridge_lipa_inbox (request_id, command, args_json, from_addr, subject, gmail_message_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    requestId || null,
    command || '',
    JSON.stringify(args || {}),
    fromAddr || null,
    subject || null,
    messageId || null,
    Date.now()
  );
}

// ── Outbound: OpenClaw writes here, poller reads ─────────────────────────────

/**
 * Get pending inbox rows for OpenClaw to process.
 */
function getPendingInbox(limit = 10) {
  const { getDB } = require('../db');
  ensureLipaTables();
  return getDB().prepare(`
    SELECT * FROM bridge_lipa_inbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?
  `).all(limit);
}

/**
 * Mark an inbox row as processed and queue the response for email delivery.
 */
function completeInboxRow(inboxId, requestId, responseObj, originalSubject, inReplyTo) {
  const { getDB } = require('../db');
  const now = Date.now();
  getDB().prepare('UPDATE bridge_lipa_inbox SET status = ?, processed_at = ? WHERE id = ?')
    .run('done', now, inboxId);
  getDB().prepare(`
    INSERT INTO bridge_lipa_outbox (inbox_id, request_id, response_json, original_subject, in_reply_to, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(inboxId, requestId || null, JSON.stringify(responseObj), originalSubject || null, inReplyTo || null, now);
}

/**
 * Get pending outbox rows for the poller to send as reply emails.
 */
function getPendingOutbox(limit = 10) {
  const { getDB } = require('../db');
  ensureLipaTables();
  return getDB().prepare(`
    SELECT * FROM bridge_lipa_outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?
  `).all(limit);
}

/**
 * Mark an outbox row as sent.
 */
function markOutboxSent(outboxId) {
  const { getDB } = require('../db');
  getDB().prepare('UPDATE bridge_lipa_outbox SET status = ?, sent_at = ? WHERE id = ?')
    .run('sent', Date.now(), outboxId);
}

/**
 * Mark an outbox row as failed.
 */
function markOutboxFailed(outboxId, error) {
  const { getDB } = require('../db');
  getDB().prepare('UPDATE bridge_lipa_outbox SET status = ? WHERE id = ?')
    .run('failed:' + (error || '').substring(0, 100), outboxId);
}

// ── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Validate the Lipa-lane auth token from an email body.
 * Same AUTH: line format as Tudat lane, different token.
 */
function validateLipaAuth(body) {
  if (!body || !lipaConfig.token) return { valid: false, command: null };
  const lines = body.split('\n').map(l => l.trim());
  const authLine = lines.find(l => l.startsWith('AUTH:'));
  if (!authLine) return { valid: false, command: null };
  const providedToken = authLine.replace(/^AUTH:\s*/, '').trim();
  if (providedToken !== lipaConfig.token) return { valid: false, command: null };
  const command = lines.filter(l => !l.startsWith('AUTH:')).join('\n').trim();
  return { valid: true, command };
}

// ── Reply sender (used by the poller to drain the outbox) ────────────────────

const nodemailer = require('nodemailer');

let _smtpTransport = null;
function getSmtpTransport() {
  if (!_smtpTransport) {
    const appPassword = process.env.INSTINCT_BRIDGE_GMAIL_APP_PASSWORD || '';
    if (!appPassword) throw new Error('[Bridge][Lipa] INSTINCT_BRIDGE_GMAIL_APP_PASSWORD required');
    _smtpTransport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: lipaConfig.account, pass: appPassword },
    });
  }
  return _smtpTransport;
}

/**
 * Send a reply email for a Lipa outbox row.
 */
async function sendLipaReply(outboxRow) {
  const responseObj = JSON.parse(outboxRow.response_json);
  const subject = `${lipaConfig.replySubjectPrefix} re: ${outboxRow.original_subject || '[Instinct->Lipa]'}`;
  const body = [
    `AUTH:${lipaConfig.token}`,
    '',
    JSON.stringify(responseObj, null, 2),
  ].join('\n');

  const mailOptions = {
    from: lipaConfig.account,
    to: lipaConfig.replyTo,
    subject,
    text: body,
  };
  if (outboxRow.in_reply_to) mailOptions.inReplyTo = outboxRow.in_reply_to;

  const transport = getSmtpTransport();
  const info = await transport.sendMail(mailOptions);
  console.log(`[Bridge][Lipa] reply sent: ${info.messageId} -> ${lipaConfig.replyTo}`);
  return info;
}

/**
 * Drain the Lipa outbox — send all pending reply emails.
 * Called by the inbound poller on each cycle.
 */
async function drainLipaOutbox() {
  ensureLipaTables();
  const pending = getPendingOutbox(10);
  for (const row of pending) {
    try {
      await sendLipaReply(row);
      markOutboxSent(row.id);
    } catch (err) {
      console.error(`[Bridge][Lipa] reply send failed for outbox id=${row.id}:`, err.message);
      markOutboxFailed(row.id, err.message);
    }
  }
}

module.exports = {
  ensureLipaTables,
  enqueueForLipa,
  getPendingInbox,
  completeInboxRow,
  getPendingOutbox,
  markOutboxSent,
  markOutboxFailed,
  validateLipaAuth,
  drainLipaOutbox,
  sendLipaReply,
};
