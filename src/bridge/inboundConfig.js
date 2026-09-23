'use strict';
/**
 * bridge/inboundConfig.js — configuration for the Instinct Bridge inbound
 * command channel.
 *
 * Reads all INSTINCT_BRIDGE_INBOUND_* environment variables once at load time
 * and exposes a frozen config object. The inbound channel is OFF by default
 * (INSTINCT_BRIDGE_INBOUND_ENABLED='0').
 *
 * P-026: this module is purely additive. It never throws on load — a
 * misconfiguration surfaces as `enabled: true, valid: false` with a logged
 * reason, so the poller can decline to run instead of crashing the core
 * process.
 */

function intOr(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const enabled = process.env.INSTINCT_BRIDGE_INBOUND_ENABLED === '1';
const token = process.env.INSTINCT_BRIDGE_INBOUND_TOKEN || '';
const account = process.env.INSTINCT_BRIDGE_INBOUND_ACCOUNT || '';
const replyTo = process.env.INSTINCT_BRIDGE_INBOUND_REPLY_TO || '';

// Validate required fields — but only enforce when the channel is enabled.
const errors = [];
if (enabled && !token) {
  errors.push('INSTINCT_BRIDGE_INBOUND_TOKEN is required when the inbound channel is enabled');
}
if (enabled && !account) {
  errors.push('INSTINCT_BRIDGE_INBOUND_ACCOUNT is required when the inbound channel is enabled');
}
if (enabled && !replyTo) {
  errors.push('INSTINCT_BRIDGE_INBOUND_REPLY_TO is required when the inbound channel is enabled');
}
if (enabled && errors.length > 0) {
  console.error('[Bridge][Inbound] config invalid — inbound poller will not run:');
  for (const e of errors) console.error(`  - ${e}`);
}

const config = {
  enabled,
  // valid reflects whether an enabled channel is fully configured. The poller
  // treats `enabled && valid` as the effective on-switch.
  valid: !enabled || errors.length === 0,
  errors: Object.freeze(errors.slice()),

  // Shared secret that must appear as `AUTH:<token>` on its own line in every
  // inbound command email. Also echoed back in replies.
  token,

  pollMs: intOr(process.env.INSTINCT_BRIDGE_INBOUND_POLL_MS, 120000),

  // Gmail account we poll (IMAP read + SMTP send, both via the app password
  // shared with the outbound bridge: INSTINCT_BRIDGE_GMAIL_APP_PASSWORD).
  account,

  // Where replies are sent, and the subject prefixes on each leg.
  replyTo,
  inboundSubjectPrefix: process.env.INSTINCT_BRIDGE_INBOUND_SUBJECT_PREFIX || '[Instinct->FamilyBot]',
  replySubjectPrefix: process.env.INSTINCT_BRIDGE_INBOUND_REPLY_PREFIX || '[FamilyBot->Instinct]',
};

module.exports = Object.freeze(config);
