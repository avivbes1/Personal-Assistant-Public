'use strict';
/**
 * check-principles.js — Pre-commit principle checker
 *
 * Verifies that code changes don't violate the architectural principles in
 * PRINCIPLES.md. Run before any commit:  node tests/check-principles.js
 *
 * Each check references a principle (P-001, P-009, P-012, ...). Checks are
 * defensive: a check whose target file is absent from this working copy
 * (some operational scripts ship only on the production box) is SKIPPED, not
 * failed, so the checker is meaningful on partial checkouts too.
 *
 * Exit code is non-zero if any check FAILS. Skipped checks never fail the run.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0, skipped = 0;

// A check fn returns: (see runChecks below)
//   true / undefined  → pass
//   a string          → fail, with the string as the reason
//   { skip: reason }  → skip (e.g. target file not present in this checkout)
function check(principle, name, fn) {
  try {
    const result = fn();
    if (result && typeof result === 'object' && result.skip) {
      console.log(`  –  [${principle}] ${name}  (skipped: ${result.skip})`);
      skipped++;
    } else if (result === true || result === undefined) {
      console.log(`  ✅ [${principle}] ${name}`);
      passed++;
    } else {
      console.error(`  ❌ [${principle}] ${name}`);
      console.error(`       ${result}`);
      failed++;
    }
  } catch (e) {
    console.error(`  ❌ [${principle}] ${name}`);
    console.error(`       Error: ${e.message}`);
    failed++;
  }
}

// Read a repo-relative file, or return null if it isn't present in this checkout.
function readSrc(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function crontab() {
  try { return execSync('crontab -l 2>/dev/null').toString(); } catch (_) { return ''; }
}

// Strip comments so content checks match real CODE, not prose. A docstring that
// says "calls voiceSend" must not read as a send call.
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // /* block */ and /** jsdoc */
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');  // // line comments (keep http:// intact)
}

