/**
 * 2026-08-31-stale-send-gate.js — Regression test for B3: time-granular staleness.
 *
 * Verifies:
 *   1. computeDeadline() correctly computes deadlines from all field combinations
 *   2. israelDateToUTC() converts Israel local time to UTC correctly
 *   3. A notice dated today with a time 2h in the past is stale (skipped)
 *   4. A notice dated tomorrow with no time is NOT stale (sends)
 *   5. A notice with relevant_datetime in the past is stale
 *   6. A notice with no date fields is never stale (evergreen)
 *   7. End-of-day deadline for date-only notices
 */

'use strict';
const assert = require('assert');
const { computeDeadline, israelDateToUTC } = require('../../src/triage-engine');

// Helper: get current date string in Israel TZ
function israelDateStr(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

// Helper: get current hour in Israel TZ
function israelHour(date = new Date()) {
  return parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false
    }).format(date),
    10
  );
}

// Helper: format HH:MM in Israel TZ
function israelTimeStr(date = new Date()) {
  return date.toLocaleTimeString('en-US', {
    timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false
  });
}

module.exports = {
  async run() {
  try {
console.log('=== B3 Stale Send Gate — Regression Tests ===\n');

// ── Test 1: israelDateToUTC basic conversion ──────────────────────────────────
{
  console.log('Test 1: israelDateToUTC basic conversion');

  // A known date/time in Israel: 2026-08-31T12:00:00 Israel = 2026-08-31T09:00:00 UTC (IDT = UTC+3)
  const result = israelDateToUTC('2026-08-31T12:00:00');
  assert.ok(result instanceof Date, 'should return a Date');
  assert.ok(!isNaN(result.getTime()), 'should be a valid Date');

  // Israel is UTC+3 in summer (IDT), so 12:00 Israel = 09:00 UTC
  assert.strictEqual(result.getUTCHours(), 9, 'should be 09:00 UTC for 12:00 Israel in summer');
  assert.strictEqual(result.getUTCMinutes(), 0);
  console.log('  ✅ israelDateToUTC converts correctly (12:00 Israel → 09:00 UTC)\n');
}

// ── Test 2: israelDateToUTC winter time (IST = UTC+2) ───────────────────────
{
  console.log('Test 2: israelDateToUTC winter time');

  // 2026-01-15T14:00:00 Israel (IST, UTC+2) = 2026-01-15T12:00:00 UTC
  const result = israelDateToUTC('2026-01-15T14:00:00');
  assert.strictEqual(result.getUTCHours(), 12, 'should be 12:00 UTC for 14:00 Israel in winter');
  console.log('  ✅ Winter time converts correctly (14:00 Israel → 12:00 UTC)\n');
}

// ── Test 3: computeDeadline with relevant_datetime (epoch ms) ──────────────
{
  console.log('Test 3: computeDeadline with relevant_datetime (epoch ms)');

  const pastEpoch = Date.now() - 2 * 3600000; // 2h ago
  const notice = { relevant_datetime: pastEpoch, relevance_date: null, relevance_time: null };
  const deadline = computeDeadline(notice);
  assert.strictEqual(deadline.getTime(), pastEpoch, 'deadline should match the epoch');
  assert.ok(deadline < new Date(), 'deadline should be in the past');
  console.log('  ✅ Past relevant_datetime produces past deadline\n');
}

// ── Test 4: computeDeadline with relevant_datetime (ISO string) ─────────────
{
  console.log('Test 4: computeDeadline with relevant_datetime (ISO string)');

  const futureISO = new Date(Date.now() + 24 * 3600000).toISOString();
  const notice = { relevant_datetime: futureISO, relevance_date: null, relevance_time: null };
  const deadline = computeDeadline(notice);
  assert.ok(deadline > new Date(), 'future ISO deadline should be in the future');
  console.log('  ✅ Future relevant_datetime produces future deadline\n');
}

// ── Test 5: computeDeadline with relevance_date + relevance_time ────────────
{
  console.log('Test 5: computeDeadline with relevance_date + relevance_time');

  // Today in Israel, 2 hours ago
  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 2 * 3600000);
  const dateStr = israelDateStr(twoHoursAgo);
  const timeStr = israelTimeStr(twoHoursAgo);

  const notice = { relevant_datetime: null, relevance_date: dateStr, relevance_time: timeStr };
  const deadline = computeDeadline(notice, now);
  assert.ok(deadline < now, `deadline (${deadline.toISOString()}) should be before now (${now.toISOString()})`);
  console.log(`  ✅ Notice with date=${dateStr} time=${timeStr} is stale (deadline ${deadline.toISOString()})\n`);
}

// ── Test 6: computeDeadline with relevance_date only (end-of-day) ───────────
{
  console.log('Test 6: computeDeadline with relevance_date only → end-of-day');

  const tomorrow = new Date(Date.now() + 24 * 3600000);
  const tomorrowStr = israelDateStr(tomorrow);

  const notice = { relevant_datetime: null, relevance_date: tomorrowStr, relevance_time: null };
  const deadline = computeDeadline(notice);
  assert.ok(deadline > new Date(), 'tomorrow end-of-day deadline should be in the future');

  // Verify it's close to 23:59:59 Israel time tomorrow
  const deadlineIsraelHour = israelHour(deadline);
  assert.strictEqual(deadlineIsraelHour, 23, 'end-of-day deadline should be at 23:xx Israel time');
  console.log(`  ✅ Date-only notice gets end-of-day deadline (${deadline.toISOString()})\n`);
}

// ── Test 7: computeDeadline with no date fields (evergreen) ─────────────────
{
  console.log('Test 7: computeDeadline with no date fields → far future');

  const notice = { relevant_datetime: null, relevance_date: null, relevance_time: null };
  const deadline = computeDeadline(notice);
  const oneYearFromNow = new Date(Date.now() + 364 * 24 * 3600000);
  assert.ok(deadline > oneYearFromNow, 'evergreen notice deadline should be ~1 year out');
  console.log('  ✅ Evergreen notice is never stale\n');
}

// ── Test 8: Staleness scenario — notice dated today, time 2h past → stale ──
{
  console.log('Test 8: Scenario — today with time 2h past is STALE');

  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 2 * 3600000);
  const notice = {
    id: 9001,
    relevant_datetime: null,
    relevance_date: israelDateStr(twoHoursAgo),
    relevance_time: israelTimeStr(twoHoursAgo),
    group_name: 'test-group',
    content: 'test event 2h ago',
  };
  const deadline = computeDeadline(notice, now);
  const isStale = deadline <= now;
  assert.ok(isStale, `Notice with time 2h past should be stale (deadline=${deadline.toISOString()}, now=${now.toISOString()})`);
  console.log('  ✅ Past-time notice correctly identified as stale\n');
}

// ── Test 9: Freshness scenario — notice dated tomorrow → sends ──────────────
{
  console.log('Test 9: Scenario — tomorrow notice is FRESH');

  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 3600000);
  const notice = {
    id: 9002,
    relevant_datetime: null,
    relevance_date: israelDateStr(tomorrow),
    relevance_time: null,
    group_name: 'test-group',
    content: 'test event tomorrow',
  };
  const deadline = computeDeadline(notice, now);
  const isStale = deadline <= now;
  assert.ok(!isStale, `Tomorrow's notice should NOT be stale (deadline=${deadline.toISOString()}, now=${now.toISOString()})`);
  console.log('  ✅ Tomorrow notice correctly identified as fresh\n');
}

