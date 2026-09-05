'use strict';

/**
 * DST boundary tests for src/timeUtils.js — task C2.
 *
 * Israel observes DST: it runs on IST (UTC+2) in winter and IDT (UTC+3) in
 * summer. The transitions are anchored to Jerusalem wall clock, not UTC:
 *   • Spring-forward: the Friday before the last Sunday of March, at 02:00 IST.
 *     In 2026 the last Sunday is March 29 → clocks jump 02:00→03:00 on Fri
 *     2026-03-27, which is 00:00 UTC (02:00 IST = UTC+2).
 *   • Fall-back:      the last Sunday of October, at 02:00 IDT.
 *     In 2026 that is Oct 25 → clocks fall 02:00→01:00, which is 23:00 UTC on
 *     Oct 24 (02:00 IDT = UTC+3).
 *
 * The helpers must yield the correct Israel calendar date / offset around these
 * instants no matter the host TZ (the box runs on UTC). Written in the repo's
 * check()/run() unit-test style (assert-based) so it both runs standalone and
 * integrates with tests/run-all.js.
 *
 * Run standalone:  node tests/unit/dst-boundaries.test.js
 * Or via the suite: node tests/run-all.js
 */

const assert = require('node:assert/strict');

const {
  israelDateIso,
  israelWeekday,
  addDaysIso,
  israelOffsetMs,
  israelNowParts,
} = require('../../src/timeUtils');

const H = 3600000;

const checks = [];
function check(label, fn) {
  try {
    fn();
    checks.push({ label, pass: true, detail: '' });
  } catch (e) {
    checks.push({ label, pass: false, detail: e.message.split('\n')[0] });
  }
}

// ── 1 & 2: the offset actually flips across each transition ─────────────────
check('spring-forward: offset +2h before, +3h after the March transition', () => {
  assert.equal(israelOffsetMs(new Date('2026-03-26T12:00:00Z')), 2 * H); // winter side, UTC+2
  assert.equal(israelOffsetMs(new Date('2026-03-27T12:00:00Z')), 3 * H); // summer side, UTC+3
});
check('fall-back: offset +3h before, +2h after the October transition', () => {
  assert.equal(israelOffsetMs(new Date('2026-10-24T12:00:00Z')), 3 * H); // summer side, UTC+3
  assert.equal(israelOffsetMs(new Date('2026-10-25T12:00:00Z')), 2 * H); // winter side, UTC+2
});

// ── 3: israelDateIso() at the specific UTC instants from the task ───────────
// The exact wall-clock reasoning shifts once the transition instant is crossed,
// but the calendar DATE each instant lands on is stable — assert that.
check('israelDateIso around spring-forward → both land on 2026-03-27', () => {
  assert.equal(israelDateIso(new Date('2026-03-27T00:30:00Z')), '2026-03-27');
  assert.equal(israelDateIso(new Date('2026-03-27T01:30:00Z')), '2026-03-27');
});
check('israelDateIso around fall-back → both land on 2026-10-25', () => {
  assert.equal(israelDateIso(new Date('2026-10-24T23:30:00Z')), '2026-10-25');
  assert.equal(israelDateIso(new Date('2026-10-25T00:30:00Z')), '2026-10-25');
});
check('israelNowParts is self-consistent across the boundary instants', () => {
  for (const s of ['2026-03-27T00:30:00Z', '2026-03-27T01:30:00Z',
                   '2026-10-24T23:30:00Z', '2026-10-25T00:30:00Z']) {
    const d = new Date(s);
    const p = israelNowParts(d);
    const iso = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
    assert.equal(iso, israelDateIso(d), `parts date agrees with israelDateIso for ${s}`);
    assert.ok(p.hours >= 0 && p.hours <= 23, `hours in range for ${s}`);
    assert.equal(p.minutes, 30, `minutes preserved for ${s}`);
  }
});

// ── 4: israelWeekday is TZ-independent (anchored at noon UTC) ────────────────
check('israelWeekday returns the same value regardless of host TZ', () => {
  // A calendar date's weekday cannot depend on a ±1h DST shift or host TZ.
  const orig = process.env.TZ;
  try {
    const under = (tz) => { process.env.TZ = tz; return israelWeekday('2026-03-27'); };
    // 2026-03-27 is a Friday (5); 2026-10-25 is a Sunday (0).
    assert.equal(israelWeekday('2026-03-27'), 5);
    assert.equal(israelWeekday('2026-10-25'), 0);
    // Same answer whether the host claims UTC, Israel, or a far-west/east zone.
    assert.equal(under('UTC'), 5);
    assert.equal(under('Asia/Jerusalem'), 5);
    assert.equal(under('America/Los_Angeles'), 5);
    assert.equal(under('Pacific/Kiritimati'), 5);
  } finally {
    if (orig === undefined) delete process.env.TZ; else process.env.TZ = orig;
  }
});

// ── 5: addDaysIso crosses DST boundaries without drifting the calendar day ──
check('addDaysIso steps across the spring-forward boundary cleanly', () => {
  assert.equal(addDaysIso('2026-03-26', 1), '2026-03-27');  // into the transition day
  assert.equal(addDaysIso('2026-03-27', 1), '2026-03-28');  // out of it
  assert.equal(addDaysIso('2026-03-20', 14), '2026-04-03'); // straddling, +14
});
check('addDaysIso steps across the fall-back boundary cleanly', () => {
  assert.equal(addDaysIso('2026-10-24', 1), '2026-10-25');  // into the transition day
  assert.equal(addDaysIso('2026-10-25', 1), '2026-10-26');  // out of it
  assert.equal(addDaysIso('2026-10-24', 7), '2026-10-31');  // straddling, +7
  assert.equal(addDaysIso('2026-10-25', -1), '2026-10-24'); // negative back over it
});

const passed = checks.filter((c) => c.pass).length;
const failures = checks.filter((c) => !c.pass).map((c) => `${c.label} — ${c.detail}`);

function run() {
  return failures.length === 0
    ? { pass: true, message: `dst-boundaries: ${passed}/${checks.length} checks passed` }
    : { pass: false, message: `dst-boundaries: ${failures.length} failed:\n  ${failures.join('\n  ')}` };
}

module.exports = { run };

// Standalone execution
if (require.main === module) {
  console.log('\n=== dst-boundaries.test.js ===\n');
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.label}${c.pass ? '' : ` (${c.detail})`}`);
  }
  const r = run();
  console.log(`\n=== ${r.message} ===`);
  if (!r.pass) process.exit(1);
}
