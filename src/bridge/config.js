'use strict';
/**
 * bridge/config.js — Instinct Bridge configuration.
 *
 * Reads all INSTINCT_BRIDGE_* environment variables once at load time and
 * exposes a frozen config object. The bridge is OFF by default
 * (INSTINCT_BRIDGE_ENABLED='0'); nothing exports until it is explicitly enabled
 * and the required delivery fields are present.
 *
 * P-026: this module is purely additive. It never throws on load — a
 * misconfiguration surfaces as `enabled: true, valid: false` with a logged
 * reason, so it can degrade instead of crashing the core process.
 */

const MAIN_TZ = process.env.TIMEZONE || 'UTC';

function csv(value) {
  return (value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function intOr(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const enabled = process.env.INSTINCT_BRIDGE_ENABLED === '1';

const groupAllowlist = csv(process.env.INSTINCT_BRIDGE_GROUP_ALLOWLIST);
const emailTo = process.env.INSTINCT_BRIDGE_EMAIL_TO || '';
const emailFrom = process.env.INSTINCT_BRIDGE_EMAIL_FROM || '';

// Validate required delivery fields — but only enforce when the bridge is on.
const errors = [];
if (enabled) {
  if (!emailTo) errors.push('INSTINCT_BRIDGE_EMAIL_TO is required when the bridge is enabled');
  if (!emailFrom) errors.push('INSTINCT_BRIDGE_EMAIL_FROM is required when the bridge is enabled');
  if (groupAllowlist.length === 0) {
    errors.push('INSTINCT_BRIDGE_GROUP_ALLOWLIST is empty — nothing will ever be exported');
  }
  if (errors.length > 0) {
    console.error('[Bridge] config invalid — bridge will not export:');
    for (const e of errors) console.error(`  - ${e}`);
  }
}

const config = {
  enabled,
  // valid reflects whether an enabled bridge is fully configured. The exporter
  // treats `enabled && valid` as the effective on-switch.
  valid: !enabled || errors.length === 0,
  errors: Object.freeze(errors.slice()),

  groupAllowlist: Object.freeze(groupAllowlist),

  emailTo,
  emailFrom,
  subjectPrefix: process.env.INSTINCT_BRIDGE_SUBJECT_PREFIX || '[FamilyBot→Instinct]',

  stream: process.env.INSTINCT_BRIDGE_STREAM || 'family-notices',
  batchSize: intOr(process.env.INSTINCT_BRIDGE_BATCH_SIZE, 50),
  maxAttempts: intOr(process.env.INSTINCT_BRIDGE_MAX_ATTEMPTS, 8),
  backoffBaseMs: intOr(process.env.INSTINCT_BRIDGE_BACKOFF_BASE_MS, 60000),

  timezone: MAIN_TZ,
};

module.exports = Object.freeze(config);
