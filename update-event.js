const { initDB } = require('./src/db');
const { updateCalendarEvent } = require('./src/calendar');
const config = require('./src/config');

initDB();

const EVENT_ID = 'fsr92dvjakm002sdq6s2uijs78';
const patch = {
  start: { dateTime: '2026-05-06T20:00:00+03:00', timeZone: 'Asia/Jerusalem' },
  end:   { dateTime: '2026-05-06T21:00:00+03:00', timeZone: 'Asia/Jerusalem' },
};

async function run() {
  const avivResult = await updateCalendarEvent(config.AVIV_CALENDAR_ID, config.AVIV_TOKEN_PATH, EVENT_ID, patch);
  console.log('Aviv:', avivResult ? avivResult.start.dateTime + ' – ' + avivResult.end.dateTime : 'FAILED');

  // Liat gets the event via invite (attendee), but also update on her calendar
  const liatResult = await updateCalendarEvent(config.LIAT_CALENDAR_ID, config.LIAT_TOKEN_PATH, EVENT_ID, patch);
  console.log('Liat:', liatResult ? liatResult.start.dateTime + ' – ' + liatResult.end.dateTime : 'FAILED (may be invite-only)');
}

run().catch(e => { console.error('Error:', e.message); process.exit(1); });