function runChecks() {
  passed = 0; failed = 0; skipped = 0;
  console.log('\n🔍 Checking architectural principles...\n');

// ── P-001 — Single Actor for Notices ─────────────────────────────────────────
check('P-001', 'send-unposted-notices.js is not in crontab', () => {
  if (crontab().includes('send-unposted-notices')) {
    return 'send-unposted-notices.js found in crontab — violates single-actor principle. Remove it.';
  }
});

check('P-001', 'triage-engine.js claims notices before LLM calls (send_attempted_at)', () => {
  const src = readSrc('src/triage-engine.js');
  if (src === null) return { skip: 'src/triage-engine.js not present' };
  if (!src.includes('send_attempted_at')) {
    return 'triage-engine.js must set send_attempted_at before LLM calls to prevent concurrent-run races.';
  }
});

// ── P-007 — Validate External Output Before State Commit ─────────────────────
check('P-007', 'groupByMergeGroup logs the missing-merge_group bug (no silent continue)', () => {
  const src = readSrc('src/triage-engine.js');
  if (src === null) return { skip: 'src/triage-engine.js not present' };
  if (!/BUG: send_now/.test(src)) {
    return 'triage-engine.js must log "BUG: send_now/send_update without merge_group" instead of silently continuing.';
  }
});

check('P-007', 'normalizeDecisions runs before markNoticesTriaged', () => {
  const src = readSrc('src/triage-engine.js');
  if (src === null) return { skip: 'src/triage-engine.js not present' };
  const iNorm = src.indexOf('normalizeDecisions(allDecisions');
  const iMark = src.indexOf('markNoticesTriaged(db, normalizedDecisions');
  if (iNorm < 0 || iMark < 0 || iNorm > iMark) {
    return 'normalizeDecisions(...) must be called before markNoticesTriaged(...) in runTriage.';
  }
});

// ── P-009 — Notice State Coherence ───────────────────────────────────────────
check('P-009', "skip decisions set delivery_status='skipped' in triage-engine.js", () => {
  const src = readSrc('src/triage-engine.js');
  if (src === null) return { skip: 'src/triage-engine.js not present' };
  const n = (src.match(/delivery_status[^\n]*skipped/g) || []).length;
  if (n < 3) return `expected >=3 delivery_status='skipped' sites, found ${n}.`;
});

check('P-009', 'noticeDelivery.getPendingNotices filters triage_decision', () => {
  const src = readSrc('src/noticeDelivery.js');
  if (src === null) return { skip: 'src/noticeDelivery.js not present' };
  const m = src.match(/function getPendingNotices[\s\S]{0,600}/);
  if (!m || !/triage_decision NOT IN/.test(m[0])) {
    return "getPendingNotices must filter triage_decision NOT IN ('skip','defer').";
  }
});

check('P-009', 'noticeDelivery keeps the cluster gate', () => {
  const src = readSrc('src/noticeDelivery.js');
  if (src === null) return { skip: 'src/noticeDelivery.js not present' };
  if (!src.includes('Cluster gate')) return 'noticeDelivery.js must keep the P-009 cluster gate.';
});

// ── P-011 — No Silent Fall-Through in Master-Group Handlers ───────────────────
check('P-011', 'unmatched master-group quoted reply is logged + alerted', () => {
  const src = readSrc('src/whatsapp.js');
  if (src === null) return { skip: 'src/whatsapp.js not present' };
  if (!src.includes('Quoted reply matched no handler')) {
    return 'whatsapp.js must warn "Quoted reply matched no handler" before falling through.';
  }
  if (!/alertUnmatchedReply|_unmatchedReplyAlertAt/.test(src)) {
    return 'whatsapp.js must have the rate-limited unmatched-reply DM alert.';
  }
});

// ── P-012 — Exactly One Sender for the Master Group ──────────────────────────
check('P-012', 'exactly one queue reader in src/ also sends (triage-engine.js only)', () => {
  const srcDir = path.join(ROOT, 'src');
  if (!fs.existsSync(srcDir)) return { skip: 'src/ not present' };
  const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.js'));
  const senders = [];
  for (const f of files) {
    const content = codeOnly(fs.readFileSync(path.join(srcDir, f), 'utf8'));
    // A queue READER runs a SELECT ... FROM notices filtered on the unsent queue
    // (posted_to_master=0 or delivery_status='pending'). This excludes files that
    // merely UPDATE notices (e.g. whatsapp.js marking a dismissal) or send
    // interactive command replies — those are the P-010 handler, not a deliverer.
    const readsQueue = /FROM notices[\s\S]{0,400}?(posted_to_master\s*=\s*0|delivery_status\s*=\s*'pending')/i.test(content);
    // A SENDER actually CALLS voiceSend(...) or sendToMasterGroup(...) — a mention
    // in prose is not a send.
    const sends = /\bvoiceSend\s*\(|\bsendToMasterGroup\s*\(/.test(content);
    if (readsQueue && sends) senders.push(f);
  }
  if (senders.length !== 1 || senders[0] !== 'triage-engine.js') {
    return `expected exactly [triage-engine.js] to read the queue AND send; found [${senders.join(', ')}].`;
  }
});

check('P-012', 'delivery launchers delegate to triage and never send directly', () => {
  for (const f of ['deliver-batch.js', 'deliver-immediate.js']) {
    const raw = readSrc(f);
    if (raw === null) return { skip: `${f} not present` };
    if (!raw.includes('TRIAGE_MODE')) {
      return `${f} must delegate to triage via TRIAGE_MODE, not read/send on its own.`;
    }
    const src = codeOnly(raw);
    if (/\bvoiceSend\s*\(/.test(src) || /['"`]\/send-message['"`]/.test(src)) {
      return `${f} must not call voiceSend or POST /send-message — it is a launcher, not a sender (P-012).`;
    }
  }
});

check('P-012', 'noticeDelivery formatters do not send', () => {
  const raw = readSrc('src/noticeDelivery.js');
  if (raw === null) return { skip: 'src/noticeDelivery.js not present' };
  // The formatters (deliverBatch/deliverImmediate) must not CALL voiceSend or a
  // raw /send-message HTTP endpoint. They return text; triage sends. (A doc
  // comment mentioning voiceSend is fine — we check code, not prose.)
  const src = codeOnly(raw);
  if (/\bvoiceSend\s*\(/.test(src) || /['"`]\/send-message['"`]/.test(src)) {
    return 'noticeDelivery.js must not call voiceSend or POST /send-message — it is a formatter module (P-012).';
  }
});

// ── P-014 — Every Shim Field Has a Fixture Test ──────────────────────────────
check('P-014', 'baileys shim fixture suite is present', () => {
  const runner = path.join(ROOT, 'tests/shim/run.js');
  if (!fs.existsSync(runner)) return { skip: 'tests/shim/run.js not present' };
  const fixturesDir = path.join(ROOT, 'tests/shim/fixtures');
  if (!fs.existsSync(fixturesDir)) return 'tests/shim/fixtures/ missing.';
  const lidFixtures = fs.readdirSync(fixturesDir).filter(f => {
    try { return fs.readFileSync(path.join(fixturesDir, f), 'utf8').includes('@lid'); }
    catch (_) { return false; }
  });
  if (lidFixtures.length === 0) return 'no @lid fixture found in tests/shim/fixtures/ (P-014 mandates LID variants).';
});

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n─────────────────`);
  console.log(`  ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log(`─────────────────\n`);

  return { passed, failed, skipped };
}

// Exported so a regression test can assert the checker passes in-process.
module.exports = { runChecks };

// Run as a script → non-zero exit on any failure.
if (require.main === module) {
  const r = runChecks();
  if (r.failed > 0) process.exit(1);
}
