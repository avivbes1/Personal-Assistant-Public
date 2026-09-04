#!/usr/bin/env node
/**
 * measure-media-coverage.js — Media-extraction success-rate report (C4).
 *
 * A read-only diagnostic over the messages table. It answers: of every media
 * message we archived, for how many did the extraction chain actually produce
 * meaningful text — and which leg of the chain produced it?
 *
 * A body is "meaningful" when it carries extracted content beyond the bare
 * bracket label. These are treated as FAILURES (media arrived, nothing usable
 * came out):
 *   • empty / null body
 *   • a bare placeholder:        [תמונה]  [וידאו]  [הקלטה]
 *   • an explicit failure marker: [PDF ריק]  [PDF — לא הצלחתי לקרוא]  [Word ריק] …
 *
 * The producing leg is inferred from the body prefix that media-parser.js writes:
 *   [תמונה (OCR): …]  → ocr        (Tesseract Hebrew fallback)
 *   [תמונה: …]        → vision      (Claude Sonnet vision)
 *   [הקלטה: …]        → whisper     (ivrit.ai / Groq — indistinguishable here)
 *   [PDF: …]          → pdf-parse
 *   [Word: …]         → word (mammoth)
 *   [Excel: …]        → excel (xlsx)
 *   [Google Doc: …] … → url-fetch
 *   (non-bracket text)→ caption     (media with an accompanying text caption)
 *
 * Whisper's two backends (ivrit.ai vs Groq) both emit "[הקלטה: …]", so this
 * script can't split them from the body alone — see tests/eval/media/audio-wer.js
 * for the head-to-head, or cross-reference data/llm-trace* for call-site counts.
 *
 * Usage:
 *   node scripts/measure-media-coverage.js [--db PATH] [--json] [--show-failures N]
 *
 * Exit code is always 0 — this is a report, not a gate.
 */

'use strict';

const path = require('path');
const fs = require('fs');

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { db: null, json: false, showFailures: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') args.db = argv[++i];
    else if (a.startsWith('--db=')) args.db = a.split('=')[1];
    else if (a === '--json') args.json = true;
    else if (a === '--show-failures') args.showFailures = parseInt(argv[++i], 10) || 0;
    else if (a.startsWith('--show-failures=')) args.showFailures = parseInt(a.split('=')[1], 10) || 0;
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node scripts/measure-media-coverage.js [--db PATH] [--json] [--show-failures N]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

// ── Body classification ─────────────────────────────────────────────────────

// Bare placeholders / explicit failure markers media-parser.js can emit.
const FAILURE_BODIES = new Set([
  '[תמונה]', '[וידאו]', '[הקלטה]',
  '[PDF ריק]', '[PDF — לא הצלחתי לקרוא]',
  '[Word ריק]', '[Word — לא הצלחתי לקרוא]',
  '[Excel ריק]', '[Excel — לא הצלחתי לקרוא]',
]);

// Ordered prefix → leg. OCR before vision because both start with "[תמונה".
const LEG_PREFIXES = [
  ['[תמונה (OCR):', 'ocr'],
  ['[תמונה:', 'vision'],
  ['[הקלטה:', 'whisper'],
  ['[PDF:', 'pdf-parse'],
  ['[Word:', 'word'],
  ['[Excel:', 'excel'],
  ['[Google Doc:', 'url-fetch'],
  ['[Google Sheet:', 'url-fetch'],
  ['[Google Slides:', 'url-fetch'],
  ['[Google Drive file:', 'url-fetch'],
];

/**
 * Classify a stored body into { meaningful, leg }.
 * meaningful=false ⇒ nothing usable was extracted for this media message.
 */
function classifyBody(body) {
  const b = (body || '').trim();
  if (!b) return { meaningful: false, leg: 'none' };
  if (FAILURE_BODIES.has(b)) return { meaningful: false, leg: 'none' };

  for (const [prefix, leg] of LEG_PREFIXES) {
    if (b.startsWith(prefix)) {
      // Guard against a prefix with empty content, e.g. "[PDF: ]".
      const inner = b.slice(prefix.length).replace(/\]$/, '').trim();
      return { meaningful: inner.length > 0, leg };
    }
  }

  // Non-bracket, non-empty text: a media message that also carried a caption
  // (the caption is the body; extraction may have been merged or skipped).
  return { meaningful: true, leg: 'caption' };
}

// ── Report ────────────────────────────────────────────────────────────────────

