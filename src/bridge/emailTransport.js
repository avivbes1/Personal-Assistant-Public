'use strict';
/**
 * bridge/emailTransport.js — delivery transport for the Instinct Bridge.
 *
 * SCAFFOLD / SHADOW MODE ONLY. This module does not send email yet — it logs
 * exactly what WOULD be sent (subject, recipient, event count, payload size)
 * and returns a synthetic success so the outbox lifecycle can be exercised
 * end-to-end before a real transport is wired in.
 *
 * TODO(bridge-M2): replace the shadow body with a real transport. Options:
 *   - nodemailer over SMTP (INSTINCT_BRIDGE_SMTP_* env vars), or
 *   - a provider HTTP API (SendGrid / SES / Postmark).
 *   No npm dependency is added yet — see package.json.
 */

const bridgeConfig = require('./config');

/**
 * "Send" a delivery envelope. In shadow mode this only logs and returns a
 * synthetic provider message id.
 * @param {object} envelope  built by envelope.buildEnvelope()
 * @returns {{ok: boolean, provider_message_id: string, shadow: boolean, bytes: number}}
 */
function sendBatch(envelope) {
  const subject = `${bridgeConfig.subjectPrefix} ${envelope.event_count} event(s) [${envelope.stream}]`;
  const payload = JSON.stringify(envelope);
  const bytes = Buffer.byteLength(payload, 'utf8');

  // TODO(bridge-M2): actually transmit `payload` to `bridgeConfig.emailTo`.
  console.log(
    `[Bridge][shadow] WOULD send email:\n` +
    `  to:       ${bridgeConfig.emailTo || '(unset)'}\n` +
    `  from:     ${bridgeConfig.emailFrom || '(unset)'}\n` +
    `  subject:  ${subject}\n` +
    `  events:   ${envelope.event_count}\n` +
    `  bytes:    ${bytes}\n` +
    `  delivery: ${envelope.delivery_id}`
  );

  return {
    ok: true,
    provider_message_id: `shadow-${envelope.delivery_id}`,
    shadow: true,
    bytes,
  };
}

module.exports = { sendBatch };
