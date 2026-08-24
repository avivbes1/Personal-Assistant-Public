'use strict';

/**
 * system-message-capture.js — Event-driven capture of inbound DM messages
 * from Aviv (the operator) into a plain-file "system inbox".
 *
 * Every messages.upsert, if a message is from Aviv's JID (and not fromMe),
 * it is written to data/system-inbox/ as a JSON file named
 * {timestamp}_{messageId}.json. This gives other tooling a simple, durable
 * drop folder of operator instructions without touching the main pipeline.
 */

const fs = require('fs');
const path = require('path');
const appLogger = require('./logger');

// Aviv's JID (operator). Compared by phone/user part, so device suffixes and
// @c.us vs @s.whatsapp.net server differences don't matter.
const AVIV_JID = (process.env.AVIV_PHONE || '').replace(/^\+/, '') + '@c.us';
const AVIV_USER = AVIV_JID.split('@')[0];

const SYSTEM_INBOX = path.join(__dirname, '..', 'data', 'system-inbox');

/**
 * Ensure the system-inbox directory exists.
 */
function ensureInboxDir() {
  if (!fs.existsSync(SYSTEM_INBOX)) {
    fs.mkdirSync(SYSTEM_INBOX, { recursive: true });
  }
}

/**
 * Extract the user (phone) part of a JID, ignoring device suffix and server.
 */
function jidUser(jid) {
  if (!jid) return '';
  return String(jid).split('@')[0].split(':')[0];
}

/**
 * Extract human-readable text from a Baileys message content object.
 */
function extractText(message) {
  if (!message) return '';
  return (
    message.conversation ||
    (message.extendedTextMessage && message.extendedTextMessage.text) ||
    (message.imageMessage && message.imageMessage.caption) ||
    (message.videoMessage && message.videoMessage.caption) ||
    (message.documentMessage && message.documentMessage.caption) ||
    (message.buttonsResponseMessage && message.buttonsResponseMessage.selectedDisplayText) ||
    (message.listResponseMessage && message.listResponseMessage.title) ||
    (message.ephemeralMessage && message.ephemeralMessage.message &&
      extractText(message.ephemeralMessage.message)) ||
    (message.viewOnceMessage && message.viewOnceMessage.message &&
      extractText(message.viewOnceMessage.message)) ||
    ''
  );
}

/**
 * Determine a coarse message type from the content object.
 */
function messageType(message) {
  if (!message) return 'unknown';
  const key = Object.keys(message).find(k => k !== 'messageContextInfo');
  return key || 'unknown';
}

/**
 * Register a messages.upsert handler on the given Baileys socket that captures
 * inbound DMs from Aviv into the system inbox.
 *
 * @param {object} sock — a Baileys WASocket (has sock.ev.on)
 */
function captureSystemMessages(sock) {
  if (!sock || !sock.ev || typeof sock.ev.on !== 'function') {
    appLogger.warn({ component: 'SystemMessageCapture' }, 'No valid socket provided — skipping');
    return;
  }

  ensureInboxDir();

  sock.ev.on('messages.upsert', ({ messages }) => {
    if (!Array.isArray(messages)) return;

    for (const rawMsg of messages) {
      try {
        const key = rawMsg && rawMsg.key;
        if (!key) continue;
        // Only inbound (not from us) messages from Aviv's JID.
        if (key.fromMe) continue;
        if (jidUser(key.remoteJid) !== AVIV_USER) continue;
        if (!rawMsg.message) continue;

        const id = key.id;
        const timestamp = rawMsg.messageTimestamp ? Number(rawMsg.messageTimestamp) : Math.floor(Date.now() / 1000);
        const text = extractText(rawMsg.message);
        const type = messageType(rawMsg.message);

        const record = {
          id,
          timestamp,
          text,
          type,
          raw: rawMsg,
        };

        // Sanitize messageId for use in a filename.
        const safeId = String(id || 'noid').replace(/[^a-zA-Z0-9_-]/g, '');
        const filePath = path.join(SYSTEM_INBOX, `${timestamp}_${safeId}.json`);
        fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8');

        appLogger.info({ component: 'SystemMessageCapture', id, type }, 'Captured system message from Aviv');
      } catch (err) {
        appLogger.error({ component: 'SystemMessageCapture', err: err.message }, 'Error capturing system message');
      }
    }
  });

  appLogger.info({ component: 'SystemMessageCapture' }, 'System message capture attached');
}

module.exports = { captureSystemMessages, SYSTEM_INBOX };
