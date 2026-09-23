'use strict';
/**
 * bridge/inbound.js — Instinct Bridge inbound command channel.
 *
 * Polls avivbes1@gmail.com via IMAP for emails with subject prefix
 * [Instinct->FamilyBot], validates a shared auth token, executes the command,
 * and replies to the Instinct address with [FamilyBot->Instinct] prefix.
 *
 * This is purely additive: it never throws on startup, never touches core
 * message/notice flow. The entire poll cycle is wrapped in try/catch.
 */

const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const inboundConfig = require('./inboundConfig');
const bridgeConfig = require('./config');

// ── IMAP client ──────────────────────────────────────────────────────────────

function createImapClient() {
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: inboundConfig.account,
      pass: process.env.INSTINCT_BRIDGE_GMAIL_APP_PASSWORD || '',
    },
    logger: false, // suppress noisy IMAP logs
  });
}

// ── SMTP reply transport (reuses same Gmail app password as outbound bridge) ─

let smtpTransport = null;
function getSmtpTransport() {
  if (!smtpTransport) {
    const appPassword = process.env.INSTINCT_BRIDGE_GMAIL_APP_PASSWORD || '';
    if (!appPassword) throw new Error('[Bridge][Inbound] INSTINCT_BRIDGE_GMAIL_APP_PASSWORD is required');
    smtpTransport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: inboundConfig.account, pass: appPassword },
    });
  }
  return smtpTransport;
}

// ── DB: processed-email tracking ─────────────────────────────────────────────

function ensureTable() {
  const { getDB } = require('../db');
  getDB().exec(`
    CREATE TABLE IF NOT EXISTS bridge_inbound_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      gmail_uid       TEXT NOT NULL,
      gmail_message_id TEXT,
      from_addr       TEXT,
      subject         TEXT,
      command         TEXT,
      response_summary TEXT,
      processed_at    INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'ok'
    )
  `);
  // Index for dedup lookups
  getDB().exec(`
    CREATE INDEX IF NOT EXISTS idx_bridge_inbound_uid ON bridge_inbound_log (gmail_uid)
  `);
}

function wasProcessed(uid) {
  const { getDB } = require('../db');
  return !!getDB().prepare('SELECT 1 FROM bridge_inbound_log WHERE gmail_uid = ?').get(String(uid));
}

