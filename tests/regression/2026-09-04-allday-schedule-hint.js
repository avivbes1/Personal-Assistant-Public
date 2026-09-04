/**
 * 2026-09-04-allday-schedule-hint.js — Regression test for K3 + Q4 + Q5.
 *
 * K3 (all-day events): a calendar-worthy notice with a known date but NO time
 *   must become an all-day event, never a fabricated time (ISSUE-025). The
 *   bridge payload flags the pending hour in the title and records
 *   time_status='unknown'; the calendar_intents outbox carries a time_status
 *   column (plus the other bridge columns that were missing on fresh DBs).
 *
 * Q5 (schedule-query regex): isScheduleQuery() recognises the added Hebrew
 *   phrasings (באיזה שעה / איפה / מה עם ה / כמה עולה / מתי מתחיל / צריך להביא /
 *   יש ל<שם> חוג) while leaving non-schedule chatter alone.
 *
 * Q4 (pre-fetch hint): buildScheduleHint() returns a context block grounded in
 *   real notices (with notice ids) for schedule queries, and '' otherwise — a
 *   hint, never a gate.
 */

'use strict';
const assert = require('assert');

const GROUP = 'test-group-k3';

module.exports = {
  async run() {
    const { initDB, getDB, saveNotice } = require('../../src/db');
    const { buildEventPayload } = require('../../src/calendar-bridge');
    const { isScheduleQuery, buildScheduleHint } = require('../../src/schedule-classifier');

    const createdNoticeIds = [];

    try {
      initDB();
      const db = getDB();

      // ── K3.1: calendar_intents carries time_status + bridge columns ───────────
      {
        const cols = db.prepare('PRAGMA table_info(calendar_intents)').all().map(c => c.name);
        assert.ok(cols.includes('time_status'), 'calendar_intents must have a time_status column');
        for (const c of ['notice_id', 'fingerprint', 'event_location', 'attempts', 'updated_at', 'last_error']) {
          assert.ok(cols.includes(c), `calendar_intents must have the "${c}" column (bridge INSERT needs it)`);
        }
        console.log('  ✅ K3.1: calendar_intents has time_status + all bridge columns');
      }

      // ── K3.2: time known → normal timed event ────────────────────────────────
      {
        const p = buildEventPayload({ event_title: 'אסיפת הורים', relevance_date: '2026-09-09', relevance_time: '18:30', content: 'x', group_name: GROUP });
        assert.strictEqual(p.time_status, 'known', 'a notice with a time is time_status=known');
        assert.strictEqual(p.start_time, '2026-09-09T18:30:00', 'timed event keeps its datetime start');
        assert.ok(!/שעה טרם פורסמה/.test(p.title), 'timed event title must not carry the pending-hour suffix');
        console.log('  ✅ K3.2: known-time notice → timed event');
      }

      // ── K3.3: date known, time unknown → all-day event, no fabricated time ────
      {
        const p = buildEventPayload({ event_title: 'אסיפת הורים', relevance_date: '2026-09-09', relevance_time: null, content: 'x', group_name: GROUP });
        assert.strictEqual(p.time_status, 'unknown', 'a dated notice with no time is time_status=unknown');
        assert.strictEqual(p.start_time, '2026-09-09', 'all-day event start is a bare date (YYYY-MM-DD)');
        assert.strictEqual(p.end_time, '2026-09-09', 'all-day event end is the same bare date');
        assert.ok(/— שעה טרם פורסמה$/.test(p.title), `all-day title should flag the pending hour; got "${p.title}"`);
        assert.ok(!/T\d\d:/.test(p.start_time), 'all-day event must never carry a fabricated time');
        console.log('  ✅ K3.3: dated, time-unknown notice → all-day event (no invented time)');
      }

      // ── Q5: new schedule-query phrasings match; chatter does not ──────────────
      {
        const shouldMatch = [
          'באיזה שעה האירוע', 'איפה האירוע', 'איפה יהיה הטקס', 'מה עם המסיבה',
          'כמה עולה הטיול', 'מתי מתחיל החוג', 'מתי מסתיים היום',
          'צריך להביא משהו?', 'יש לנטע חוג היום?',
        ];
        for (const s of shouldMatch) {
          assert.strictEqual(isScheduleQuery(s), true, `Q5: "${s}" should be a schedule query`);
        }
        const shouldNotMatch = ['שלום מה שלומך', 'תודה רבה על הכל', 'איזה יום יפה'];
        for (const s of shouldNotMatch) {
          assert.strictEqual(isScheduleQuery(s), false, `Q5: "${s}" should NOT be a schedule query`);
        }
        console.log('  ✅ Q5: added phrasings match, chatter stays out');
      }

      // ── Q4: buildScheduleHint grounds schedule answers in real notices ────────
      {
        // Non-schedule text → no hint, no side effects.
        assert.strictEqual(buildScheduleHint('שלום מה שלומך'), '', 'Q4: non-schedule text yields no hint');

        // Seed a dated notice within the upcoming window and query for it.
        const nowIL = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
        const tomorrow = new Date(nowIL); tomorrow.setDate(nowIL.getDate() + 1);
        const tIso = tomorrow.toISOString().slice(0, 10);
        const nid = saveNotice({
          group_name: GROUP,
          content: 'אסיפת הורים מחר בגן — שעה טרם פורסמה',
          relevance_date: tIso,
          relevance_time: null,
          urgency_hint: 'time_sensitive',
          delivery_status: 'pending',
          source_timestamp: Date.now(),
        });
        createdNoticeIds.push(nid);

        const hint = buildScheduleHint('מה יש מחר?');
        assert.ok(hint.includes('התראות רלוונטיות'), 'Q4: schedule query should produce a hint block');
        assert.ok(hint.includes(`notice:${nid}`), 'Q4: hint must cite the notice id for grounding (G1)');
        assert.ok(hint.includes('אסיפת הורים'), 'Q4: hint should include the notice content');
        console.log('  ✅ Q4: schedule query pre-fetches and cites the matching notice');
      }

      return { pass: true, message: 'K3 all-day events, Q5 schedule phrasings, and Q4 pre-fetch hint all verified' };
    } catch (e) {
      return { pass: false, message: `K3/Q4/Q5 test failed: ${e.message}` };
    } finally {
      try {
        const db = getDB();
        if (createdNoticeIds.length) {
          db.prepare(`DELETE FROM notices WHERE id IN (${createdNoticeIds.map(() => '?').join(',')})`).run(...createdNoticeIds);
        }
      } catch (_) { /* best-effort cleanup */ }
    }
  },
};

// Run if called directly
if (require.main === module) {
  module.exports.run().then(r => {
    console.log(r.pass ? `\n✅ ${r.message}` : `\n❌ ${r.message}`);
    process.exit(r.pass ? 0 : 1);
  });
}
