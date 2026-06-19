require('dotenv').config();
const { initDB } = require('./src/db');
initDB();

// Monkey-patch to expose buildContext
const queryModule = require('./src/query');

// Run a test query and log the context
async function main() {
  try {
    const answer = await queryModule.answerQuery('אילו קבוצות אתה עוקב אחריהן?', []);
    console.log('\n=== BOT ANSWER ===\n', answer);
  } catch (e) {
    console.error('Error:', e.message, e.stack);
  }
}

main();
