require('dotenv').config();
const cal = require('./src/calendar');
cal.getUpcomingEvents('avivbes1@gmail.com', './token-aviv.json', 168)
  .then(e => { console.log('OK events:', e.length, JSON.stringify(e.slice(0,2).map(x=>x.summary))); process.exit(0); })
  .catch(e => { console.error('FAIL:', e.message); process.exit(1); });
