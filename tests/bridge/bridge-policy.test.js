'use strict';
/**
 * bridge-policy.test.js — export gating and redaction.
 *
 * UC-1: allowlist accepts allowlisted JIDs and rejects everything else
 *       (including the closed-default empty case).
 * UC-2: redaction strips foreign phone numbers and labelled codes, but keeps
 *       known family numbers.
 * UC-3: notice filtering respects tier / dismissed / query_visible.
 *
 * The allowlist is frozen from env at load, so this test busts the require
 * cache for bridge/config + bridge/policy and reloads them with a known
 * allowlist — then restores the environment in finally.
 */

const mainConfig = require('../../src/config');

function freshPolicy() {
  delete require.cache[require.resolve('../../src/bridge/config')];
  delete require.cache[require.resolve('../../src/bridge/policy')];
  return require('../../src/bridge/policy');
}

module.exports = {
  async run() {
    const errors = [];
    const saved = {
      enabled: process.env.INSTINCT_BRIDGE_ENABLED,
      allow: process.env.INSTINCT_BRIDGE_GROUP_ALLOWLIST,
      to: process.env.INSTINCT_BRIDGE_EMAIL_TO,
      from: process.env.INSTINCT_BRIDGE_EMAIL_FROM,
    };

    try {
      // Configure a known allowlist and reload the frozen config + policy.
      process.env.INSTINCT_BRIDGE_ENABLED = '1';
      process.env.INSTINCT_BRIDGE_GROUP_ALLOWLIST = 'allowed-1@g.us, allowed-2@g.us';
      process.env.INSTINCT_BRIDGE_EMAIL_TO = 'instinct@example.com';
      process.env.INSTINCT_BRIDGE_EMAIL_FROM = 'familybot@example.com';
      const policy = freshPolicy();

      // ── UC-1: allowlist ────────────────────────────────────────────────────
      if (!policy.isGroupAllowed('allowed-1@g.us')) errors.push('UC-1: allowlisted JID rejected');
      if (!policy.isGroupAllowed(' allowed-2@g.us ')) errors.push('UC-1: whitespace-padded allowlisted JID rejected');
      if (policy.isGroupAllowed('not-allowed@g.us')) errors.push('UC-1: non-allowlisted JID accepted');
      if (policy.isGroupAllowed('')) errors.push('UC-1: empty JID accepted');
      if (policy.isGroupAllowed(null)) errors.push('UC-1: null JID accepted');

      // ── UC-2: redaction ────────────────────────────────────────────────────
      const fam = String(mainConfig.AVIV_PHONE);
      const keptFam = policy.redactSensitive(`אפשר להתקשר ל${fam} בבוקר`);
      if (!keptFam.includes(fam)) errors.push('UC-2: family phone was redacted (should be kept)');

      const foreign = policy.redactSensitive('call the office at 0521234567 today');
      if (foreign.includes('0521234567')) errors.push('UC-2: foreign phone not redacted');
      if (!foreign.includes('[phone]')) errors.push('UC-2: [phone] marker missing');

      const code = policy.redactSensitive('your verification code is 483920');
      if (code.includes('483920')) errors.push('UC-2: auth code not redacted');
      if (!code.includes('[code]')) errors.push('UC-2: [code] marker missing');

      const plain = policy.redactSensitive('נא להביא מים ומגבת');
      if (plain !== 'נא להביא מים ומגבת') errors.push('UC-2: plain text mutated by redaction');

      // ── UC-3: notice filtering ─────────────────────────────────────────────
      const cases = [
        [{ tier: 'informational', dismissed: 0 }, true, 'informational not dismissed'],
        [{ tier: 'actionable', dismissed: 0 }, true, 'actionable not dismissed'],
        [{ tier: 'critical', dismissed: 0 }, true, 'critical not dismissed'],
        [{ tier: 'informational', dismissed: 1 }, false, 'dismissed'],
        [{ tier: 'noise', dismissed: 0 }, false, 'unknown tier'],
        [{ tier: 'actionable', dismissed: 0, query_visible: 0 }, false, 'query_visible=0'],
        [null, false, 'null notice'],
      ];
      for (const [notice, expected, label] of cases) {
        if (policy.filterExportableNotice(notice) !== expected) {
          errors.push(`UC-3: filterExportableNotice wrong for "${label}" (expected ${expected})`);
        }
      }
    } finally {
      // Restore env and reload a clean (default) config/policy for later tests.
      for (const [k, envKey] of [
        ['enabled', 'INSTINCT_BRIDGE_ENABLED'],
        ['allow', 'INSTINCT_BRIDGE_GROUP_ALLOWLIST'],
        ['to', 'INSTINCT_BRIDGE_EMAIL_TO'],
        ['from', 'INSTINCT_BRIDGE_EMAIL_FROM'],
      ]) {
        if (saved[k] === undefined) delete process.env[envKey];
        else process.env[envKey] = saved[k];
      }
      freshPolicy();
    }

    return errors.length === 0
      ? { pass: true, message: 'Allowlist gating, redaction (phone/code/family), and notice filtering correct.' }
      : { pass: false, message: errors.join('\n         ') };
  },
};
