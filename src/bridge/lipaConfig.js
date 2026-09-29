'use strict';
/**
 * bridge/lipaConfig.js — Configuration for the Lipa lane of the Instinct Bridge.
 *
 * Separate token and subject prefixes from the Tudat lane.
 * Reuses the same Gmail account and app password.
 */

const enabled = process.env.LIPA_BRIDGE_ENABLED === '1';
const token = process.env.LIPA_BRIDGE_TOKEN || '';
const account = process.env.INSTINCT_BRIDGE_INBOUND_ACCOUNT || '';
const replyTo = process.env.INSTINCT_BRIDGE_INBOUND_REPLY_TO || '';

const errors = [];
if (enabled && !token) errors.push('LIPA_BRIDGE_TOKEN is required');
if (enabled && !account) errors.push('INSTINCT_BRIDGE_INBOUND_ACCOUNT is required');
if (enabled && !replyTo) errors.push('INSTINCT_BRIDGE_INBOUND_REPLY_TO is required');

if (enabled && errors.length > 0) {
  console.error('[Bridge][Lipa] config invalid:');
  for (const e of errors) console.error(`  - ${e}`);
}

const config = {
  enabled,
  valid: !enabled || errors.length === 0,
  errors: Object.freeze(errors.slice()),
  token,
  account,
  replyTo,
  inboundSubjectPrefix: '[Instinct->Lipa]',
  replySubjectPrefix: '[Lipa->Instinct]',
};

module.exports = Object.freeze(config);
