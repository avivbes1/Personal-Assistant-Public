/**
 * Regression: 2026-09-20 — Learning loop closure tests (Phase S2)
 *
 * Tests that the self-improving learning loop WORKS, not just that its files
 * have the right shape. Shape tests pass on an empty file; these fail when
 * learning stops.
 *
 * UC-1: Promotion closure — a pattern with ≥3 corrections must have a
 *       corresponding line in memory.md. Tests the outcome, not the rule.
 * UC-2: No stale open corrections — status='open' older than 14 days fails.
 * UC-3: Pattern coverage — corrections created after R2 must have a pattern.
 * UC-4: Maintenance freshness — last_maintenance must be within 7 days.
 * UC-5: Budget — memory.md ≤ 100 lines.
 */

const fs = require('fs');
const { initDB, getDB } = require('../../src/db');

const MEMORY_PATH = '/home/ubuntu/self-improving/memory.md';
const HEARTBEAT_PATH = '/home/ubuntu/self-improving/heartbeat-state.md';
const R2_CUTOFF = new Date('2026-09-20T00:00:00+03:00').getTime(); // R2 landed

module.exports = {
  // This test validates the LIVE learning loop on the production server.
  // It reads production paths (/home/ubuntu/self-improving/*) and the live DB.
  // In CI, those don't exist — skip gracefully.
  ci_skip: true,

  async run() {
    if (process.env.CI) {
      return { pass: true, message: 'Skipped in CI (live-system closure test)', skipped: true };
    }

    const errors = [];

    initDB();
    const db = getDB();

    // ── UC-1: Promotion closure ─────────────────────────────────────────────
    // A pattern with 3+ entries should be represented in memory.md
    {
      let memoryContent = '';
      try { memoryContent = fs.readFileSync(MEMORY_PATH, 'utf8').toLowerCase(); } catch (_) {}
      // Some promotions land in AGENTS.md (ALWAYS-ON rules) rather than memory.md
      const AGENTS_PATH = '/home/ubuntu/C:\\Users\\user\\.openclaw\\workspace-personal/AGENTS.md';
      try { memoryContent += '\n' + fs.readFileSync(AGENTS_PATH, 'utf8').toLowerCase(); } catch (_) {}

      const patterns = db.prepare(
        "SELECT pattern, COUNT(*) as cnt FROM corrections WHERE pattern IS NOT NULL AND status != 'archived' GROUP BY pattern HAVING COUNT(*) >= 3"
      ).all();

      // Map patterns to expected memory.md keywords
      const patternKeywords = {
        'capability-exists-unused': ['check first', 'grep for it', 'before building', 'before claiming'],
        'repeated-surface-rule-violation': ['english always', 'hebrew always', 'language'],
        'silent-absence': ['chat history', 'first action', 'never drop'],
        'unverified-negative-claim': ['lookup discipline', 'cron list', 'verify'],
        'leaking-internals': ['silent work', 'silently', 'intermediate'],
      };

      for (const { pattern, cnt } of patterns) {
        const keywords = patternKeywords[pattern] || [pattern.replace(/-/g, ' ')];
        const found = keywords.some(kw => memoryContent.includes(kw));
        if (!found) {
          errors.push(`UC-1: pattern '${pattern}' has ${cnt} corrections but no matching rule in memory.md`);
        }
      }
    }

    // ── UC-2: No stale open corrections ─────────────────────────────────────
    {
      const fourteenDaysAgo = Date.now() - 14 * 86400000;
      const stale = db.prepare(
        "SELECT id, context FROM corrections WHERE status = 'open' AND created_at < ?"
      ).all(fourteenDaysAgo);

      if (stale.length > 0) {
        errors.push(`UC-2: ${stale.length} correction(s) stuck as 'open' for >14 days (ids: ${stale.map(s => s.id).join(',')})`);
      }
    }

    // ── UC-3: Pattern coverage (post-R2 only) ──────────────────────────────
    {
      const untagged = db.prepare(
        "SELECT id, context FROM corrections WHERE pattern IS NULL AND created_at > ?"
      ).all(R2_CUTOFF);

      if (untagged.length > 0) {
        errors.push(`UC-3: ${untagged.length} post-R2 correction(s) without a pattern (ids: ${untagged.map(u => u.id).join(',')})`);
      }
    }

    // ── UC-4: Maintenance freshness ─────────────────────────────────────────
    {
      try {
        const content = fs.readFileSync(HEARTBEAT_PATH, 'utf8');
        const m = content.match(/last_maintenance:\s*(\d{4}-\d{2}-\d{2})/);
        if (!m) {
          errors.push('UC-4: could not parse last_maintenance from heartbeat-state.md');
        } else {
          const lastMs = new Date(m[1] + 'T12:00:00+03:00').getTime();
          const ageDays = Math.round((Date.now() - lastMs) / 86400000);
          if (ageDays > 7) {
            errors.push(`UC-4: last_maintenance is ${ageDays} days ago (${m[1]}), max 7`);
          }
        }
      } catch (e) {
        errors.push(`UC-4: cannot read heartbeat-state.md: ${e.message}`);
      }
    }

    // ── UC-5: Budget ────────────────────────────────────────────────────────
    {
      try {
        const lines = fs.readFileSync(MEMORY_PATH, 'utf8').split('\n').length;
        if (lines > 100) {
          errors.push(`UC-5: memory.md is ${lines} lines (max 100)`);
        }
      } catch (e) {
        errors.push(`UC-5: cannot read memory.md: ${e.message}`);
      }
    }

    return {
      pass: errors.length === 0,
      message: errors.length === 0 ? 'All learning loop closure tests passed' : errors.join('\n'),
    };
  },
};
