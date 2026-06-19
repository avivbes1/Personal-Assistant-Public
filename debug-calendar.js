require('dotenv').config();
const { getTodayEvents } = require('./src/calendar');

async function main() {
  // Try Liat with both 'primary' and her email
  try {
    console.log('Liat with primary:');
    const events = await getTodayEvents('primary', process.env.LIAT_TOKEN_PATH);
    console.log('  Events:', events.length);
    events.forEach(e => console.log('  -', e.summary, e.start.dateTime || e.start.date));
  } catch (e) { console.error('  Error:', e.message); }

  try {
    console.log('Liat with email:');
    const events = await getTodayEvents('liat.elm@gmail.com', process.env.LIAT_TOKEN_PATH);
    console.log('  Events:', events.length);
    events.forEach(e => console.log('  -', e.summary, e.start.dateTime || e.start.date));
  } catch (e) { console.error('  Error:', e.message); }

  try {
    console.log('Liat — all upcoming 72h with primary:');
    const { getUpcomingEvents } = require('./src/calendar');
    const events = await getUpcomingEvents('primary', process.env.LIAT_TOKEN_PATH, 72);
    console.log('  Events:', events.length);
    events.forEach(e => console.log('  -', e.summary, e.start.dateTime || e.start.date));
  } catch (e) { console.error('  Error:', e.message); }

  process.exit(0);
}
main();
