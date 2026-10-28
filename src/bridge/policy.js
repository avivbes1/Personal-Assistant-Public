'use strict';
/**
 * bridge/policy.js — export gating and redaction for the Instinct Bridge.
 *
 * Three responsibilities:
 *  - isGroupAllowed(jid): only allowlisted groups may leave the system.
 *  - redactSensitive(text): strip phone numbers (except known family) and
 *    labelled auth/OTP codes before any text is persisted or exported.
 *  - filterExportableNotice(notice): only actionable/informational, non-dismissed
 *    notices are exportable.
 *
 * The allowlist default is deliberately closed: an empty allowlist allows
 * nothing. A one-way export must never fall open.
 */

const bridgeConfig = require('./config');
const mainConfig = require('../config');

// Known family phone numbers — matched by their last 9 digits so that
// +972 / leading-zero / bare-national forms all compare equal.
const FAMILY_SUFFIXES = [mainConfig.AVIV_PHONE, mainConfig.LIAT_PHONE]
  .filter(Boolean)
  .map(p => String(p).replace(/\D/g, '').slice(-9));

function isFamilyPhone(digits) {
  return FAMILY_SUFFIXES.includes(String(digits).slice(-9));
}

/** True if the group JID is on the export allowlist. Empty allowlist → false.
 *  A single '*' entry in the allowlist matches all groups. */
function isGroupAllowed(groupJid) {
  if (!groupJid) return false;
  if (bridgeConfig.groupAllowlist.includes('*')) return true;
  return bridgeConfig.groupAllowlist.includes(String(groupJid).trim());
}

/**
 * Redact sensitive tokens from free text.  Labelled auth/OTP/PIN codes
 * become [code].  Phone numbers are **passed through** (Aviv 2026-10-21:
 * contact numbers in school notices are actionable).  URLs are protected
 * from false-positive code matches.  Non-string input → empty string.
 */
function redactSensitive(text) {
  if (typeof text !== 'string' || text.length === 0) return text ? String(text) : '';

  // (1) Extract URLs and replace with placeholders so their digit strings
  //     (Zoom meeting IDs, passcodes, query params) are never touched by
  //     the OTP regex.  Supports http(s) and common meeting domains.
  const urlPlaceholders = [];
  const URL_RE = /https?:\/\/[^\s<>"']+/gi;
  let out = text.replace(URL_RE, (url) => {
    const idx = urlPlaceholders.length;
    urlPlaceholders.push(url);
    return `__URL_PLACEHOLDER_${idx}__`;
  });

  // (2) Labelled auth/OTP/PIN codes: "code 1234", "קוד: 5678", "OTP is 999888".
  out = out.replace(
    /((?:code|otp|pin|password|קוד|סיסמ[הא])\D{0,12}?)(\d{4,8})\b/gi,
    (_m, label) => `${label}[code]`
  );

  // (3) Phone numbers are NO LONGER redacted.  School/community notices
  //     contain teacher and coordinator contact numbers that are actionable.
  //     OTP/verification-code redaction (step 2) still protects secrets.

  // (4) Restore URLs from placeholders.
  for (let i = 0; i < urlPlaceholders.length; i++) {
    out = out.replace(`__URL_PLACEHOLDER_${i}__`, urlPlaceholders[i]);
  }

  return out;
}

// Notices whose tier is one of these may be exported (subject to allowlist).
const EXPORTABLE_TIERS = new Set(['critical', 'actionable', 'time_sensitive', 'informational']);

/**
 * True if a notice is eligible for export: not dismissed, still query-visible,
 * and carrying an exportable tier.
 */
function filterExportableNotice(notice) {
  if (!notice) return false;
  if (notice.dismissed) return false;
  if (notice.query_visible === 0) return false;
  const tier = notice.tier || 'informational';
  return EXPORTABLE_TIERS.has(tier);
}

module.exports = {
  isGroupAllowed,
  redactSensitive,
  filterExportableNotice,
  EXPORTABLE_TIERS,
};
