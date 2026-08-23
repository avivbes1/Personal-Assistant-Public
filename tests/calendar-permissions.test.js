'use strict';

/**
 * Regression tests for the calendar-permission hallucination incident.
 * Run: node tests/calendar-permissions.test.js
 *
 * Covers:
 *   1. extractActionBlocks pulls a delete_event JSON block out of LLM text
 *   2. response-guard flags capability-contradiction phrasing (HE + EN)
 *   3. response-guard does NOT flag legitimate responses
 *   4. phantom-confirmation detection logic (claimed success, no action block)
 */

const assert = require('assert');
const { extractActionBlocks } = require('../src/agent');
const { checkResponse } = require('../src/response-guard');

let passed = 0;
let failed = 0;

function check(cond, msg) {
  if (cond) { console.log(`  ✅ ${msg}`); passed++; }
  else { console.error(`  ❌ ${msg}`); failed++; }
}

console.log('\n=== calendar-permissions.test.js ===\n');

// ── 1. extractActionBlocks ────────────────────────────────────────────────────
console.log('extractActionBlocks:');
{
  const text = 'סבבה, מבטל את האירוע.\n{"action":"delete_event","search_title":"טורניר כדורגל"}';
  const blocks = extractActionBlocks(text);
  check(blocks.length === 1, 'extracts exactly one block from delete_event response');
  check(blocks[0].json.action === 'delete_event', 'action is delete_event');
  check(blocks[0].json.search_title === 'טורניר כדורגל', 'search_title parsed correctly');
}
{
  // nested object should still be extracted as a single block
  const text = 'מעדכן.\n{"action":"update_event","search_title":"אימון","changes":{"start_time":"2026-09-01T17:00:00"}}';
  const blocks = extractActionBlocks(text);
  check(blocks.length === 1, 'extracts a block with a nested changes object');
  check(blocks[0].json.changes && blocks[0].json.changes.start_time === '2026-09-01T17:00:00', 'nested change parsed');
}
{
  // no action block → empty
  const text = 'האירוע נמחק ✅'; // phantom confirmation, but no JSON
  const blocks = extractActionBlocks(text);
  check(blocks.length === 0, 'returns no blocks when text has no JSON action');
}

// ── 2. response-guard catches contradictions ──────────────────────────────────
console.log('\nresponse-guard (should flag):');
{
  const cases = [
    'I only have readonly access to the calendar.',
    'The calendar is read-only for me.',
    'אין לי הרשאות למחוק אירועים ביומן.',
    'אין לי גישה ליומן של ליאת.',
    'תמחק את זה ידנית בבקשה.',
    'צריך למחוק את זה ידנית.',
    "Sorry, I can't delete calendar events.",
    'You will need to delete it manually.',
    'הגישה שלי היא לקריאה בלבד.',
  ];
  for (const c of cases) {
    const r = checkResponse(c);
    check(r && r.flagged === true, `flags: "${c.substring(0, 40)}" (pattern=${r && r.pattern})`);
  }
}

// ── 3. response-guard does NOT flag legitimate responses ──────────────────────
console.log('\nresponse-guard (should NOT flag):');
{
  const cases = [
    'מחקתי את האירוע מהיומן ✅',
    'הוספתי את טורניר הכדורגל ליום ראשון.',
    'עדכנתי את השעה ל-17:00.',
    'האירוע כבר קיים ביומן, לא הוספתי כפילות.',
    'I added the event to both calendars.',
    'מתי האירוע? לא מצאתי אותו בהודעות.',
  ];
  for (const c of cases) {
    const r = checkResponse(c);
    check(r && r.flagged === false, `clean: "${c.substring(0, 40)}"`);
  }
  // invalid input
  check(checkResponse('') === null, 'returns null for empty string');
  check(checkResponse(null) === null, 'returns null for null');
}

// ── 4. phantom-confirmation detection logic ───────────────────────────────────
// Mirrors the CONFIRMATION_PATTERNS check in handleMessage (agent.js).
// Phantom = text claims success AND zero action blocks were extracted.
console.log('\nphantom-confirmation detection:');
{
  const CONFIRMATION_PATTERNS = /✅|נמחק|בוצע|מחקתי|עודכן|עדכנתי|נוסף|הוספתי|\bdeleted\b|\bupdated\b|\bdone\b/i;
  const isPhantom = (text) => extractActionBlocks(text).length === 0 && CONFIRMATION_PATTERNS.test(text);

  check(isPhantom('מחקתי את האירוע ✅') === true, 'phantom: claims deletion, no action block');
  check(isPhantom('Deleted the event.') === true, 'phantom: English "deleted", no action block');
  check(
    isPhantom('מחקתי את האירוע ✅\n{"action":"delete_event","search_title":"טורניר"}') === false,
    'not phantom: confirmation WITH a delete_event block'
  );
  check(isPhantom('מתי האירוע?') === false, 'not phantom: a plain question');
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
