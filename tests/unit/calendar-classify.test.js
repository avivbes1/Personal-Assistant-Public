'use strict';

/**
 * Tests for classifyEvent() / EVENT_PATTERNS in src/calendar-bridge.js (K2).
 *
 * Snippets are drawn from real notice content in the WhatsApp groups. Each
 * asserts the expected event_type (or null when the content is not
 * calendar-worthy). Covers every pattern type plus a few negatives.
 *
 * Run standalone:  node tests/unit/calendar-classify.test.js
 * Or via the suite: node tests/run-all.js
 */

const { classifyEvent } = require('../../src/calendar-bridge');

// [snippet, expected event_type|null, label]
const CASES = [
  // meeting — the motivating gap (אסיפת הורים was previously unclassified)
  ["אסיפת הורים ד' 9.9.2026 בשעה 19:00", 'meeting', 'parent assembly'],
  ['ערב הורים לכיתה ב', 'meeting', 'parents evening'],
  ['מפגש הורים בגן ביום ראשון', 'meeting', 'parents meetup'],
  // ceremony
  ['טקס פתיחת שנת הלימודים', 'ceremony', 'opening ceremony'],
  ['הצגת סיום של שכבת ו', 'ceremony', 'end-of-year show'],
  ['בר מצווה של יונתן', 'ceremony', 'bar mitzvah'],
  // class / training
  ['אימון כדורגל ביום שלישי', 'class', 'football practice'],
  ['חוג רובוטיקה מתחיל השבוע', 'class', 'robotics club'],
  ['סדנת יצירה לילדים', 'class', 'craft workshop'],
  // holiday
  ['חופשת סוכות מתחילה ב-6.10', 'holiday', 'sukkot break'],
  ['ביום כיפור הגן סגור', 'holiday', 'yom kippur'],
  ['מסיבת חנוכה בגן', 'holiday', 'hanukkah party'],
  // birthday
  ['יום הולדת ליה ביום חמישי', 'birthday', 'birthday'],
  // exam
  ['מבחן במתמטיקה ביום שני', 'exam', 'math exam'],
  ['בחינת בגרות באנגלית', 'exam', 'bagrut'],
  // health
  ['חיסון שפעת יינתן בבית הספר', 'health', 'flu shot'],
  ['בדיקת שיניים לכיתות א', 'health', 'dental check'],
  // deadline
  ['הרשמה עד 15.9 לצהרון', 'deadline', 'registration deadline'],
  ['תשלום עד סוף החודש', 'deadline', 'payment deadline'],
  // trip
  ['טיול שנתי לצפון', 'trip', 'annual trip'],
  // appointment
  ['פגישה עם היועצת', 'appointment', 'counselor meeting'],
  // negatives — not calendar-worthy
  ['שיחת חולין על מזג האוויר', null, 'small talk'],
  ['תודה רבה לכולם על העזרה', null, 'thanks'],
  ['מישהו יודע מתי מגיע האוטובוס?', null, 'idle question'],
];

let passed = 0;
let failed = 0;
const failures = [];

for (const [snippet, expected, label] of CASES) {
  const actual = classifyEvent(snippet);
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    failures.push(`${label}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)} — "${snippet}"`);
  }
}

function run() {
  return failed === 0
    ? { pass: true, message: `calendar-classify: ${passed}/${CASES.length} snippets classified correctly` }
    : { pass: false, message: `calendar-classify: ${failed} wrong:\n  ${failures.join('\n  ')}` };
}

module.exports = { run };

// Standalone execution
if (require.main === module) {
  console.log('\n=== calendar-classify.test.js ===\n');
  for (const [snippet, expected, label] of CASES) {
    const actual = classifyEvent(snippet);
    const ok = actual === expected;
    console.log(`  ${ok ? '✅' : '❌'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
  }
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}
