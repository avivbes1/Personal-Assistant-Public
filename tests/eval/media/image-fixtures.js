#!/usr/bin/env node
/**
 * image-fixtures.js — Vision + OCR extraction fixtures for archived images (C4).
 *
 * A standalone DIAGNOSTIC (not a CI test — it needs ANTHROPIC_API_KEY and the
 * archived image files). It runs the SAME image extraction chain production uses
 * — media-parser.extractFromMedia(buffer, mime, 'image', …), i.e. Claude Sonnet
 * vision with a Tesseract Hebrew OCR fallback — against a fixed set of ~30
 * archived images and checks that the salient Hebrew content still comes through.
 *
 * ── The fixtures ──────────────────────────────────────────────────────────────
 * tests/eval/media/image-fixtures.json holds, per image:
 *   { id, path, group_id, category, anchors:[…hebrew…], min_anchors }
 * The anchors are DISTINCTIVE Hebrew strings that should appear in a correct
 * extraction. They are seeded from the extraction production already stored for
 * that image in the messages table (the best available ground truth), biased
 * toward low-frequency tokens, dates and times — the parts that are stable across
 * vision re-runs. A fixture PASSES when ≥ min_anchors of its anchors appear in the
 * fresh extraction (substring match, whitespace-normalized). That tolerance is
 * deliberate: vision rephrases prose run-to-run, so we assert on salient content,
 * not verbatim text. A total extraction failure (bare "[תמונה]") fails every
 * anchor and is caught.
 *
 * The 30 images are chosen to span the diversity of the archive: text-rich school
 * notices, flyers/schedules, screenshots, and generic photos ("photos of
 * nothing", where the anchors are the distinctive nouns vision names).
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   node tests/eval/media/image-fixtures.js               # run the fixtures live
 *   node tests/eval/media/image-fixtures.js --build       # (re)generate the JSON
 *   node tests/eval/media/image-fixtures.js --build --count 30 [--db PATH]
 *   node tests/eval/media/image-fixtures.js --limit N     # run only first N (quick)
 *
 * --build reads the DB (readonly) and rewrites image-fixtures.json; it makes no
 * API calls. The default (run) mode makes one vision call per fixture.
 *
 * Results are written to tests/eval/media/image-fixtures-results.json.
 * Exit code: 0 if overall pass-rate ≥ --threshold (default 0.7), else 1.
 */

'use strict';

const path = require('path');
const fs = require('fs');

// Load .env before requiring src/ (media-parser captures ANTHROPIC_API_KEY at load).
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });
} catch (_) { /* fine — --build needs no key */ }

const FIXTURES_PATH = path.join(__dirname, 'image-fixtures.json');
const RESULTS_PATH = path.join(__dirname, 'image-fixtures-results.json');

// ── Anchor extraction (build mode) ─────────────────────────────────────────────

// Generic descriptor words vision reaches for constantly — useless as anchors
// because they appear in nearly every description.
const STOPWORDS = new Set([
  'תמונה', 'תמונת', 'של', 'על', 'את', 'עם', 'זה', 'זהו', 'זאת', 'הוא', 'היא',
  'רקע', 'צבעוני', 'צבעונית', 'צבעים', 'מראה', 'רואים', 'נראה', 'נראית', 'יש',
  'הטקסט', 'טקסט', 'כתוב', 'מופיע', 'מוצג', 'מציג', 'מציגה', 'כולל', 'כוללת',
  'אשר', 'הזה', 'הזאת', 'וכן', 'אלא', 'אבל', 'לכל', 'כמו', 'בין', 'לפי', 'עוד',
  'שהיא', 'שהוא', 'שבו', 'בתוך', 'מתוך', 'ליד', 'בצד', 'למעלה', 'למטה',
]);

