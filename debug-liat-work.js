require('dotenv').config();
const { getUpcomingEvents, getTodayEvents } = require('./src/calendar');

async function main() {
  const calendarId = process.env.LIAT_WORK_CALENDAR_ID;
  const tokenPath = process.env.LIAT_TOKEN_PATH;
  console.log('Checking:', calendarId, 'with token:', tokenPath);

  try {
    const events = await getUpcomingEvents(calendarId, tokenPath, 72);
    console.log(`Events in next 72h: ${events.length}`);
    events.forEach(e => console.log(' -', e.summary, e.start.dateTime || e.start.date));
  } catch (e) {
    console.error('Error:', e.message);
  }
  process.exit(0);
}
main();
