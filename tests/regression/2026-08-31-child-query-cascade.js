/**
 * Regression: ISSUE-024 — child-scoped question must cascade past an empty date window
 *
 * ISSUE-024: a child-scoped question with no explicit date window (e.g. "did the
 * football notice come for <child>?") returned nothing, because the date-bounded
 * first leg (`findUpcoming`, default [today, today+7]) missed a notice whose
 * relevance_date sits outside that window, and the search stopped there. The fix
 * made `noticeSearch()` cascade to `findByContent()` (date-agnostic, 14-day
 * content search) whenever the first leg is empty, so the notice still surfaces.
 *
 * This test PINS that cascade before Phase J1 touches `noticeSearch()`. J1 adds a
 * `mode: 'question' | 'digest'` parameter:
 *   - 'question' (default): keep cascading — this is the ISSUE-024 behaviour.
 *   - 'digest': DO NOT cascade — an empty date window is a valid answer to a
 *     bounded request; return empty with matched_via = 'upcoming_empty'.
 *
 * So the test has two halves:
 *   T1/T2 — QUESTION mode cascade. Must pass against CURRENT code (baseline) and
 *           must keep passing after J1. This is the ISSUE-024 regression guard.
 *   T3    — DIGEST mode must NOT cascade. Forward-looking: current code has no
 *           `mode` param and cascades unconditionally, so until J1 lands this is
 *           reported PENDING (not a failure). Once J1 gates the fallback, it is
 *           asserted strictly.
 *
 * The test calls the REAL noticeSearch() exported from voice-server.js (imported
 * with VOICE_SERVER_NO_LISTEN so requiring the module does not bind port 3001),
 * so a J1 change that breaks the question cascade fails here.
 */

'use strict';

// Must be set BEFORE requiring voice-server so its module-load auto-start is skipped.
process.env.VOICE_SERVER_NO_LISTEN = '1';

const { initDB, getDB, saveNotice } = require('../../src/db');
const { noticeSearch } = require('../../src/voice-server');
const { NoticeRepository } = require('../../src/notices/repository');

const DAY = 24 * 60 * 60 * 1000;

// Unique markers so the fixture is isolated from any real rows and trivially
// cleaned up. Child name + search term live in the content because the fixture
// group is not in `groups`, so primary_child is NULL — the repo's child filter
// matches primary_child OR the name appearing in the body.
const GROUP = 'ISSUE024-Group';
const CHILD = 'ISSUE024Child';
const TERM  = 'ISSUE024Token';

module.exports = {
  async run() {
    const errors = [];
    const pending = [];

    initDB();
    const db = getDB();

    const clean = () => {
      db.prepare("DELETE FROM notices WHERE group_name = ? OR content LIKE 'ISSUE024%'").run(GROUP);
    };
    clean();

    try {
      // Fixture: relevance_date 30 days in the PAST (well outside the default
      // [today, today+7] upcoming window), created just now (inside the 14-day
      // content-search lookback). This is exactly the ISSUE-024 shape — the
      // date-bounded leg cannot see it, only the content fallback can.
      const pastIso = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
      const noticeId = saveNotice({
        group_name: GROUP,
        content: `${CHILD} כדורגל ${TERM} — child-scoped question fixture (past-dated)`,
        relevance_date: pastIso,
        source_timestamp: Date.now(),
        delivery_status: 'pending',
      });

      // ── Sanity: the two legs behave as the scenario requires ────────────────
      const repo = new NoticeRepository();
      const upcoming = repo.findUpcoming({ searchText: TERM, childName: CHILD });
      if (upcoming.some(r => r.id === noticeId)) {
        errors.push('SETUP: findUpcoming should NOT see the past-dated fixture (its first leg must be empty)');
      }
      const byContent = repo.findByContent({ searchText: TERM, childName: CHILD });
      if (!byContent.some(r => r.id === noticeId)) {
        errors.push('SETUP: findByContent must find the fixture (the cascade target)');
      }

      // ── T1: QUESTION mode, default (no mode arg) — must cascade and find it ──
      const t1 = noticeSearch({ q: TERM, child: CHILD });
      if (!t1.results.some(r => r.id === noticeId)) {
        errors.push(`T1: default-mode noticeSearch did not surface the fixture (matched_via=${t1.matched_via})`);
      }
      if (t1.matched_via !== 'content_fallback') {
        errors.push(`T1: expected matched_via 'content_fallback' (cascade fired), got '${t1.matched_via}'`);
      }

      // ── T2: QUESTION mode, explicit — must behave identically ──────────────
      // J1 makes 'question' the default; passing it explicitly documents the
      // forward interface. Current code ignores the extra key, which is fine.
      const t2 = noticeSearch({ q: TERM, child: CHILD, mode: 'question' });
      if (!t2.results.some(r => r.id === noticeId)) {
        errors.push(`T2: mode='question' did not surface the fixture (matched_via=${t2.matched_via})`);
      }

      // ── T3: DIGEST mode — must NOT cascade (forward-looking) ───────────────
      // After J1: an empty upcoming window is returned as-is, matched_via
      // 'upcoming_empty', and the fixture is NOT surfaced.
      // Before J1: no mode param exists, so it cascades like question mode —
      // reported as PENDING rather than failed.
      const t3 = noticeSearch({ q: TERM, child: CHILD, mode: 'digest' });
      const j1DigestLanded = t3.matched_via === 'upcoming_empty';
      if (j1DigestLanded) {
        if (t3.results.some(r => r.id === noticeId)) {
          errors.push('T3: digest mode must NOT cascade — fixture leaked into a bounded digest window');
        }
        if (t3.results.length !== 0) {
          errors.push(`T3: digest mode with an empty window must return 0 results, got ${t3.results.length}`);
        }
      } else {
        pending.push(
          `T3: digest-mode no-cascade — J1 not yet landed (noticeSearch still cascades, ` +
          `matched_via='${t3.matched_via}'). Will assert once mode='digest' returns 'upcoming_empty'.`
        );
      }
    } finally {
      clean();
    }

    if (errors.length > 0) {
      return { pass: false, message: errors.join('\n         ') };
    }
    const base = 'ISSUE-024: child-scoped question cascades findUpcoming→findByContent and surfaces the past-dated notice.';
    return {
      pass: true,
      message: pending.length
        ? `${base}\n         ${pending.map(p => '⏳ ' + p).join('\n         ')}`
        : base,
    };
  },
};
