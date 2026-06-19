/**
 * family-profiles.js — Family member resolution for Besinsky Bot.
 * Maps names/nicknames to family member profiles stored in SQLite.
 */

const { getAllFamilyMembers, getFamilyMemberByNameExact } = require('./db');

/**
 * Try to resolve a text token to a family member.
 * Checks name_he, name_en, and nicknames (JSON array).
 * Case-insensitive. Returns first match or null.
 *
 * @param {string} text — a word or phrase to look up
 * @returns {object|null} family member row or null
 */
function resolveMember(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.trim();
  // Try exact lookup first (fast path)
  const exact = getFamilyMemberByNameExact(clean);
  if (exact) return exact;

  // Try case-insensitive partial: useful for "שגב׳ה" vs "שגב", or "Segev's"
  const lower = clean.toLowerCase().replace(/[׳'`'']/g, '');
  const all = getAllFamilyMembers();
  for (const m of all) {
    const heBase = (m.name_he || '').replace(/[׳'`'']/g, '');
    const enBase = (m.name_en || '').toLowerCase();
    if (heBase === clean || enBase === lower) return m;

    try {
      const nicknames = JSON.parse(m.nicknames || '[]');
      for (const n of nicknames) {
        if (n.toLowerCase().replace(/[׳'`'']/g, '') === lower) return m;
      }
    } catch (_) {}
  }
  return null;
}

/**
 * Scan a text string and return all family members mentioned in it.
 * Splits on spaces/punctuation and tries to resolve each token.
 * @param {string} text
 * @returns {Array} array of unique family member objects
 */
function resolveMembersInText(text) {
  if (!text) return [];
  // Split into word tokens
  const rawTokens = text.split(/[\s,.:;!?()]+/).filter(t => t.length >= 2);
  // Also try stripping leading Hebrew prefix letters (ו=and, ש=that, ב=in, כ=like, מ=from, ל=to)
  const tokens = new Set();
  for (const t of rawTokens) {
    tokens.add(t);
    if (/^[ושבכמל]/.test(t) && t.length >= 3) tokens.add(t.slice(1)); // strip one prefix
  }
  const seen = new Set();
  const results = [];
  for (const token of tokens) {
    const m = resolveMember(token);
    if (m && !seen.has(m.id)) {
      seen.add(m.id);
      results.push(m);
    }
  }
  return results;
}

/**
 * Return all family members.
 */
function getAllMembers() {
  return getAllFamilyMembers();
}

/**
 * Exact lookup by Hebrew or English name.
 */
function getMemberByName(name) {
  return getFamilyMemberByNameExact(name);
}

module.exports = { resolveMember, resolveMembersInText, getAllMembers, getMemberByName };
