require('dotenv').config();
const cal = require('./src/calendar');
const config = require('./src/config');
Promise.all([
  cal.getUpcomingEvents(config.LIAT_CALENDAR_ID, config.LIAT_TOKEN_PATH, 168),
  config.LIAT_WORK_CALENDAR_ID ? cal.getUpcomingEvents(config.LIAT_WORK_CALENDAR_ID, config.LIAT_TOKEN_PATH, 168) : Promise.resolve([])
]).then(([personal, work]) => {
  console.log('Liat personal (' + personal.length + '):');
  personal.forEach(e => console.log(' -', e.start?.dateTime || e.start?.date, '|', e.summary));
  console.log('Liat work (' + work.length + '):');
  work.forEach(e => console.log(' -', e.start?.dateTime || e.start?.date, '|', e.summary));
  process.exit(0);
}).catch(e => { console.error('FAIL:', e.message); process.exit(1); });
