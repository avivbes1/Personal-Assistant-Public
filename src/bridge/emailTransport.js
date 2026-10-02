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
const bridgeConfig = require('./config');
const billingState = require('./billingState');

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
 * Build a human-readable plain-text summary of the events in the envelope.
 *
 * RAW-ONLY mode (2026-10-02): no summaries, translations, classifications, or
 * commentary.  Each message is rendered as raw deterministic text:
 *   Group: <name> | Sender: <sender> | Time: <iso> | ID: <stanza_id>
 *   <exact message body>
 *   [image attached] / [document attached] / etc. when media is present
 */
function buildSummary(envelope) {
  const lines = [];
  for (const evt of (envelope.events || [])) {
    if (evt.kind === 'message') {
      const group = evt.group?.name || 'unknown';
      const sender = evt.sender || 'unknown';
      const ts = evt.timestamp_iso || (evt.timestamp ? new Date(evt.timestamp).toISOString() : 'unknown');
      const id = evt.stanza_id || evt.message_id || 'unknown';
      lines.push(`Group: ${group} | Sender: ${sender} | Time: ${ts} | ID: ${id}`);
      const body = evt.body || '';
      // Detect media markers left by the bot's media pipeline
      const mediaRe = /^\[(תמונה|מסמך|הקלטה|הקלטה קולית|וידאו|מיקום|איש קשר|מדיה)/;
      if (mediaRe.test(body.trim())) {
        // Body IS the media marker — print it as-is
        lines.push(body);
      } else {
        lines.push(body);
        // If body contains a media marker anywhere, it's caption+media — already included
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
  const summary = buildSummary(envelope);
  const body = summary;
  const bytes = Buffer.byteLength(body, 'utf8');

  if (SHADOW) {
    console.log(
      `[Bridge][shadow] WOULD send email:\n` +
      `  transport: ${TRANSPORT}\n` +
      `  to:       ${bridgeConfig.emailTo || '(unset)'}\n` +
      `  from:     ${bridgeConfig.emailFrom || '(unset)'}\n` +
      `  subject:  ${subject}\n` +
      `  events:   ${envelope.event_count}\n` +
      `  bytes:    ${bytes}\n` +
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
  const info = await transport.sendMail({
    from: bridgeConfig.emailFrom,
    to: bridgeConfig.emailTo,
    subject,
    text: body,
  });
  const messageId = info.messageId || null;
  console.log(
    `[Bridge][Gmail] sent: ${envelope.event_count} event(s), ` +
    `${bytes} bytes, delivery=${envelope.delivery_id}, msg_id=${messageId}`
  );
  return { ok: true, provider_message_id: messageId, shadow: false, bytes };
}

module.exports = { sendBatch, isBillingError, isUncertainError };
