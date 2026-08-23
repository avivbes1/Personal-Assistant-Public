/**
 * response-guard.js — Contradiction detector for outgoing LLM responses.
 *
 * Motivation (calendar permission hallucination incident):
 * The LLM falsely claimed it only had read-only calendar access and told the
 * user to "delete it manually". This guard flags such capability-denial /
 * contradiction phrasing so we can catch regressions.
 *
 * Currently LOG-ONLY — checkResponse never blocks; callers decide what to do.
 */

'use strict';

// Each pattern is a substring/regex we consider a capability contradiction.
// Hebrew + English. Order matters only for which pattern is reported first.
const CONTRADICTION_PATTERNS = [
  { label: 'readonly',            re: /read[\s-]?only/i },
  { label: 'readonly',            re: /readonly/i },
  { label: 'לקריאה בלבד',          re: /לקריאה בלבד/ },
  { label: 'אין לי הרשאות',        re: /אין לי הרשאות/ },
  { label: 'אין לי גישה',          re: /אין לי גישה/ },
  { label: 'אין לי אפשרות למחוק',   re: /אין לי (?:את ה)?אפשרות למחוק/ },
  { label: 'תמחק ידנית',           re: /תמחק(?:י)? (?:את זה )?ידנית/ },
  { label: 'תמחק ידנית',           re: /(?:צריך|תצטרך|עליך) למחוק (?:את זה )?ידנית/ },
  { label: "can't delete",        re: /can'?t delete/i },
  { label: 'cannot delete',       re: /cannot delete/i },
  { label: 'delete manually',     re: /delete (?:it |them )?manually/i },
];

/**
 * Check a response string for capability-contradiction phrasing.
 *
 * @param {string} responseText
 * @returns {{flagged: boolean, pattern: string}|null}
 *   - null when responseText is empty/invalid
 *   - { flagged: false, pattern: null } when clean
 *   - { flagged: true, pattern: '<label>' } when a contradiction is found
 */
function checkResponse(responseText) {
  if (!responseText || typeof responseText !== 'string') return null;
  for (const { label, re } of CONTRADICTION_PATTERNS) {
    if (re.test(responseText)) {
      return { flagged: true, pattern: label };
    }
  }
  return { flagged: false, pattern: null };
}

module.exports = { checkResponse, CONTRADICTION_PATTERNS };