// ── Test 10: Edge — notice with time in HH:MM format (no seconds) ───────────
{
  console.log('Test 10: HH:MM format time (no seconds)');

  const notice = {
    relevant_datetime: null,
    relevance_date: '2026-09-01',
    relevance_time: '14:30',
  };
  const deadline = computeDeadline(notice);
  assert.ok(!isNaN(deadline.getTime()), 'should produce valid deadline from HH:MM time');
  // 14:30:00 Israel summer (UTC+3) = 11:30:00 UTC
  assert.strictEqual(deadline.getUTCHours(), 11, 'should be 11:30 UTC for 14:30 Israel');
  assert.strictEqual(deadline.getUTCMinutes(), 30);
  console.log('  ✅ HH:MM format parsed correctly\n');
}

// ── Test 11: Priority — relevant_datetime takes precedence over date+time ───
{
  console.log('Test 11: relevant_datetime takes precedence over date+time');

  const epoch = Date.now() + 5 * 3600000;
  const notice = {
    relevant_datetime: epoch,
    relevance_date: '2020-01-01', // way in the past
    relevance_time: '08:00',
  };
  const deadline = computeDeadline(notice);
  assert.strictEqual(deadline.getTime(), epoch, 'relevant_datetime should win over relevance_date');
  console.log('  ✅ relevant_datetime has highest priority\n');
}

console.log('=== All B3 stale-send-gate tests passed \u2705 ===');

    return { pass: true, message: 'B3: time-granular staleness — computeDeadline, israelDateToUTC, stale/fresh scenarios all pass' };
  } catch (e) {
    return { pass: false, message: `B3 stale-send-gate failed: ${e.message}` };
  }
  } // end run()
};

// Run if called directly
if (require.main === module) {
  module.exports.run().catch(e => { console.error(e); process.exit(1); });
}
