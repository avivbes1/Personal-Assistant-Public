'use strict';
/**
 * classifier.js — Single authority on Claude Code routing decisions.
 *
 * Returns: { route, tier, reason, timeoutMs }
 *   route:     'claude-code' | 'direct'
 *   tier:      'research' | 'code' | 'deep' | null
 *   reason:    short debug string
 *   timeoutMs: how long to wait for Claude Code before fallback
 *
 * Classification is fully deterministic — no LLM call.
 * Default is always 'direct'. Claude Code only when signal is clear.
 */

// ── Timeouts per task tier ────────────────────────────────────────────────────
const TIMEOUTS = {
  research: 5  * 60 * 1000,   // 5 min  — "look into", "explain", "compare"
  code:     10 * 60 * 1000,   // 10 min — "write", "fix", "refactor"
  deep:     20 * 60 * 1000,   // 20 min — "debug", "investigate", multi-file
};

// ── Hard exclusions — always direct, regardless of content ───────────────────
// These match the calling context, not the message text.
const EXCLUDED_SOURCES = new Set([
  'heartbeat',
  'triage',
  'calendar',
  'group_event',
  'morning_digest',
  'notice_delivery',
  'cron',
  'scheduler',
]);

// ── Anti-signals — veto Claude Code even if other signals present ─────────────
const ANTI_SIGNALS = [
  /^(yes|no|ok|sure|thanks|אוקיי|תודה|בסדר|טוב)\b/i,
  /\b(translate|תרגם|digest|digest|hebrew|עברית)\b/i,
  /^[@#]/,   // command prefixes
];

// ── Tier 1: DEEP — multi-file investigation, debugging, architecture ──────────
const DEEP_SIGNALS = [
  /\b(debug|investigate|trace|root.?cause|why.+is.+failing|why.+broke|diagnose)\b/i,
  /\b(architecture|design.+review|refactor.+entire|full.+rewrite|overhaul)\b/i,
  /\b(across.+(files?|codebase|modules?|services?))\b/i,
  /stack.?trace/i,
  /\bERR\w+:|TypeError:|Error:/,
];

// ── Tier 2: CODE — write or fix specific code ─────────────────────────────────
const CODE_SIGNALS = [
  /\b(write|add|implement|create|build)\s+(a\s+)?(feature|function|class|module|script|test|migration|endpoint)\b/i,
  /\b(fix|patch|repair)\s+(the\s+)?(bug|issue|error|problem|crash)\b/i,
  /\b(refactor|rewrite|clean.?up)\s+\w+/i,
  /```[\s\S]{20,}```/,         // code block with real content
  /\b(src\/|\.js\b|\.ts\b|\.py\b)/,
  /\bfunction\s+\w+|class\s+\w+\s*{/,
];

// ── Tier 3: RESEARCH — information gathering, comparison, explanation ─────────
const RESEARCH_SIGNALS = [
  /\b(research|look.?into|investigate)\b/i,
  /\b(compare|comparison|vs\.?|versus)\b.*\b(library|approach|option|method)\b/i,
  /\b(how.+works?|what.+does|explain.+how)\b.{20,}/i,
  /\b(summarize|summarise|overview.+of|give.+me.+a.+report)\b/i,
  /\b(best.+practice|recommendation|should.+we.+use)\b/i,
];

// ── Classifier ────────────────────────────────────────────────────────────────

/**
 * @param {string} message   The user's raw message text
 * @param {object} context
 * @param {string} context.source   e.g. 'aviv_dm', 'heartbeat', 'triage', …
 * @param {string} [context.threadId]  For sticky routing
 * @returns {{ route: string, tier: string|null, reason: string, timeoutMs: number|null }}
 */
function classify(message, context = {}) {
  const { source = 'unknown' } = context;

  // 1. Hard exclusion by source
  if (EXCLUDED_SOURCES.has(source)) {
    return direct('excluded_source');
  }

  // 2. Must come from Aviv's DM
  if (source !== 'aviv_dm') {
    return direct('not_aviv_dm');
  }

  // 3. Too short to be a code/research task
  if (!message || message.trim().length < 80) {
    return direct('too_short');
  }

  // 4. Anti-signal veto
  for (const pattern of ANTI_SIGNALS) {
    if (pattern.test(message)) {
      return direct('anti_signal');
    }
  }

  // 5. Tier matching — most specific first
  if (matchCount(message, DEEP_SIGNALS) >= 1) {
    return claudeCode('deep', TIMEOUTS.deep, 'deep_signal');
  }

  if (matchCount(message, CODE_SIGNALS) >= 2) {
    return claudeCode('code', TIMEOUTS.code, 'code_signal');
  }

  if (matchCount(message, RESEARCH_SIGNALS) >= 2) {
    return claudeCode('research', TIMEOUTS.research, 'research_signal');
  }

  return direct('no_signal');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function matchCount(text, patterns) {
  return patterns.filter(p => p.test(text)).length;
}

function direct(reason) {
  return { route: 'direct', tier: null, reason, timeoutMs: null };
}

function claudeCode(tier, timeoutMs, reason) {
  return { route: 'claude-code', tier, reason, timeoutMs };
}

module.exports = { classify, TIMEOUTS };