function logProcessed(entry) {
  const { getDB } = require('../db');
  getDB().prepare(`
    INSERT INTO bridge_inbound_log (gmail_uid, gmail_message_id, from_addr, subject, command, response_summary, processed_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(entry.uid), entry.messageId || null, entry.from || null,
    entry.subject || null, entry.command || null,
    (entry.response || '').substring(0, 500),
    Date.now(), entry.status || 'ok'
  );
}

// ── Auth ─────────────────────────────────────────────────────────────────────

function extractAndValidateToken(body) {
  if (!body || !inboundConfig.token) return { valid: false, command: null };
  const lines = body.split('\n').map(l => l.trim());
  const authLine = lines.find(l => l.startsWith('AUTH:'));
  if (!authLine) return { valid: false, command: null };
  const providedToken = authLine.replace(/^AUTH:\s*/, '').trim();
  if (providedToken !== inboundConfig.token) return { valid: false, command: null };
  // Command is everything except the auth line, trimmed
  const command = lines.filter(l => !l.startsWith('AUTH:')).join('\n').trim();
  return { valid: true, command };
}

// ── Command handlers ─────────────────────────────────────────────────────────

async function handleCommand(command) {
  const cmd = command.toLowerCase().trim();

  if (cmd === 'ping') {
    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    return `Pong. FamilyBot uptime: ${h}h ${m}m. Bridge: ${bridgeConfig.enabled ? 'enabled' : 'disabled'}, valid: ${bridgeConfig.valid}. Inbound channel: active.`;
  }

  if (cmd === 'help') {
    return [
      'Available commands:',
      '  ping              — check bot status and uptime',
      '  bridge stats [N]  — delivery stats for last N days (default 7)',
      '  help              — this message',
      '',
      'Include AUTH:<token> on its own line in every email.',
    ].join('\n');
  }

  const statsMatch = cmd.match(/^bridge\s+stats(?:\s+(\d+))?/);
  if (statsMatch) {
    const days = parseInt(statsMatch[1], 10) || 7;
    return getBridgeStats(days);
  }

  return `Unknown command: "${command.substring(0, 100)}"\nSend "help" for available commands.`;
}

function getBridgeStats(days) {
  try {
    const { getDB } = require('../db');
    const cutoff = Date.now() - days * 86400000;

    // Outbox stats
    const total = getDB().prepare(
      'SELECT COUNT(*) as cnt FROM bridge_outbox WHERE created_at > ?'
    ).get(cutoff);
    const delivered = getDB().prepare(
      'SELECT COUNT(*) as cnt FROM bridge_outbox WHERE status = ? AND created_at > ?'
    ).get('delivered', cutoff);
    const failed = getDB().prepare(
      'SELECT COUNT(*) as cnt FROM bridge_outbox WHERE status = ? AND created_at > ?'
    ).get('failed', cutoff);
    const dead = getDB().prepare(
      'SELECT COUNT(*) as cnt FROM bridge_outbox WHERE status = ? AND created_at > ?'
    ).get('dead', cutoff);
    const pending = getDB().prepare(
      'SELECT COUNT(*) as cnt FROM bridge_outbox WHERE status = ? AND created_at > ?'
    ).get('pending', cutoff);

    // By event type
    const byType = getDB().prepare(
      'SELECT event_type, COUNT(*) as cnt FROM bridge_outbox WHERE created_at > ? GROUP BY event_type'
    ).all(cutoff);

    const lines = [
      `Bridge stats — last ${days} day(s):`,
      `  Total events:    ${total.cnt}`,
      `  Delivered:       ${delivered.cnt}`,
      `  Pending:         ${pending.cnt}`,
      `  Failed:          ${failed.cnt}`,
      `  Dead-lettered:   ${dead.cnt}`,
      '',
      'By event type:',
    ];
    for (const row of byType) {
      lines.push(`  ${row.event_type}: ${row.cnt}`);
    }

    // Group breakdown
    try {
      const byGroup = getDB().prepare(`
        SELECT json_extract(payload, '$.group.name') as grp, COUNT(*) as cnt
        FROM bridge_outbox
        WHERE created_at > ? AND json_extract(payload, '$.group.name') IS NOT NULL
        GROUP BY grp ORDER BY cnt DESC LIMIT 10
      `).all(cutoff);
      if (byGroup.length > 0) {
        lines.push('', 'Top groups:');
        for (const row of byGroup) {
          lines.push(`  ${row.grp}: ${row.cnt}`);
        }
      }
    } catch (_) { /* json_extract may not be available */ }

    return lines.join('\n');
  } catch (err) {
    return `Error fetching bridge stats: ${err.message}`;
  }
}

// ── Reply sender ─────────────────────────────────────────────────────────────

async function sendReply(originalSubject, responseBody, inReplyTo) {
  const subject = `${inboundConfig.replySubjectPrefix} Re: ${originalSubject}`;
  const body = [
    responseBody,
    '',
    `AUTH:${inboundConfig.token}`,
  ].join('\n');

  const mailOptions = {
    from: inboundConfig.account,
    to: inboundConfig.replyTo,
    subject,
    text: body,
  };
  if (inReplyTo) mailOptions.inReplyTo = inReplyTo;

  const transport = getSmtpTransport();
  const info = await transport.sendMail(mailOptions);
  console.log(`[Bridge][Inbound] reply sent: ${info.messageId} -> ${inboundConfig.replyTo}`);
  return info;
}

// ── IMAP poll cycle ──────────────────────────────────────────────────────────

async function pollCycle() {
  if (!inboundConfig.enabled || !inboundConfig.valid) return;

  const client = createImapClient();
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Search for messages with our subject prefix
      const searchCriteria = {
        subject: inboundConfig.inboundSubjectPrefix,
        since: new Date(Date.now() - 86400000), // last 24h
      };

      const messages = [];
      for await (const msg of client.fetch(
        { subject: inboundConfig.inboundSubjectPrefix, since: new Date(Date.now() - 86400000) },
        { uid: true, envelope: true, source: true },
        { uid: true }
      )) {
        messages.push(msg);
      }

      if (messages.length === 0) return;

      for (const msg of messages) {
        const uid = String(msg.uid);
        if (wasProcessed(uid)) continue;

        try {
          await processMessage(msg, uid);
        } catch (err) {
          console.error(`[Bridge][Inbound] failed to process uid=${uid}:`, err.message);
          logProcessed({ uid, status: 'error', command: null, response: err.message });
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    console.error('[Bridge][Inbound] poll cycle failed:', err.message);
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

async function processMessage(msg, uid) {
  const envelope = msg.envelope || {};
  const subject = envelope.subject || '';
  const fromAddr = (envelope.from && envelope.from[0])
    ? (envelope.from[0].address || '')
    : '';
  const messageId = envelope.messageId || null;

  // Parse the raw email source to get the plain text body
  const rawSource = msg.source ? msg.source.toString('utf8') : '';
  const body = extractPlainBody(rawSource);

  console.log(`[Bridge][Inbound] new email: uid=${uid} from=${fromAddr} subject="${subject.substring(0, 80)}"`);

  // Validate auth token
  const { valid, command } = extractAndValidateToken(body);
  if (!valid) {
    console.warn(`[Bridge][Inbound] auth failed for uid=${uid} from=${fromAddr}`);
    logProcessed({ uid, messageId, from: fromAddr, subject, status: 'auth_failed', command: null, response: 'Invalid or missing auth token' });
    return; // silently reject — don't reply to unauthenticated emails
  }

  if (!command) {
    logProcessed({ uid, messageId, from: fromAddr, subject, status: 'empty', command: '', response: 'Empty command' });
    return;
  }

  // Execute command
  const response = await handleCommand(command);

  // Send reply
  try {
    await sendReply(subject, response, messageId);
    logProcessed({ uid, messageId, from: fromAddr, subject, status: 'ok', command, response });
  } catch (err) {
    console.error(`[Bridge][Inbound] reply send failed for uid=${uid}:`, err.message);
    logProcessed({ uid, messageId, from: fromAddr, subject, status: 'reply_failed', command, response: err.message });
  }
}

/**
 * Extract the plain text body from raw email source.
 * Handles both simple text/plain emails and multipart MIME.
 */
function extractPlainBody(raw) {
  if (!raw) return '';

  // Split headers from body at the first blank line
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd === -1) {
    const altEnd = raw.indexOf('\n\n');
    if (altEnd === -1) return '';
    const headers = raw.substring(0, altEnd).toLowerCase();
    const body = raw.substring(altEnd + 2);
    // If multipart, try to extract text/plain part
    if (headers.includes('multipart')) return extractMultipartPlain(raw);
    return decodeBody(body, raw.substring(0, altEnd));
  }

  const headers = raw.substring(0, headerEnd).toLowerCase();
  const body = raw.substring(headerEnd + 4);

  if (headers.includes('multipart')) return extractMultipartPlain(raw);
  return decodeBody(body, raw.substring(0, headerEnd));
}

function extractMultipartPlain(raw) {
  // Find boundary
  const boundaryMatch = raw.match(/boundary="?([^"\r\n;]+)"?/i);
  if (!boundaryMatch) return raw.replace(/^[\s\S]*?\r?\n\r?\n/, '').trim();

  const boundary = boundaryMatch[1];
  const parts = raw.split('--' + boundary);

  for (const part of parts) {
    const partLower = part.toLowerCase();
    if (partLower.includes('content-type: text/plain') || partLower.includes('content-type:text/plain')) {
      // Extract body after headers
      const bodyStart = part.indexOf('\r\n\r\n');
      if (bodyStart !== -1) {
        return decodeBody(part.substring(bodyStart + 4), part.substring(0, bodyStart));
      }
      const altStart = part.indexOf('\n\n');
      if (altStart !== -1) {
        return decodeBody(part.substring(altStart + 2), part.substring(0, altStart));
      }
    }
  }

  // Fallback: first part after headers
  if (parts.length > 1) {
    const first = parts[1];
    const bodyStart = first.indexOf('\r\n\r\n') !== -1 ? first.indexOf('\r\n\r\n') + 4 : first.indexOf('\n\n') + 2;
    return first.substring(bodyStart).replace(/--\s*$/, '').trim();
  }

  return '';
}

function decodeBody(body, headers) {
  const headersLower = (headers || '').toLowerCase();
  let decoded = body;

  // Handle quoted-printable
  if (headersLower.includes('quoted-printable')) {
    decoded = decoded
      .replace(/=\r?\n/g, '')  // soft line breaks
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  // Handle base64
  if (headersLower.includes('base64')) {
    try {
      decoded = Buffer.from(decoded.replace(/\s/g, ''), 'base64').toString('utf8');
    } catch (_) {}
  }

  // Strip trailing MIME boundary markers
  decoded = decoded.replace(/--[^\r\n]+--\s*$/, '').trim();

  return decoded;
}

// ── Poller lifecycle ─────────────────────────────────────────────────────────

let pollInterval = null;

function startInboundPoller() {
  if (!inboundConfig.enabled) {
    console.log('[Bridge][Inbound] disabled — skipping poller start');
    return;
  }
  if (!inboundConfig.valid) {
    console.error('[Bridge][Inbound] config invalid — skipping poller start');
    return;
  }

  ensureTable();

  console.log(
    `[Bridge][Inbound] starting poller — every ${inboundConfig.pollMs / 1000}s, ` +
    `account=${inboundConfig.account}, replyTo=${inboundConfig.replyTo}`
  );

  // Initial poll after 10s (let the process settle)
  setTimeout(() => {
    pollCycle().catch(err => console.error('[Bridge][Inbound] initial poll failed:', err.message));
  }, 10000);

  pollInterval = setInterval(() => {
    pollCycle().catch(err => console.error('[Bridge][Inbound] poll failed:', err.message));
  }, inboundConfig.pollMs);
}

function stopInboundPoller() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.log('[Bridge][Inbound] poller stopped');
  }
}

module.exports = {
  startInboundPoller,
  stopInboundPoller,
  pollCycle,        // exported for manual trigger / testing
  handleCommand,    // exported for testing
};
