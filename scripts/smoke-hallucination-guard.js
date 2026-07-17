/**
 * smoke-hallucination-guard.js
 * Verifies the Hallucination Guard rejects a known-bad input.
 * Runs validateSource against a fake notice id that cannot exist and asserts
 * it returns { valid: false }. Prints PASS / FAIL.
 */

const _log = console.log; console.log = () => {};
const { initDB } = require('../src/db');
initDB();
console.log = _log;

const { validateSource } = require('../src/validation/sourceValidator');

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

console.log('Hallucination Guard smoke test\n');

// 1. Fake notice_event id — must be rejected.
const FAKE_ID = 999999999;
const r1 = validateSource('notice_event', FAKE_ID);
check('fake notice_event id rejected', r1.valid === false, `got valid=${r1.valid}`);
check('rejection carries a reason', !!r1.reason, JSON.stringify(r1));

// 2. Unknown source type — must be rejected.
const r2 = validateSource('made_up_table', 1);
check('unknown source_type rejected', r2.valid === false, `got valid=${r2.valid}`);

// 3. Non-numeric id — must be rejected.
const r3 = validateSource('notice_event', 'abc');
check('non-numeric id rejected', r3.valid === false, `got valid=${r3.valid}`);

console.log('');
if (failures === 0) {
  console.log('RESULT: PASS');
  process.exit(0);
} else {
  console.log(`RESULT: FAIL (${failures} check(s) failed)`);
  process.exit(1);
}
