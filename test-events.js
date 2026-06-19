require('dotenv').config();
const cal = require('./src/calendar');
const config = require('./src/config');
cal.getUpcomingEvents(config.AVIV_CALENDAR_ID, config.AVIV_TOKEN_PATH, 168)
  .then(events => {
    console.log('Aviv events (' + events.length + '):');
    events.forEach(e => console.log(' -', e.start?.dateTime || e.start?.date, '|', e.summary));
    process.exit(0);
  }).catch(e => { console.error('FAIL:', e.message); process.exit(1); });