function pct(n, d) {
  return d ? `${((n / d) * 100).toFixed(1)}%` : '—';
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const dbPath = args.db
    || process.env.FAMILYBOT_DB_PATH
    || path.join(__dirname, '..', 'data', 'family.db');

  if (!fs.existsSync(dbPath)) {
    console.error(`[coverage] DB not found: ${dbPath}`);
    process.exit(2);
  }

  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });

  const rows = db.prepare(
    `SELECT id, group_id, media_type, media_status, media_path, media_error, body
       FROM messages
      WHERE media_type IS NOT NULL`
  ).all();

  // Aggregate per media_type and per producing leg.
  const perType = {};   // type → { total, meaningful, archived, byLeg:{} }
  const perLeg = {};     // leg → count
  const failures = [];

  for (const r of rows) {
    const type = r.media_type || 'unknown';
    const { meaningful, leg } = classifyBody(r.body);

    if (!perType[type]) perType[type] = { total: 0, meaningful: 0, archived: 0, byLeg: {} };
    const t = perType[type];
    t.total++;
    if (meaningful) t.meaningful++;
    if (r.media_path && fs.existsSync(r.media_path)) t.archived++;
    t.byLeg[leg] = (t.byLeg[leg] || 0) + 1;
    perLeg[leg] = (perLeg[leg] || 0) + 1;

    if (!meaningful) {
      failures.push({
        id: r.id,
        group_id: r.group_id,
        media_type: type,
        media_status: r.media_status || null,
        media_error: r.media_error || null,
        body: (r.body || '').slice(0, 60),
        archived: !!(r.media_path && fs.existsSync(r.media_path)),
      });
    }
  }

  const totalMedia = rows.length;
  const totalMeaningful = rows.reduce((s, r) => s + (classifyBody(r.body).meaningful ? 1 : 0), 0);

  const report = {
    generated_at: new Date().toISOString(),
    db: dbPath,
    total_media_messages: totalMedia,
    meaningful: totalMeaningful,
    success_rate: totalMedia ? totalMeaningful / totalMedia : null,
    per_type: Object.fromEntries(
      Object.entries(perType).map(([type, s]) => [type, {
        total: s.total,
        meaningful: s.meaningful,
        success_rate: s.total ? s.meaningful / s.total : null,
        archived_files_present: s.archived,
        by_leg: s.byLeg,
      }])
    ),
    by_leg: perLeg,
    failure_count: failures.length,
  };

  if (args.json) {
    console.log(JSON.stringify({ ...report, failures: failures.slice(0, args.showFailures) }, null, 2));
    return;
  }

  // ── Human-readable ──
  console.log('='.repeat(66));
  console.log('MEDIA EXTRACTION COVERAGE');
  console.log('='.repeat(66));
  console.log(`DB: ${dbPath}`);
  console.log(`Media messages: ${totalMedia}`);
  console.log(`Meaningful extractions: ${totalMeaningful}  (${pct(totalMeaningful, totalMedia)})`);

  console.log('\nPer media_type (success = meaningful text extracted):');
  console.log('  ' + 'type'.padEnd(12) + 'total'.padStart(8) + 'ok'.padStart(8) + 'rate'.padStart(9) + 'archived'.padStart(10));
  for (const [type, s] of Object.entries(perType).sort((a, b) => b[1].total - a[1].total)) {
    console.log('  ' + type.padEnd(12) + String(s.total).padStart(8) + String(s.meaningful).padStart(8)
      + pct(s.meaningful, s.total).padStart(9) + String(s.archived).padStart(10));
  }

  console.log('\nWhich leg produced the answer:');
  for (const [leg, n] of Object.entries(perLeg).sort((a, b) => b[1] - a[1])) {
    console.log('  ' + leg.padEnd(12) + String(n).padStart(6) + `   (${pct(n, totalMedia)})`);
  }

  if (failures.length && args.showFailures) {
    console.log(`\n${failures.length} extraction failure(s) — first ${Math.min(args.showFailures, failures.length)}:`);
    for (const f of failures.slice(0, args.showFailures)) {
      console.log(`  #${f.id} [${f.media_type}] status=${f.media_status || '?'} archived=${f.archived}` +
        (f.media_error ? ` err="${f.media_error}"` : '') +
        (f.body ? ` body="${f.body}"` : ' body=<empty>'));
    }
  }

  console.log('\n(Note: whisper counts merge ivrit.ai + Groq — see tests/eval/media/audio-wer.js to split them.)');
}

if (require.main === module) main();

module.exports = { classifyBody };
