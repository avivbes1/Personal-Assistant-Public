#!/usr/bin/env node
/**
 * sanitize-commit-msg.js — Scrub PII from commit messages.
 *
 * Reads commit message text from stdin, replaces PII patterns with
 * safe placeholders, and writes the cleaned text to stdout.
 *
 * Uses the same pattern library as detect-pii.js.
 *
 * Usage:
 *   echo "fix: update besinsky config" | node scripts/sanitize-commit-msg.js
 *   git log --format='%s' | node scripts/sanitize-commit-msg.js
 */

// ── PII patterns (same as detect-pii.js) ────────────────────────────────────

const REPLACEMENTS = [
  { re: /\+?972\d{8,10}/g,                             sub: '[PHONE]' },
  { re: /[a-zA-Z0-9._%+-]+@(?!example\.|c\.us|g\.us|s\.whatsapp\.net|YOUR_|yourname@|user@|parent[0-9]@)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, sub: '[EMAIL]' },
  { re: /sk-ant-[A-Za-z0-9_-]{20,}/g,                  sub: '[API_KEY]' },
  { re: /sk-[A-Za-z0-9]{40,}/g,                        sub: '[API_KEY]' },
  { re: /besinsky|בסינסקי/gi,                           sub: '[FAMILY]' },
  { re: /(?<![א-ת])(?:שגב|נבו|נטע|ירדן)(?![א-ת])/g,   sub: '[NAME]' },
  { re: /avivbes1|liat\.elm|liatb@/gi,                  sub: '[ACCOUNT]' },
];

// ── Main ─────────────────────────────────────────────────────────────────────

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let output = input;
  for (const { re, sub } of REPLACEMENTS) {
    output = output.replace(re, sub);
  }
  process.stdout.write(output);
});
