'use strict';
/**
 * bridge/inbound.js — Instinct Bridge inbound command channel.
 *
 * Polls the configured Gmail account via IMAP for emails with subject prefix
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
      request_id      TEXT,
      response_summary TEXT,
      processed_at    INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'ok'
    )
  `);
  // Indexes for dedup lookups (uid for legacy, message_id for cross-mailbox)
  getDB().exec(`
    CREATE INDEX IF NOT EXISTS idx_bridge_inbound_uid ON bridge_inbound_log (gmail_uid)
  `);
  getDB().exec(`
    CREATE INDEX IF NOT EXISTS idx_bridge_inbound_msgid ON bridge_inbound_log (gmail_message_id)
  `);
  // Migration: add request_id column if table already existed without it
  try {
    const cols = getDB().prepare('PRAGMA table_info(bridge_inbound_log)').all().map(c => c.name);
    if (!cols.includes('request_id')) {
      getDB().exec('ALTER TABLE bridge_inbound_log ADD COLUMN request_id TEXT');
      console.log('[Bridge][Inbound] migrated: added request_id column to bridge_inbound_log');
    }
  } catch (_) {}
}

/** Normalize RFC Message-ID: strip angle brackets + lowercase for stable comparison. */
function normalizeMsgId(raw) {
  if (!raw) return null;
  return String(raw).replace(/^<|>$/g, '').toLowerCase();
}

/**
 * Check if a message was already processed.
 * Primary key: gmail_message_id (RFC Message-ID) — stable across mailboxes.
 * Tries both raw and normalized forms to handle <brackets> mismatches.
 * Falls back to gmail_uid for legacy rows that lack a message_id.
 */
function wasProcessed(uid, messageId) {
  const { getDB } = require('../db');
  if (messageId) {
    // Try exact match first, then normalized (strip <> + lowercase)
    const exact = getDB().prepare('SELECT 1 FROM bridge_inbound_log WHERE gmail_message_id = ?').get(String(messageId));
    if (exact) return true;
    const norm = normalizeMsgId(messageId);
    if (norm) {
      const stripped = getDB().prepare('SELECT 1 FROM bridge_inbound_log WHERE gmail_message_id = ? OR gmail_message_id = ? OR gmail_message_id = ?').get(norm, `<${norm}>`, String(messageId).toLowerCase());
      if (stripped) return true;
    }
  }
  if (uid) {
    const byUid = getDB().prepare('SELECT 1 FROM bridge_inbound_log WHERE gmail_uid = ?').get(String(uid));
    if (byUid) return true;
  }
  return false;
}

