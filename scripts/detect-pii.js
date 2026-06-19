#!/usr/bin/env node
/**
 * detect-pii.js — Scan source files for hardcoded PII patterns.
 *
 * Usage:
 *   node scripts/detect-pii.js [target-dir]   # default: current directory
 *
 * Exit 0 = clean. Exit 1 = PII found.
 *
 * Add family-specific patterns to the CUSTOM_PATTERNS array below.
 */

const fs   = require('fs');
const path = require('path');

// ── PII patterns ─────────────────────────────────────────────────────────────

const PATTERNS = [
  // Phone numbers (Israeli only — +972 or 972 prefix)
  { name: 'Israeli phone (972...)',    re: /\+?972\d{8,10}/g },

  // Email addresses (excluding WhatsApp JIDs, example domains, and placeholder patterns)
  { name: 'Real email address',        re: /[a-zA-Z0-9._%+-]+@(?!example\.|c\.us|g\.us|s\.whatsapp\.net|YOUR_|yourname@|user@|parent[0-9]@)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },

  // API keys
  { name: 'Anthropic API key',         re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'OpenAI API key',            re: /sk-[A-Za-z0-9]{40,}/g },

  // ── Family-specific patterns (customize for your family) ─────────────────
  // Replace these with your own family name and member names
  { name: 'Family surname',            re: /besinsky|בסינסקי/gi },
  { name: 'Member first name (Hebrew)',re: /(?<![א-ת])(?:שגב|נבו|נטע|ירדן)(?![א-ת])/g },
  { name: 'Known email account',       re: /avivbes1|liat\.elm|liatb@/gi },
];

// ── Files & dirs to skip ──────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'data', 'backups', 'logs',
  'whatsapp-session', '.wwebjs_auth', '.wwebjs_cache',
]);

const SKIP_FILES = new Set([
  '.env', 'credentials.json', 'package-lock.json',
  'detect-pii.js', // skip self
]);

const SCAN_EXTENSIONS = new Set([
  '.js', '.json', '.ts', '.yaml', '.yml', '.txt', '.md', '.sh',
]);

// ── Scanner ───────────────────────────────────────────────────────────────────

function walk(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, results);
    else if (SCAN_EXTENSIONS.has(path.extname(entry.name)) && !SKIP_FILES.has(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function scanFile(filePath) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); }
  catch (_) { return []; }

  const findings = [];
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(content)) !== null) {
      // Get line number
      const lineNo = content.slice(0, match.index).split('\n').length;
      findings.push({ pattern: name, match: match[0], line: lineNo });
    }
  }
  return findings;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const files = walk(targetDir);

let totalFindings = 0;
const report = [];

for (const file of files) {
  const findings = scanFile(file);
  if (findings.length > 0) {
    const rel = path.relative(targetDir, file);
    report.push({ file: rel, findings });
    totalFindings += findings.length;
  }
}

if (totalFindings === 0) {
  console.log(`✅ PII scan clean — ${files.length} files checked, 0 findings.`);
  process.exit(0);
} else {
  console.error(`\n🚨 PII DETECTED — ${totalFindings} finding(s) in ${report.length} file(s):\n`);
  for (const { file, findings } of report) {
    console.error(`  ${file}:`);
    for (const f of findings) {
      console.error(`    Line ${f.line}: [${f.pattern}] "${f.match}"`);
    }
  }
  console.error('\nFix all findings before proceeding.\n');
  process.exit(1);
}
