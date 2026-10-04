'use strict';
/**
 * bridge/emailTransport.js — Email delivery transport for the Instinct Bridge.
 *
 * Supports two backends:
 *   1. Gmail SMTP (default) — uses nodemailer + app password. Gmail signs DKIM
 *      and SPF aligns natively. Set INSTINCT_BRIDGE_GMAIL_APP_PASSWORD.
 *   2. AWS SES (legacy) — uses the EC2 instance role. Set
 *      INSTINCT_BRIDGE_TRANSPORT=ses to use this path.
 *
 * Shadow mode: when INSTINCT_BRIDGE_SHADOW=1, logs what WOULD send without
 * actually calling either backend. Useful for dry-run validation.
 */

const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const bridgeConfig = require('./config');
const billingState = require('./billingState');

// RAW-ONLY media: max file size for email attachments (10 MB)
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const SHADOW = process.env.INSTINCT_BRIDGE_SHADOW === '1';
const TRANSPORT = (process.env.INSTINCT_BRIDGE_TRANSPORT || 'gmail').toLowerCase();

// SMTP reply codes that specifically indicate a billing/quota/credit problem
// (as opposed to a generic transient failure). 4xx = temporary, 5xx = permanent;
// we only trip the breaker when the accompanying text also names a billing cause.
const BILLING_SMTP_CODES = new Set([421, 450, 451, 452, 471, 550, 552]);
const BILLING_TEXT = /(quota|insufficient|billing|credit|payment|account\s+(?:is\s+)?(?:paused|suspended|disabled)|sending\s+paused|over\s+limit|exceeded)/i;

/**
 * True if `err` is an ACTUAL provider billing/quota rejection — SES
 * AccountSendingPausedException, or an SMTP failure whose code AND text both
 * point at a credit/quota cause. A bare transient SMTP failure is NOT billing.
 */
function isBillingError(err) {
  if (!err) return false;
  const name = err.name || err.Name || '';
  const code = err.responseCode || err.smtpCode || null;
  const text = `${err.message || ''} ${err.response || ''} ${err.__type || ''}`;

  // SES: the dedicated account-paused exception.
  if (/AccountSendingPausedException/i.test(name) || /AccountSendingPausedException/i.test(text)) {
    return true;
  }
  // SES throttling that names quota.
  if (/Throttling|LimitExceeded/i.test(name) && BILLING_TEXT.test(text)) return true;

  // SMTP: a billing-class reply code with billing-class text.
  if (code && BILLING_SMTP_CODES.has(Number(code)) && BILLING_TEXT.test(text)) return true;

  // Fallback: unmistakable billing text on any error.
  if (BILLING_TEXT.test(text) && /(billing|insufficient|credit|payment|sending\s+paused|account\s+(?:paused|suspended))/i.test(text)) {
    return true;
  }
  return false;
}

/**
 * True if `err` leaves delivery genuinely UNCERTAIN — a timeout or dropped
 * socket that may have occurred after the message was accepted. These must not
 * be blindly retried (risking a duplicate send); they route to needs_review.
 */
function isUncertainError(err) {
  if (!err) return false;
  const code = err.code || '';
  if (['ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'EPIPE'].includes(code)) return true;
  return /timed?\s*out|timeout/i.test(err.message || '');
}

// --- Gmail SMTP transport (default) ---
let gmailTransport = null;
function getGmailTransport() {
  if (!gmailTransport) {
    const appPassword = process.env.INSTINCT_BRIDGE_GMAIL_APP_PASSWORD || '';
    if (!appPassword) throw new Error('[Bridge] INSTINCT_BRIDGE_GMAIL_APP_PASSWORD is required for Gmail transport');
    gmailTransport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: bridgeConfig.emailFrom,
        pass: appPassword,
      },
    });
  }
  return gmailTransport;
}

// --- SES transport (legacy fallback) ---
let sesClient = null;
function getSES() {
  if (!sesClient) {
    const { SESClient } = require('@aws-sdk/client-ses');
    const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'eu-west-1';
    sesClient = new SESClient({ region: REGION });
  }
  return sesClient;
}

/**
 * Collect media attachments from envelope events.  Returns an array of
 * { path, filename, contentType, tooLarge?, sizeHuman? } objects.  Files that
 * exceed MAX_ATTACHMENT_BYTES get a marker in the text body instead of being
 * attached.  No model call, no conversion — original binary only.
 */
function collectAttachments(envelope) {
  const attachments = [];
  for (const evt of (envelope.events || [])) {
    if (evt.kind !== 'message' || !evt.media_path) continue;
    const filePath = evt.media_path;
    try {
      if (!fs.existsSync(filePath)) continue;
      const stat = fs.statSync(filePath);
      const filename = path.basename(filePath);
      if (stat.size > MAX_ATTACHMENT_BYTES) {
        const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
        attachments.push({ path: filePath, filename, tooLarge: true, sizeHuman: `${sizeMB} MB` });
      } else {
        attachments.push({
          path: filePath,
          filename,
          contentType: evt.media_type || 'application/octet-stream',
          tooLarge: false,
        });
      }
    } catch (_) {
      // File unreadable — skip silently
    }
  }
  return attachments;
}

/**
 * Build a human-readable plain-text summary of the events in the envelope.
 *
 * RAW-ONLY mode (2026-10-02): no summaries, translations, classifications, or
 * commentary.  Each message is rendered as raw deterministic text:
 *   Group: <name> | Sender: <sender> | Phone: <phone> | Time: <iso> | ID: <stanza_id>
 *   <exact message body>
 *   [image attached] / [document attached] / etc. when media is present
 */
