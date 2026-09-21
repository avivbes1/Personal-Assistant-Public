'use strict';
/**
 * bridge/emailTransport.js — SES delivery transport for the Instinct Bridge.
 *
 * Sends batched event envelopes to Instinct via AWS SES. The EC2 instance role
 * provides credentials automatically — no API keys needed.
 *
 * Shadow mode: when INSTINCT_BRIDGE_SHADOW=1, logs what WOULD send without
 * actually calling SES. Useful for dry-run validation.
 */

const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const bridgeConfig = require('./config');

// Region from EC2 metadata or env; the instance is in eu-west-1.
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'eu-west-1';
const ses = new SESClient({ region: REGION });

const SHADOW = process.env.INSTINCT_BRIDGE_SHADOW === '1';

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
      `  to:       ${bridgeConfig.emailTo || '(unset)'}\n` +
      `  from:     ${bridgeConfig.emailFrom || '(unset)'}\n` +
      `  subject:  ${subject}\n` +
      `  events:   ${envelope.event_count}\n` +
      `  bytes:    ${bytes}\n` +
      `  delivery: ${envelope.delivery_id}`
    );
    return { ok: true, provider_message_id: `shadow-${envelope.delivery_id}`, shadow: true, bytes };
  }

  const cmd = new SendEmailCommand({
    Source: bridgeConfig.emailFrom,
    Destination: { ToAddresses: [bridgeConfig.emailTo] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: { Text: { Data: body, Charset: 'UTF-8' } },
    },
  });

  const result = await ses.send(cmd);
  const messageId = result.MessageId || null;

  console.log(
    `[Bridge] SES sent: ${envelope.event_count} event(s), ` +
    `${bytes} bytes, delivery=${envelope.delivery_id}, ses_id=${messageId}`
  );

  return { ok: true, provider_message_id: messageId, shadow: false, bytes };
}

module.exports = { sendBatch };
