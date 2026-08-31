'use strict';
/**
 * Regression test: B1 / P-012 — Exactly one delivery path to the master group.
 *
 * Verifies that:
 *   1. deliver-batch.js and deliver-immediate.js are thin launchers that delegate
 *      to triage-engine.js via TRIAGE_MODE, and never send directly.
 *   2. noticeDelivery.js is a pure formatter — no voiceSend, no /send-message.
 *   3. triage-engine.js is the only file in src/ that both reads the notices
 *      queue AND sends to the master group.
 *   4. triage-engine.js supports TRIAGE_MODE=digest and TRIAGE_MODE=immediate.
 *   5. The formatter functions have correct signatures (notices, not sendFn).
 *
 * Source: WORKPLAN-V4.md B1, PRINCIPLES.md P-012, incident 2026-08-31.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const srcDir = path.join(ROOT, 'src');

function readFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

function run() {
  passed = 0; failed = 0;
  console.log('\n🔍 B1 / P-012: Single delivery path regression tests\n');

// ── 1. deliver-batch.js delegates via TRIAGE_MODE, never sends directly ──────
test('deliver-batch.js sets TRIAGE_MODE=digest', () => {
  const src = readFile('deliver-batch.js');
  assert(src.includes('TRIAGE_MODE'), 'deliver-batch.js must reference TRIAGE_MODE');
  assert(src.includes("'digest'") || src.includes('"digest"'),
    'deliver-batch.js must set TRIAGE_MODE to digest');
});

test('deliver-batch.js does not call voiceSend or POST /send-message', () => {
  const src = readFile('deliver-batch.js');
  // Strip comments before checking — the docstring legitimately mentions voiceSend
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert(!code.includes('voiceSend'), 'deliver-batch.js must not call voiceSend');
  assert(!code.includes('/send-message'), 'deliver-batch.js must not POST /send-message');
});

test('deliver-batch.js does not read the notices queue', () => {
  const src = readFile('deliver-batch.js');
  assert(!src.includes('FROM notices'), 'deliver-batch.js must not SELECT FROM notices');
  assert(!src.includes("delivery_status = 'pending'"),
    'deliver-batch.js must not query delivery_status=pending');
});

// ── 2. deliver-immediate.js delegates via TRIAGE_MODE, never sends directly ──
test('deliver-immediate.js sets TRIAGE_MODE=immediate', () => {
  const src = readFile('deliver-immediate.js');
  assert(src.includes('TRIAGE_MODE'), 'deliver-immediate.js must reference TRIAGE_MODE');
  assert(src.includes("'immediate'") || src.includes('"immediate"'),
    'deliver-immediate.js must set TRIAGE_MODE to immediate');
});

test('deliver-immediate.js does not call voiceSend or POST /send-message', () => {
  const src = readFile('deliver-immediate.js');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert(!code.includes('voiceSend'), 'deliver-immediate.js must not call voiceSend');
  assert(!code.includes('/send-message'), 'deliver-immediate.js must not POST /send-message');
});

// ── 3. noticeDelivery.js is a pure formatter — no sending ────────────────────
test('noticeDelivery.js does not call voiceSend', () => {
  const src = readFile('src/noticeDelivery.js');
  // Strip comments — the docstring legitimately documents that triage calls voiceSend
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert(!code.includes('voiceSend'),
    'noticeDelivery.js must not call voiceSend (P-012: it is a formatter)');
});

test('noticeDelivery.js does not POST /send-message', () => {
  const src = readFile('src/noticeDelivery.js');
  assert(!src.includes('/send-message'),
    'noticeDelivery.js must not POST /send-message');
});

// ── 4. Exactly one queue reader + sender in src/ ────────────────────────────
test('triage-engine.js is the only src/ file that reads queue AND sends', () => {
  const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.js'));
  const senders = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(srcDir, f), 'utf8');
    // Strip comments so docstrings don't trigger false positives
    const code = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const readsQueue =
      /FROM notices[\s\S]{0,400}?(posted_to_master\s*=\s*0|delivery_status\s*=\s*'pending')/i.test(code);
    const sends = /voiceSend|sendToMasterGroup/.test(code);
    if (readsQueue && sends) senders.push(f);
  }
  assert.deepStrictEqual(senders, ['triage-engine.js'],
    `Expected only [triage-engine.js] to read queue AND send; found [${senders.join(', ')}]`);
});

// ── 5. triage-engine.js exports and supports TRIAGE_MODE ─────────────────────
test('triage-engine.js exports runDigest', () => {
  const src = readFile('src/triage-engine.js');
  assert(src.includes('runDigest'), 'triage-engine.js must export runDigest');
});

test('triage-engine.js exports runImmediate', () => {
  const src = readFile('src/triage-engine.js');
  assert(src.includes('runImmediate'), 'triage-engine.js must export runImmediate');
});

test('triage-engine.js dispatches on TRIAGE_MODE env var', () => {
  const src = readFile('src/triage-engine.js');
  assert(src.includes('TRIAGE_MODE'), 'triage-engine.js must read TRIAGE_MODE');
  assert(src.includes("'digest'") || src.includes('"digest"'),
    'triage-engine.js must handle digest mode');
  assert(src.includes("'immediate'") || src.includes('"immediate"'),
    'triage-engine.js must handle immediate mode');
});

// ── 6. Digest drains 'defer', not 'pending' ─────────────────────────────────
test('runDigest reads triage_decision=defer, not the pending queue', () => {
  const src = readFile('src/triage-engine.js');
  // getDeferredNotices should query triage_decision = 'defer'
  assert(src.includes("triage_decision = 'defer'"),
    "getDeferredNotices must filter on triage_decision = 'defer'");
});

// ── 7. deliverBatch signature takes notices, not a sendFn ────────────────────
test('deliverBatch accepts (notices, opts), not a sendFn', () => {
  const src = readFile('src/noticeDelivery.js');
  // The function signature should have notices as first param
  const match = src.match(/async function deliverBatch\(([^)]*)\)/);
  assert(match, 'deliverBatch function must exist');
  const params = match[1];
  assert(params.includes('notices'), `deliverBatch first param should be 'notices', got '${params}'`);
  assert(!params.includes('sendFn') && !params.includes('send'),
    'deliverBatch must not accept a send function');
});

test('deliverImmediate accepts (notice), not a sendFn', () => {
  const src = readFile('src/noticeDelivery.js');
  const match = src.match(/function deliverImmediate\(([^)]*)\)/);
  assert(match, 'deliverImmediate function must exist');
  const params = match[1];
  assert(params.includes('notice'), `deliverImmediate param should be 'notice', got '${params}'`);
});

// ── 8. P-012 principle exists in PRINCIPLES.md ──────────────────────────────
test('P-012 exists in PRINCIPLES.md', () => {
  const src = readFile('PRINCIPLES.md');
  assert(src.includes('P-012'), 'PRINCIPLES.md must contain P-012');
  assert(src.includes('Exactly One Sender') || src.includes('single process') || src.includes('Exactly one process'),
    'P-012 must describe the single-sender rule');
});

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n─────────────────`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`─────────────────\n`);
  return { pass: failed === 0, message: `${passed} passed, ${failed} failed` };
}

// Conform to tests/run-all.js (which calls mod.run()) while staying runnable
// as a standalone script.
module.exports = { run };

if (require.main === module) {
  const r = run();
  if (!r.pass) process.exit(1);
}
