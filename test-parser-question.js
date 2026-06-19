/**
 * test-parser-question.js — Verify parser returns intent=query for questions
 */
require('dotenv').config();

const { extractFromText } = require('./src/parser');

async function main() {
  const testCases = [
    { text: 'מה יש היום?', expectIntent: 'query' },
    { text: 'מתי האימון של נבו?', expectIntent: 'query' },
    { text: 'האם יש מחר פגישה?', expectIntent: 'query' },
    { text: 'מחר בשעה 10:00 פגישה עם יוסי', expectIntent: 'event' },  // should NOT be query
  ];

  let passed = 0;
  let failed = 0;

  for (const tc of testCases) {
    console.log(`\nTesting: "${tc.text}"`);
    try {
      const result = await extractFromText(tc.text);
      const ok = result.intent === tc.expectIntent;
      console.log(`  intent=${result.intent} expected=${tc.expectIntent} → ${ok ? 'PASS' : 'FAIL'}`);
      if (!ok) {
        console.log('  events:', JSON.stringify(result.events));
        failed++;
      } else {
        passed++;
      }
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
