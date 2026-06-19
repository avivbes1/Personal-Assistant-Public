/**
 * test-query.js — Test query handler with 'מה יש היום?'
 */
require('dotenv').config();

const { initDB } = require('./src/db');
initDB();

const { answerQuery } = require('./src/query');

async function main() {
  console.log('=== Testing query: מה יש היום? ===\n');
  try {
    const result = await answerQuery('מה יש היום?', []);
    console.log('Response text:\n', result.text);
    console.log('\nAction:', result.action);
    console.log('\n--- PASS: Got a response ---');
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
  }
}

main();
