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

const SHADOW = process.env.INSTINCT_BRIDGE_SHADOW === '1';
const TRANSPORT = (process.env.INSTINCT_BRIDGE_TRANSPORT || 'gmail').toLowerCase();

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
 * Build a human-readable plain-text summary of the events in the envelope,
 * placed above the canonical JSON payload so the email is inspectable without
 * parsing JSON.
 */
function buildSummary(envelope) {
  const lines = [`FamilyBot Bridge — ${envelope.event_count} event(s)`, ''];
  for (const evt of (envelope.events || [])) {
    if (evt.kind === 'notice') {
      const date = evt.relevance_date ? ` (${evt.relevance_date})` : '';
      lines.push(`• [notice] ${(evt.content || '').substring(0, 120)}${date}`);
    } else if (evt.kind === 'message') {
      const group = evt.group?.name || 'unknown';
      lines.push(`• [msg] ${group}: ${(evt.body || '').substring(0, 100)}`);
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
  const subject = `${bridgeConfig.subjectPrefix} ${envelope.event_count} event(s) [${envelope.stream}]`;
  const jsonPayload = JSON.stringify(envelope, null, 2);
  const bytes = Buffer.byteLength(jsonPayload, 'utf8');
  const summary = buildSummary(envelope);
  const body = `${summary}\n\n---\nCanonical JSON payload:\n\n${jsonPayload}`;

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

module.exports = { sendBatch };
