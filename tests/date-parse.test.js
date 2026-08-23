'use strict';

/**
 * Tests for src/date-parse.js
 * Run: node tests/date-parse.test.js
 */

const { parseDate, extractExplicitDate, extractHebrewWeekday } = require('../src/date-parse');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ ${msg}`);
    failed++;
  }
}

function assertEqual(actual, expected, msg) {
  const ok = actual === expected;
  if (ok) {
    console.log(`  ✅ ${msg}: ${actual}`);
    passed++;
  } else {
    console.error(`  ❌ ${msg}: expected '${expected}' got '${actual}'`);
    failed++;
  }
}

console.log('\n=== date-parse.js tests ===\n');

// ── extractExplicitDate ──────────────────────────────────────────────────────

console.log('extractExplicitDate:');
{
  const r = extractExplicitDate('21.8.26');
  assertEqual(r?.iso, '2026-08-21', '21.8.26 → 2026-08-21');
}
{
  const r = extractExplicitDate('21.8.2026');
  assertEqual(r?.iso, '2026-08-21', '21.8.2026 → 2026-08-21');
}
{
  const r = extractExplicitDate('15/9/26');
  assertEqual(r?.iso, '2026-09-15', '15/9/26 → 2026-09-15');
}
{
  const r = extractExplicitDate('no date here');
  assert(r === null, 'no date → null');
}

// ── extractHebrewWeekday ─────────────────────────────────────────────────────

console.log('\nextractHebrewWeekday:');
{
  assertEqual(extractHebrewWeekday('יום שישי'), 5, 'שישי → 5');
  assertEqual(extractHebrewWeekday('יום ראשון'), 0, 'ראשון → 0');
  assertEqual(extractHebrewWeekday('יום שני בשבוע'), 1, 'שני → 1');
  assertEqual(extractHebrewWeekday('חמישי'), 4, 'חמישי → 4');
  assert(extractHebrewWeekday('no hebrew day') === null, 'no weekday → null');
}

// ── parseDate ────────────────────────────────────────────────────────────────

console.log('\nparseDate:');

// Test 1: Explicit date with matching weekday (Aug 21, 2026 is Friday = 5)
{
  const result = parseDate('יום שישי, 21.8.26');
  assert(result !== null, 'T1: result not null');
  assertEqual(result?.iso, '2026-08-21', 'T1: iso');
  assertEqual(result?.weekday_mismatch, false, 'T1: no mismatch');
  assertEqual(result?.inferred_from_weekday, false, 'T1: not inferred');
}

// Test 2: Bug case — שישי (Friday=5) + 22.8.2026 which is Saturday (6) → explicit date wins
{
  const result = parseDate('שישי 22.8.2026');
  assert(result !== null, 'T2: result not null');
  assertEqual(result?.iso, '2026-08-22', 'T2: explicit date wins');
  assertEqual(result?.weekday_mismatch, true, 'T2: mismatch flagged');
  assertEqual(result?.inferred_from_weekday, false, 'T2: not inferred from weekday');
}

// Test 3: Weekday only — infer next occurrence
{
  const result = parseDate('ביום שישי נערך אירוע');
  assert(result !== null, 'T3: result not null');
  assertEqual(result?.inferred_from_weekday, true, 'T3: inferred from weekday');
  assert(result?.weekday_mismatch === false, 'T3: no mismatch');
  if (result) {
    // Verify the inferred date is actually a Friday
    const d = new Date(result.year, result.month - 1, result.day);
    assertEqual(d.getDay(), 5, 'T3: inferred date is Friday (5)');
  }
}

// Test 4: Full date with 4-digit year
{
  const result = parseDate('15/9/2026');
  assertEqual(result?.iso, '2026-09-15', 'T4: 4-digit year');
}

// Test 5: Date without year
{
  const result = parseDate('האירוע ב-15.9');
  assert(result !== null, 'T5: result not null');
  assert(result?.iso.endsWith('-09-15'), 'T5: month/day correct');
  assert(result?.year >= 2026, 'T5: year is reasonable');
}

// Test 6: No date at all
{
  const result = parseDate('שלום לכולם, מה שלומכם?');
  assert(result === null, 'T6: null when no date');
}

// Test 7: Null/empty input
{
  assert(parseDate(null) === null, 'T7: null input → null');
  assert(parseDate('') === null, 'T7: empty string → null');
}

// Test 8: Complex real-world message
{
  const result = parseDate('שלום הורים, מזכירה שמחר שישי 21.8.26 לא יהיה לימודים.');
  assert(result !== null, 'T8: real message parsed');
  assertEqual(result?.iso, '2026-08-21', 'T8: correct date extracted');
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
