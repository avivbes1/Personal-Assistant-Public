require('dotenv').config();
const { initDB } = require('./src/db');
const { addSharedEvent } = require('./src/calendar');
initDB();

async function run() {
  const result = await addSharedEvent({
    title: 'שיעור פרטי - נוגה',
    start_time: '2026-05-08T13:30:00+03:00',
    end_time:   '2026-05-08T14:30:00+03:00',
  }, 'liat');
  console.log('Done:', result ? result.id : 'FAILED');
}
run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
