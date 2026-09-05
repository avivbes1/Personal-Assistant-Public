'use strict';

/**
 * Tests for src/timeUtils.js — Israel timezone helpers.
 *
 * These assert the helpers return correct Israel-anchored values regardless of
 * the host TZ. The box runs on UTC, so we also force TZ=UTC (via the runner /
 * package env) to prove the helpers don't depend on the host being Israel.
 *
 * Run standalone:  TZ=UTC node tests/unit/timeUtils.test.js
 * Or via the suite: node tests/run-all.js
 */

const {
  israelDateIso,
  israelNowParts,
  israelNow,
  israelWeekday,
  addDaysIso,
  israelOffsetMs,
  getIsraelHour,
} = require('../../src/timeUtils');

const checks = [];
function check(label, cond, detail = '') {
  checks.push({ label, pass: !!cond, detail });
}

// ── israelWeekday: fixed known dates ────────────────────────────────────────
// 2026-09-05 is a Saturday (6); 2026-09-06 is a Sunday (0). (See task D1.)
check('israelWeekday(2026-09-05) === 6 (Sat)', israelWeekday('2026-09-05') === 6, `got ${israelWeekday('2026-09-05')}`);
check('israelWeekday(2026-09-06) === 0 (Sun)', israelWeekday('2026-09-06') === 0, `got ${israelWeekday('2026-09-06')}`);
check('israelWeekday(2026-01-01) === 4 (Thu)', israelWeekday('2026-01-01') === 4, `got ${israelWeekday('2026-01-01')}`);

// ── addDaysIso: arithmetic, month/year rollover, negatives ──────────────────
check('addDaysIso +1 day', addDaysIso('2026-09-05', 1) === '2026-09-06', `got ${addDaysIso('2026-09-05', 1)}`);
check('addDaysIso +7 days', addDaysIso('2026-09-05', 7) === '2026-09-12', `got ${addDaysIso('2026-09-05', 7)}`);
check('addDaysIso month rollover', addDaysIso('2026-08-30', 3) === '2026-09-02', `got ${addDaysIso('2026-08-30', 3)}`);
check('addDaysIso year rollover', addDaysIso('2026-12-31', 1) === '2027-01-01', `got ${addDaysIso('2026-12-31', 1)}`);
check('addDaysIso negative', addDaysIso('2026-09-06', -1) === '2026-09-05', `got ${addDaysIso('2026-09-06', -1)}`);
// Spans the IDT→IST DST change (Israel ends DST late Oct); a bare-date add must not drift.
check('addDaysIso across DST boundary', addDaysIso('2026-10-24', 7) === '2026-10-31', `got ${addDaysIso('2026-10-24', 7)}`);

// ── israelDateIso: shape + Israel-vs-UTC late-night correctness ──────────────
const iso = israelDateIso();
check('israelDateIso is YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(iso), `got ${iso}`);
// At 23:30 UTC on 2026-09-05, Israel (UTC+3 in summer) is already 2026-09-06.
const lateNight = new Date('2026-09-05T23:30:00Z');
check('israelDateIso rolls to next Israel day late-night UTC',
  israelDateIso(lateNight) === '2026-09-06', `got ${israelDateIso(lateNight)}`);

// ── israelNowParts: shape + ranges + internal consistency ───────────────────
const p = israelNowParts();
check('parts has all fields',
  ['year', 'month', 'day', 'hours', 'minutes', 'seconds', 'dayOfWeek'].every(k => typeof p[k] === 'number'),
  JSON.stringify(p));
check('parts.month in 1..12', p.month >= 1 && p.month <= 12, `got ${p.month}`);
check('parts.hours in 0..23', p.hours >= 0 && p.hours <= 23, `got ${p.hours}`);
check('parts.dayOfWeek in 0..6', p.dayOfWeek >= 0 && p.dayOfWeek <= 6, `got ${p.dayOfWeek}`);
check('parts date agrees with israelDateIso',
  `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}` === iso,
  `parts=${JSON.stringify(p)} iso=${iso}`);
// Fixed instant: 2026-09-05T23:30:00Z → Israel 2026-09-06 02:30 (summer, UTC+3).
const fp = israelNowParts(lateNight);
check('parts on fixed instant → 2026-09-06 02:30',
  fp.year === 2026 && fp.month === 9 && fp.day === 6 && fp.hours === 2 && fp.minutes === 30 && fp.dayOfWeek === 0,
  JSON.stringify(fp));

// ── israelNow: local fields equal Israel wall clock ─────────────────────────
const inow = israelNow(lateNight);
check('israelNow local fields match Israel parts',
  inow.getFullYear() === 2026 && inow.getMonth() === 8 && inow.getDate() === 6 && inow.getDay() === 0,
  `${inow}`);

// ── getIsraelHour ───────────────────────────────────────────────────────────
check('getIsraelHour matches parts.hours',
  getIsraelHour() === israelNowParts().hours, `hour=${getIsraelHour()}`);

// ── israelOffsetMs: DST-aware Israel offset ─────────────────────────────────
// Summer (IDT) = UTC+3; deep winter (IST) = UTC+2.
check('israelOffsetMs summer === +3h',
  israelOffsetMs(new Date('2026-07-01T12:00:00Z')) === 3 * 3600000,
  `got ${israelOffsetMs(new Date('2026-07-01T12:00:00Z'))}`);
check('israelOffsetMs winter === +2h',
  israelOffsetMs(new Date('2026-01-01T12:00:00Z')) === 2 * 3600000,
  `got ${israelOffsetMs(new Date('2026-01-01T12:00:00Z'))}`);

const passed = checks.filter(c => c.pass).length;
const failures = checks.filter(c => !c.pass).map(c => `${c.label} — ${c.detail}`);

function run() {
  return failures.length === 0
    ? { pass: true, message: `timeUtils: ${passed}/${checks.length} checks passed (TZ=${process.env.TZ || 'host'})` }
    : { pass: false, message: `timeUtils: ${failures.length} failed:\n  ${failures.join('\n  ')}` };
}

module.exports = { run };

// Standalone execution
if (require.main === module) {
  console.log('\n=== timeUtils.test.js ===\n');
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.label}${c.pass ? '' : ` (${c.detail})`}`);
  }
  const r = run();
  console.log(`\n=== ${r.message} ===`);
  if (!r.pass) process.exit(1);
}