/** Strip markdown/punctuation and split into candidate tokens. */
function tokenize(text) {
  return String(text || '')
    .replace(/[#*_>`~|\[\]()"׳״'".,;:!?/\\]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

const HEB = /[֐-׿]/;
const HAS_DIGIT = /\d/;

/** Is this token a good anchor candidate? */
function isAnchor(tok) {
  if (HAS_DIGIT.test(tok)) return tok.length >= 2;      // dates/times/years: 7:45, 30/8, 2026
  if (!HEB.test(tok)) return false;                       // must be Hebrew otherwise
  if (tok.length < 4) return false;                       // too short → noisy
  // Strip a leading Hebrew conjunction/preposition letter (ו/ב/ל/ה/כ/מ/ש) for the stopword check.
  const bare = tok.replace(/^[ובלהכמש]/, '');
  if (STOPWORDS.has(tok) || STOPWORDS.has(bare)) return false;
  return true;
}

/** Extraction body → inner text (drops the "[label: …]" wrapper). */
function innerText(body) {
  return String(body || '').replace(/^\[[^:\]]*:?\s*/, '').replace(/\]\s*$/, '').trim();
}

/** Length-based diversity bucket. */
function categorize(inner) {
  const hasStructure = /#{1,}|טבלה|לוח|אסיפה|הזמנה|הודעה/.test(inner);
  const dateCount = (inner.match(/\d{1,2}[/.]\d{1,2}|\d{1,2}:\d{2}/g) || []).length;
  if (inner.length >= 350 || (hasStructure && dateCount >= 1)) return 'notice';
  if (inner.length >= 120) return 'flyer';
  return 'photo';
}

/**
 * Build the fixtures manifest from the DB. Seeds anchors from each image's
 * stored extraction, preferring low document-frequency (distinctive) tokens.
 */
function build(args) {
  const dbPath = args.db || process.env.FAMILYBOT_DB_PATH
    || path.join(__dirname, '..', '..', '..', 'data', 'family.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`[fixtures] DB not found: ${dbPath}`);
    process.exit(2);
  }
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });

  const rows = db.prepare(
    `SELECT id, group_id, media_path, body
       FROM messages
      WHERE media_type='image' AND media_path IS NOT NULL AND body IS NOT NULL
      ORDER BY id`
  ).all().filter((r) => fs.existsSync(r.media_path) && innerText(r.body).length > 0);

  // Corpus-wide document frequency, so we can prefer distinctive tokens.
  const df = new Map();
  const perRowTokens = new Map();
  for (const r of rows) {
    const toks = new Set(tokenize(innerText(r.body)).filter(isAnchor));
    perRowTokens.set(r.id, toks);
    for (const t of toks) df.set(t, (df.get(t) || 0) + 1);
  }

  const candidates = rows.map((r) => {
    const inner = innerText(r.body);
    const toks = [...perRowTokens.get(r.id)];
    // Rank: rarer first; ties broken by longer (more specific) tokens.
    toks.sort((a, b) => (df.get(a) - df.get(b)) || (b.length - a.length));
    const anchors = toks.slice(0, 6);
    return {
      id: r.id,
      path: r.media_path,
      group_id: r.group_id,
      category: categorize(inner),
      anchors,
      // Need ≥2 anchors (or all of them, if fewer) to call it a pass.
      min_anchors: Math.min(2, anchors.length),
    };
  }).filter((c) => c.anchors.length >= 2); // an image we can't anchor is useless as a fixture

  // Diversity-first selection: take everything from the rarer buckets, fill the
  // rest from 'flyer', spreading across groups for variety.
  const want = args.count || 30;
  const byCat = { photo: [], flyer: [], notice: [] };
  for (const c of candidates) (byCat[c.category] || byCat.flyer).push(c);

  const picked = [];
  const seenGroups = new Set();
  // Prefer one-per-group first across all buckets for spread…
  for (const cat of ['notice', 'photo', 'flyer']) {
    for (const c of byCat[cat]) {
      if (picked.length >= want) break;
      if (seenGroups.has(c.group_id)) continue;
      picked.push(c); seenGroups.add(c.group_id);
    }
  }
  // …then fill remaining slots, rarer buckets first.
  for (const cat of ['notice', 'photo', 'flyer']) {
    for (const c of byCat[cat]) {
      if (picked.length >= want) break;
      if (picked.includes(c)) continue;
      picked.push(c);
    }
  }
  picked.sort((a, b) => a.id - b.id);

  const manifest = {
    generated_at: new Date().toISOString(),
    source_db: dbPath,
    note: 'Anchors seeded from stored production extractions (biased to distinctive/low-frequency tokens). Regenerate with --build.',
    count: picked.length,
    by_category: picked.reduce((m, c) => ((m[c.category] = (m[c.category] || 0) + 1), m), {}),
    fixtures: picked,
  };
  fs.writeFileSync(FIXTURES_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[fixtures] Wrote ${picked.length} fixtures → ${path.relative(process.cwd(), FIXTURES_PATH)}`);
  console.log(`[fixtures] by category: ${JSON.stringify(manifest.by_category)}`);
  console.log(`[fixtures] Now run:  node ${path.relative(process.cwd(), __filename)}`);
}

// ── Run mode ────────────────────────────────────────────────────────────────

const MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function run(args) {
  if (!fs.existsSync(FIXTURES_PATH)) {
    console.error(`[fixtures] No manifest at ${FIXTURES_PATH}. Generate it first: --build`);
    process.exit(2);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[fixtures] ANTHROPIC_API_KEY not set — the vision chain needs it. Aborting.');
    process.exit(2);
  }

  const manifest = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));
  let fixtures = manifest.fixtures || [];
  if (args.limit) fixtures = fixtures.slice(0, args.limit);

  const { extractFromMedia } = require('../../../src/media-parser');

  console.log(`[fixtures] Running vision+OCR chain on ${fixtures.length} image(s)…\n`);

  const results = [];
  let passed = 0, missingFile = 0, errored = 0;

  for (let i = 0; i < fixtures.length; i++) {
    const fx = fixtures[i];
    const label = `#${fx.id} [${fx.category}]`;

    if (!fs.existsSync(fx.path)) {
      missingFile++;
      results.push({ ...fx, status: 'missing_file', matched: [], extraction: null });
      console.log(`  ${label} SKIP (file missing: ${fx.path})`);
      continue;
    }

    let extraction = null, error = null;
    try {
      const buffer = fs.readFileSync(fx.path);
      const ext = path.extname(fx.path).slice(1).toLowerCase();
      const mime = MIME_BY_EXT[ext] || 'image/jpeg';
      extraction = await extractFromMedia(buffer, mime, 'image', null, fx.group_id);
    } catch (e) {
      error = e.message;
      errored++;
    }

    const hay = norm(extraction);
    const matched = (fx.anchors || []).filter((a) => hay.includes(norm(a)));
    const pass = !error && matched.length >= (fx.min_anchors || 1);
    if (pass) passed++;

    results.push({
      id: fx.id, path: fx.path, group_id: fx.group_id, category: fx.category,
      anchors: fx.anchors, min_anchors: fx.min_anchors,
      matched, matched_count: matched.length,
      pass, error,
      extraction: extraction ? extraction.slice(0, 200) : null,
    });

    console.log(`  ${label} ${pass ? 'PASS' : (error ? 'ERROR' : 'FAIL')}` +
      ` — ${matched.length}/${fx.anchors.length} anchors (need ${fx.min_anchors})` +
      (error ? ` — ${error}` : '') +
      (!pass && !error ? `  missed: ${fx.anchors.filter((a) => !matched.includes(a)).join(', ')}` : ''));

    // Gentle pacing — one vision call in flight at a time.
    await new Promise((r) => setTimeout(r, 300));
  }

  const evaluable = results.length - missingFile;
  const passRate = evaluable ? passed / evaluable : 0;

  const summary = {
    generated_at: new Date().toISOString(),
    fixtures: fixtures.length,
    evaluable,
    passed,
    failed: evaluable - passed,
    errored,
    missing_file: missingFile,
    pass_rate: passRate,
    by_category: results.reduce((m, r) => {
      const c = r.category || 'unknown';
      m[c] = m[c] || { total: 0, passed: 0 };
      if (r.status !== 'missing_file') { m[c].total++; if (r.pass) m[c].passed++; }
      return m;
    }, {}),
    results,
  };
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(summary, null, 2) + '\n');

  console.log('\n' + '='.repeat(60));
  console.log(`[fixtures] ${passed}/${evaluable} passed  (${(passRate * 100).toFixed(1)}%)` +
    (missingFile ? `, ${missingFile} missing file(s)` : '') + (errored ? `, ${errored} error(s)` : ''));
  console.log('[fixtures] by category:');
  for (const [cat, s] of Object.entries(summary.by_category)) {
    console.log(`  ${cat.padEnd(8)} ${s.passed}/${s.total}`);
  }
  console.log(`[fixtures] Results → ${path.relative(process.cwd(), RESULTS_PATH)}`);

  const threshold = args.threshold ?? 0.7;
  process.exit(passRate >= threshold ? 0 : 1);
}

// ── Main ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { build: false, count: 30, limit: null, db: null, threshold: 0.7 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--build') args.build = true;
    else if (a === '--count') args.count = parseInt(argv[++i], 10);
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--threshold') args.threshold = parseFloat(argv[++i]);
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node tests/eval/media/image-fixtures.js [--build [--count N] [--db PATH]] [--limit N] [--threshold F]');
      process.exit(0);
    } else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.build) build(args);
  else await run(args);
}

if (require.main === module) {
  main().catch((e) => { console.error('[fixtures] Fatal:', e); process.exit(2); });
}

module.exports = { tokenize, isAnchor, innerText, categorize };
