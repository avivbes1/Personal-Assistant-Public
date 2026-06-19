const { initDB } = require('./src/db');
const { addSharedEvent } = require('./src/calendar');

initDB();

const event = {
  title: 'שיעורי בית - שגב',
  start_time: '2026-05-06T19:30:00+03:00',
  end_time:   '2026-05-06T20:30:00+03:00',
};

async function run() {
  console.log('Adding event:', event.title);
  const result = await addSharedEvent(event, 'both');
  console.log('Done:', JSON.stringify(result, null, 2));
}

run().catch(e => { console.error('Error:', e.message); process.exit(1); });
