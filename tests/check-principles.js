'use strict';
/**
 * check-principles.js — Pre-commit principle checker
 *
 * Verifies that code changes don't violate architectural principles in PRINCIPLES.md.
 * Run before any commit: node tests/check-principles.js
 *
 * Each check references a principle (P-001, P-002, etc.)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;

function check(name, principle, fn) {
  try {
    const result = fn();
    if (result === true || result === undefined) {
      console.log(`  ✅ [${principle}] ${name}`);
      passed++;
    } else {
      console.error(`  ❌ [${principle}] ${name}`);
      console.error(`     ${result}`);
      failed++;
    }
  } catch (e) {
    console.error(`  ❌ [${principle}] ${name}`);
    console.error(`     Error: ${e.message}`);
    failed++;
  }
}

function readSrc(filename) {
  return fs.readFileSync(path.join(ROOT, filename), 'utf8');
}

function crontab() {
  try {
    const { execSync } = require('child_process');
    return execSync('crontab -l 2>/dev/null').toString();
  } catch (_) { return ''; }
}

console.log('\n🔍 Checking architectural principles...\n');

// ── P-001: Single Actor for Notices ──────────────────────────────────────────

check(
  'send-unposted-notices.js is not in crontab',
  'P-001',
  () => {
    const tab = crontab();
    if (tab.includes('send-unposted-notices')) {
      return 'send-unposted-notices.js found in crontab — violates single-actor principle. Remove it.';
    }
  }
);

check(
  'triage-engine.js claims notices before LLM calls (send_attempted_at)',
  'P-001',
  () => {
    const src = readSrc('src/triage-engine.js');
    if (!src.includes('send_attempted_at') || !src.includes('datetime(\'now\')')) {
      return 'triage-engine.js must set send_attempted_at before LLM calls to prevent concurrent-run races.';
    }
  }
);

check(
  'consolidate-notices.js only touches unposted AND untriaged notices',
  'P-001',
  () => {
    const src = readSrc('consolidate-notices.js');
    if (!src.includes('posted_to_master = 0')) {
      return 'consolidate-notices.js query missing "posted_to_master = 0" — could grab sent notices and re-surface them.';
    }
    if (!src.includes('triage_decision IS NULL')) {
      return 'consolidate-notices.js query missing "triage_decision IS NULL" — could grab in-flight triaged notices and destroy their state.';
    }
  }
);

check(
  'No unauthorized scripts query notices WHERE posted_to_master=0 for sending',
  'P-001',
  () => {
    // Files allowed to SELECT from notices WHERE posted_to_master=0 AND send:
    // - triage-engine.js: the sole authorized sender (P-001)
    // - consolidate-notices.js: read-only merge, no send
    // - noticeDelivery.js: legacy, kept for reference
    // - db.js: schema/helpers only
    // - send-unposted-notices.js: RETIRED script, still on disk but not in crontab (checked separately)
    // - whatsapp.js: uses posted_to_master=0 in DISMISSAL handler (marks notices skip), not queue reading
    const ALLOWED = [
      'triage-engine.js', 'consolidate-notices.js', 'noticeDelivery.js',
      'db.js', 'send-unposted-notices.js', 'whatsapp.js'
    ];
    const srcDir = path.join(ROOT, 'src');
    const rootJs = fs.readdirSync(ROOT).filter(f => f.endsWith('.js'));
    const srcJs  = fs.readdirSync(srcDir).filter(f => f.endsWith('.js'));

    const violations = [];
    for (const file of [...rootJs.map(f => f), ...srcJs.map(f => path.join('src', f))]) {
      if (ALLOWED.some(a => file.endsWith(a))) continue;
      if (file.includes('node_modules') || file.startsWith('tests')) continue;
      try {
        const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
        // Look for scripts that SELECT from notices with posted_to_master=0 AND directly send
        if (/posted_to_master\s*=\s*0/i.test(content) && /voiceSend|sendToGroup/i.test(content)) {
          violations.push(file);
        }
      } catch (_) {}
    }
    if (violations.length > 0) {
      return `Unauthorized notice senders found: ${violations.join(', ')}. Only triage-engine.js may send from the notices queue.`;
    }
  }
);

// ── P-002: No Timeout as Normal Operation ────────────────────────────────────

check(
  'triage-engine.js has a wall-clock budget guard',
  'P-002',
  () => {
    const src = readSrc('src/triage-engine.js');
    if (!src.includes('BUDGET_MS') || !src.includes('START_MS')) {
      return 'triage-engine.js is missing wall-clock budget guard (BUDGET_MS / START_MS). Long runs must defer, not hang.';
    }
  }
);

check(
  'No OpenClaw cron jobs for triage or watchdog (must be system cron)',
  'P-002',
  () => {
    // We can't easily check OpenClaw cron from here, but we verify the system cron has triage
    const tab = crontab();
    if (!tab.includes('triage-engine.js')) {
      return 'triage-engine.js not found in system crontab — it may have been moved back to OpenClaw (violates P-002: no LLM session overhead for triage).';
    }
    if (!tab.includes('watchdog.sh')) {
      return 'watchdog.sh not found in system crontab — watchdog must run independently of OpenClaw (P-003).';
    }
  }
);

// ── P-003: Watchdog Independence ─────────────────────────────────────────────

check(
  'watchdog.sh exists and is executable',
  'P-003',
  () => {
    const watchdogPath = path.join(ROOT, 'scripts/watchdog.sh');
    if (!fs.existsSync(watchdogPath)) {
      return 'scripts/watchdog.sh does not exist. Watchdog must be a standalone bash script.';
    }
    const stat = fs.statSync(watchdogPath);
    const isExec = !!(stat.mode & 0o111);
    if (!isExec) return 'scripts/watchdog.sh is not executable (chmod +x).';
  }
);

check(
  'watchdog.sh uses direct HTTP alert (not OpenClaw/sessions)',
  'P-003',
  () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/watchdog.sh'), 'utf8');
    if (!src.includes('localhost:3001') && !src.includes('send-message')) {
      return 'watchdog.sh must alert via localhost:3001/send-message (direct WhatsApp), not through OpenClaw sessions.';
    }
    if (src.includes('sessions_send') || src.includes('openclaw session')) {
      return 'watchdog.sh must not use OpenClaw session infrastructure for alerts.';
    }
  }
);

// ── P-004: Notices Are Immutable Once Sent ───────────────────────────────────

check(
  'getPendingNotices in triage filters posted_to_master=0',
  'P-004',
  () => {
    const src = readSrc('src/triage-engine.js');
    if (!src.includes('posted_to_master = 0')) {
      return 'triage-engine.js getPendingNotices must filter AND posted_to_master=0.';
    }
  }
);

// ── P-005: Dismissal Is Respected ────────────────────────────────────────────

check(
  'dismissal.js exists with DISMISSAL_REGEX',
  'P-005',
  () => {
    const dismissalPath = path.join(ROOT, 'src/dismissal.js');
    if (!fs.existsSync(dismissalPath)) return 'src/dismissal.js does not exist.';
    const src = fs.readFileSync(dismissalPath, 'utf8');
    if (!src.includes('DISMISSAL_REGEX')) return 'src/dismissal.js must export DISMISSAL_REGEX.';
  }
);

check(
  'whatsapp.js checks DISMISSAL_REGEX in master group handler',
  'P-005',
  () => {
    const src = readSrc('src/whatsapp.js');
    if (!src.includes('DISMISSAL_REGEX')) {
      return 'whatsapp.js must check DISMISSAL_REGEX in the master group message handler.';
    }
  }
);

check(
  'triage-engine.js checks active dismissals before sending',
  'P-005',
  () => {
    const src = readSrc('src/triage-engine.js');
    if (!src.includes('getActiveDismissals') || !src.includes('isTopicDismissed')) {
      return 'triage-engine.js must call getActiveDismissals() and isTopicDismissed() before synthesizing messages.';
    }
  }
);

// ── P-006: Cross-Day Dedup ────────────────────────────────────────────────────

check(
  'triage-engine.js uses 72h lookback for sent_messages (getSentRecent)',
  'P-006',
  () => {
    const src = readSrc('src/triage-engine.js');
    if (!src.includes('getSentRecent') && !src.includes('72 * 3600')) {
      return 'triage-engine.js must use getSentRecent() with 72h lookback, not getSentToday() (midnight-only).';
    }
  }
);

check(
  'triage-engine.js has date lower bound on getPendingNotices (relevance_date >= yesterday)',
  'P-006',
  () => {
    const src = readSrc('src/triage-engine.js');
    if (!src.includes("date('now', '-1 day')")) {
      return "triage-engine.js getPendingNotices must include relevance_date >= date('now', '-1 day') to skip stale past-event notices.";
    }
  }
);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('');
console.log('─'.repeat(45));
if (failed === 0) {
  console.log(`  ✅ All ${passed} principle checks passed`);
} else {
  console.log(`  ${passed} passed, ${failed} FAILED`);
  console.log('  Fix violations before committing.');
}
console.log('─'.repeat(45));
console.log('');

if (failed > 0) process.exit(1);
