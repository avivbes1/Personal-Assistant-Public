/**
 * 2026-09-04-calendar-source-guard.js — Regression test for G1 / P-015.
 *
 * Incident: ISSUE-025 — Lipa fabricated an 18:30 time for a parent meeting
 * (אסיפת הורים) when the source notice only carried a date. Calendar writes went
 * through calendarGate.js:processEventAction() with NO source validation, so an
 * agent-proposed time that appeared nowhere in the source reached the calendar.
 *
 * Fix: sourceValidator.validateCalendarWrite() grounds every agent-proposed
 * field (date/time/location) in the source notice; processEventAction() calls it
 * before writing and blocks + logs when a field is ungrounded.
 *
 * This test verifies:
 *   1. A proposed time absent from the source is rejected (ungrounded_fields: ['time'])
 *   2. A date grounded via relevance_date is accepted
 *   3. A date grounded only via notice.content (Hebrew "12.10" form) is accepted
 *   4. logBlocked records the refused attempt in blocked_actions
 *   5. processEventAction() returns { action: 'blocked' } and logs, end-to-end
 */

'use strict';
const assert = require('assert');

const GROUP = 'test-group-p015';

module.exports = {
  async run() {
    const { initDB, getDB, saveNotice } = require('../../src/db');
    const { validateCalendarWrite, logBlocked } = require('../../src/validation/sourceValidator');

    let createdNoticeIds = [];
    let startBlockedId = 0;

    try {
      initDB();
      const db = getDB();

      // blocked_actions lives in migration 003, not db.js initDB — ensure it
      // exists so logBlocked() (and thus this test) works on a fresh checkout.
      db.exec(`CREATE TABLE IF NOT EXISTS blocked_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action_type TEXT, payload_json TEXT, block_reason TEXT, created_at INTEGER
      )`);
      startBlockedId = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM blocked_actions').get().m;

      const ts = Date.now();

      // ── Fixture 1: notice with a date but NO time ("אסיפת הורים 9.9") ──────────
      const noticeId = saveNotice({
        group_name: GROUP,
        content: 'אסיפת הורים 9.9',
        relevance_date: '2026-09-09',
        relevance_time: null,
        urgency_hint: 'routine',
        delivery_status: 'pending',
        source_timestamp: ts,
      });
      createdNoticeIds.push(noticeId);
      assert.ok(noticeId > 0, 'fixture notice should be saved');

      // ── Test 1: proposed time absent from source → REJECT with ['time'] ───────
      {
        const res = validateCalendarWrite(noticeId, { date: '2026-09-09', time: '18:30' });
        assert.strictEqual(res.valid, false, 'write proposing an unstated time must be rejected');
        assert.deepStrictEqual(res.ungrounded_fields, ['time'],
          `only 'time' should be ungrounded (date is grounded via relevance_date); got ${JSON.stringify(res.ungrounded_fields)}`);
        assert.ok(/time/.test(res.reason), 'reason should mention the ungrounded field');
        console.log('  ✅ Test 1: fabricated time rejected (ungrounded_fields: [time])');
      }

      // ── Test 2: date grounded via relevance_date, no time → ACCEPT ────────────
      {
        const res = validateCalendarWrite(noticeId, { date: '2026-09-09' });
        assert.strictEqual(res.valid, true, 'a date matching relevance_date should be grounded');
        console.log('  ✅ Test 2: date grounded via relevance_date accepted');
      }

      // ── Test 3: date grounded only via content ("טיול 12.10") → ACCEPT ────────
      {
        const noticeId2 = saveNotice({
          group_name: GROUP,
          content: 'טיול שנתי 12.10',
          relevance_date: null,
          relevance_time: null,
          urgency_hint: 'routine',
          delivery_status: 'pending',
          source_timestamp: ts,
        });
        createdNoticeIds.push(noticeId2);
        const res = validateCalendarWrite(noticeId2, { date: '2026-10-12' });
        assert.strictEqual(res.valid, true,
          `date 2026-10-12 should be grounded by the "12.10" form in content; got ${JSON.stringify(res)}`);
        console.log('  ✅ Test 3: date grounded via content (Hebrew D.M form) accepted');
      }

      // ── Test 4: logBlocked records the attempt ────────────────────────────────
      {
        const before = db.prepare('SELECT COUNT(*) AS c FROM blocked_actions').get().c;
        logBlocked('calendar_write', { group_name: GROUP, date: '2026-09-09', time: '18:30' }, 'test: ungrounded time');
        const after = db.prepare('SELECT COUNT(*) AS c FROM blocked_actions').get().c;
        assert.strictEqual(after, before + 1, 'logBlocked should insert exactly one blocked_actions row');
        const row = db.prepare('SELECT * FROM blocked_actions ORDER BY id DESC LIMIT 1').get();
        assert.strictEqual(row.action_type, 'calendar_write', 'blocked row should record action_type=calendar_write');
        console.log('  ✅ Test 4: logBlocked recorded the refused attempt');
      }

      // ── Test 5: processEventAction() blocks + logs end-to-end ─────────────────
      {
        const { processEventAction } = require('../../src/calendarGate');
        const blockedBefore = db.prepare('SELECT COUNT(*) AS c FROM blocked_actions').get().c;
        const result = await processEventAction(
          { action: 'add_event', summary: 'אסיפת הורים', date: '2026-09-09', time: '18:30', group_name: GROUP },
          { source_notice_id: noticeId }
        );
        assert.strictEqual(result.action, 'blocked', `processEventAction should block the ungrounded write; got ${JSON.stringify(result)}`);
        assert.ok((result.ungrounded_fields || []).includes('time'), 'blocked result should flag the time field');
        const blockedAfter = db.prepare('SELECT COUNT(*) AS c FROM blocked_actions').get().c;
        assert.strictEqual(blockedAfter, blockedBefore + 1, 'processEventAction should log exactly one blocked_actions row');
        console.log('  ✅ Test 5: processEventAction blocked the write and logged it');
      }

      return { pass: true, message: 'G1/P-015: calendar-write source guard rejects ungrounded fields, accepts grounded ones, and logs blocks' };
    } catch (e) {
      return { pass: false, message: `G1/P-015 calendar-source-guard failed: ${e.message}` };
    } finally {
      // Clean up everything this test created (runs against the live DB).
      try {
        const db = getDB();
        if (createdNoticeIds.length) {
          db.prepare(`DELETE FROM notices WHERE id IN (${createdNoticeIds.map(() => '?').join(',')})`).run(...createdNoticeIds);
        }
        db.prepare('DELETE FROM blocked_actions WHERE id > ?').run(startBlockedId);
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