function logProcessed(entry) {
  const { getDB } = require('../db');
  // INSERT OR IGNORE: if the gmail_message_id already exists (UNIQUE), skip
  // gracefully instead of throwing — handles cross-mailbox UID changes.
  getDB().prepare(`
    INSERT OR IGNORE INTO bridge_inbound_log (gmail_uid, gmail_message_id, from_addr, subject, command, request_id, response_summary, processed_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(entry.uid), entry.messageId || 'uid:' + entry.uid, entry.from || null,
    entry.subject || null, entry.command || null, entry.requestId || null,
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

/**
 * Parse the command body as JSON: {"command": "...", "args": {...}, "request_id": "..."}.
 * Falls back to legacy plain-text dispatch for backward compatibility.
 */
function parseCommandPayload(raw) {
  const trimmed = raw.trim();
  // Attempt JSON parse first
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.command === 'string') {
        return {
          json: true,
          command: parsed.command.toLowerCase().trim(),
          args: parsed.args || {},
          request_id: parsed.request_id || null,
        };
      }
    } catch (_) {
      // Malformed JSON — will be reported as an error
      return { json: true, command: null, args: {}, request_id: null, parseError: trimmed.substring(0, 200) };
    }
  }
  // Legacy plain-text mode
  return { json: false, command: trimmed.toLowerCase(), args: {}, request_id: null };
}

/**
 * Build a structured JSON response envelope.
 */
function buildResponse(requestId, ok, result) {
  return { request_id: requestId || null, ok, result };
}

/**
 * Main command dispatcher.  Returns { requestId, responseObj } where
 * responseObj is {request_id, ok, result}.
 */
async function handleCommand(command) {
  const parsed = parseCommandPayload(command);

  // Malformed JSON
  if (parsed.json && parsed.command === null) {
    return {
      requestId: null,
      responseObj: buildResponse(null, false, {
        error: 'malformed_json',
        message: `Could not parse JSON command body: ${parsed.parseError}`,
      }),
    };
  }

  const cmd = parsed.command;
  const args = parsed.args;
  const requestId = parsed.request_id;

  // ── ping ──
  if (cmd === 'ping') {
    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    return {
      requestId,
      responseObj: buildResponse(requestId, true, {
        pong: true,
        uptime: `${h}h ${m}m`,
        bridge_enabled: bridgeConfig.enabled,
        bridge_valid: bridgeConfig.valid,
        inbound_channel: 'active',
        protocol: 'json/v1',
      }),
    };
  }

  // ── help ──
  if (cmd === 'help') {
    return {
      requestId,
      responseObj: buildResponse(requestId, true, {
        commands: [
          { name: 'ping', description: 'Check bot status and uptime' },
          { name: 'help', description: 'List available commands' },
          { name: 'bridge_stats', description: 'Delivery stats for last N days', args: { days: 'number (default 7)' } },
          { name: 'free_text', description: 'Natural-language query processed by the bot agent', args: { text: 'string (required)' } },
        ],
        auth: 'Include AUTH:<token> on its own line before the JSON body.',
      }),
    };
  }

  // ── bridge_stats (also accepts legacy "bridge stats N") ──
  if (cmd === 'bridge_stats' || cmd.startsWith('bridge stats') || cmd.startsWith('bridge_stats')) {
    const days = parseInt(args.days, 10) || (() => {
      const m = cmd.match(/(?:bridge[_ ]stats)\s+(\d+)/);
      return m ? parseInt(m[1], 10) : 7;
    })();
    const stats = getBridgeStats(days);
    return {
      requestId,
      responseObj: buildResponse(requestId, true, typeof stats === 'string' ? { summary: stats } : stats),
    };
  }

  // ── free_text — pass to the bot's normal language handler ──
  if (cmd === 'free_text') {
    const text = args.text || '';
    if (!text) {
      return {
        requestId,
        responseObj: buildResponse(requestId, false, {
          error: 'missing_arg',
          message: 'free_text requires args.text',
        }),
      };
    }
    try {
      const { handleMessage } = require('../agent');
      const agentResult = await handleMessage(text, null, 'Instinct', []);
      return {
        requestId,
        responseObj: buildResponse(requestId, true, {
          reply: agentResult.text || '',
          side_effects: (agentResult.sideEffects || []).length,
        }),
      };
    } catch (err) {
      console.error('[Bridge][Inbound] free_text handler error:', err.message);
      return {
        requestId,
        responseObj: buildResponse(requestId, false, {
          error: 'handler_error',
          message: err.message,
        }),
      };
    }
  }

  // ── unknown command ──
  return {
    requestId,
    responseObj: buildResponse(requestId, false, {
      error: 'unknown_command',
      message: `Unknown command: "${cmd}". Send {"command":"help"} for available commands.`,
    }),
  };
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
        SELECT json_extract(payload_json, '$.group.name') as grp, COUNT(*) as cnt
        FROM bridge_outbox
        WHERE created_at > ? AND json_extract(payload_json, '$.group.name') IS NOT NULL
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

async function sendReply(originalSubject, responseObj, inReplyTo) {
  const subject = `${inboundConfig.replySubjectPrefix} re: ${originalSubject}`;
  const body = [
    `AUTH:${inboundConfig.token}`,
    '',
    JSON.stringify(responseObj, null, 2),
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
    // Use label-scoped mailbox instead of INBOX so the Gmail filter can
    // archive bridge mail out of the inbox while we still see it.
    const MAILBOX = process.env.INSTINCT_BRIDGE_INBOUND_MAILBOX || 'FamilyBot Bridge';
    const lock = await client.getMailboxLock(MAILBOX);
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
        const envelope = msg.envelope || {};
        const msgId = envelope.messageId || null;

        // Skip our own reply emails — the label catches them because
        // "[FamilyBot->Instinct] re: [Instinct->FamilyBot]" contains
        // the inbound subject prefix as a substring.
        const subject = envelope.subject || '';
        if (subject.startsWith(inboundConfig.replySubjectPrefix)) continue;

        if (wasProcessed(uid, msgId)) continue;

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
  const { requestId, responseObj } = await handleCommand(command);
  const responseStr = JSON.stringify(responseObj);

  // Send reply
  try {
    await sendReply(subject, responseObj, messageId);
    logProcessed({ uid, messageId, from: fromAddr, subject, status: 'ok', command, requestId, response: responseStr });
  } catch (err) {
    console.error(`[Bridge][Inbound] reply send failed for uid=${uid}:`, err.message);
    logProcessed({ uid, messageId, from: fromAddr, subject, status: 'reply_failed', command, requestId, response: err.message });
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
