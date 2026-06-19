require('dotenv').config();
const { answerQuery } = require('./src/query');
answerQuery('מה יש מחר?').then(r => { console.log('RESPONSE:', r.text); process.exit(0); })
  .catch(e => { console.error('FAIL:', e.message); process.exit(1); });