function buildSummary(envelope, attachments) {
  const lines = [];
  // Build a lookup: media_path → attachment info for too-large markers
  const attachMap = new Map();
  for (const a of (attachments || [])) {
    attachMap.set(a.path, a);
  }

  for (const evt of (envelope.events || [])) {
    if (evt.kind === 'message') {
      const group = evt.group?.name || 'unknown';
      const sender = evt.sender || 'unknown';
      const ts = evt.timestamp_iso || (evt.timestamp ? new Date(evt.timestamp).toISOString() : 'unknown');
      const id = evt.stanza_id || evt.message_id || 'unknown';
      const phone = evt.sender_phone || 'unknown';
      lines.push(`Group: ${group} | Sender: ${sender} | Phone: ${phone} | Time: ${ts} | ID: ${id}`);
      lines.push(evt.body || '');

      // Media attachment markers
      if (evt.media_path) {
        const att = attachMap.get(evt.media_path);
        if (att && att.tooLarge) {
          lines.push(`[too large: ${att.filename}, ${att.sizeHuman}]`);
        } else if (att && !att.tooLarge) {
          lines.push(`[${att.filename} attached]`);
        }
      }
      lines.push('');
    }
    // notice events are no longer enqueued (RAW-ONLY mode), but handle gracefully
    if (evt.kind === 'notice') {
      lines.push(`[notice — skipped in RAW-ONLY mode]`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

/**
 * Send a delivery envelope via SES (or log in shadow mode).
 * @param {object} envelope  built by envelope.buildEnvelope()
 * @returns {{ok: boolean, provider_message_id: string, shadow?: boolean, bytes: number}}
 */
async function sendBatch(envelope) {
  // Billing circuit breaker: once tripped, every send is skipped (with a logged
  // warning) until an operator manually unpauses. Checked before any provider
  // call so a paused account is never contacted.
  if (billingState.isBillingPaused()) {
    const st = billingState.getBillingState();
    console.warn(
      `[Bridge] send SKIPPED — billing paused since ${st.paused_at || 'unknown'} ` +
      `(${st.error || 'no error recorded'}); ${envelope.event_count} event(s) held. ` +
      `Manually unpause after restoring credit.`
    );
    return { ok: false, skipped: 'billing_paused', bytes: 0 };
  }

  const subject = `${bridgeConfig.subjectPrefix} ${envelope.event_count} event(s) [${envelope.stream}]`;
  // RAW-ONLY mode (2026-10-02): email body is plain raw text only, no JSON payload.
  // The JSON envelope is still used internally for dedup/outbox but not emailed.
  // Collect media attachments (original files, no conversion/model processing).
  const mediaAttachments = collectAttachments(envelope);
  const summary = buildSummary(envelope, mediaAttachments);
  const body = summary;
  const bytes = Buffer.byteLength(body, 'utf8');
  // Build nodemailer attachment objects for files under the size cap
  const emailAttachments = mediaAttachments
    .filter(a => !a.tooLarge)
    .map(a => ({ filename: a.filename, path: a.path, contentType: a.contentType }));

  if (SHADOW) {
    console.log(
      `[Bridge][shadow] WOULD send email:\n` +
      `  transport: ${TRANSPORT}\n` +
      `  to:       ${bridgeConfig.emailTo || '(unset)'}\n` +
      `  from:     ${bridgeConfig.emailFrom || '(unset)'}\n` +
      `  subject:  ${subject}\n` +
      `  events:   ${envelope.event_count}\n` +
      `  bytes:    ${bytes}\n` +
      `  attachments: ${emailAttachments.length}\n` +
      `  delivery: ${envelope.delivery_id}`
    );
    return { ok: true, provider_message_id: `shadow-${envelope.delivery_id}`, shadow: true, bytes };
  }

  if (TRANSPORT === 'ses') {
    // Legacy SES path
    const { SendEmailCommand } = require('@aws-sdk/client-ses');
    const cmd = new SendEmailCommand({
      Source: bridgeConfig.emailFrom,
      Destination: { ToAddresses: [bridgeConfig.emailTo] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Text: { Data: body, Charset: 'UTF-8' } },
      },
    });
    const result = await getSES().send(cmd);
    const messageId = result.MessageId || null;
    console.log(
      `[Bridge][SES] sent: ${envelope.event_count} event(s), ` +
      `${bytes} bytes, delivery=${envelope.delivery_id}, ses_id=${messageId}`
    );
    return { ok: true, provider_message_id: messageId, shadow: false, bytes };
  }

  // Default: Gmail SMTP
  const transport = getGmailTransport();
  const mailOpts = {
    from: bridgeConfig.emailFrom,
    to: bridgeConfig.emailTo,
    subject,
    text: body,
  };
  if (emailAttachments.length > 0) {
    mailOpts.attachments = emailAttachments;
  }
  const info = await transport.sendMail(mailOpts);
  const messageId = info.messageId || null;
  console.log(
    `[Bridge][Gmail] sent: ${envelope.event_count} event(s), ` +
    `${bytes} bytes, ${emailAttachments.length} attachment(s), ` +
    `delivery=${envelope.delivery_id}, msg_id=${messageId}`
  );
  return { ok: true, provider_message_id: messageId, shadow: false, bytes };
}

module.exports = { sendBatch, isBillingError, isUncertainError };
