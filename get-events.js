require('dotenv').config();
const { initDB } = require('./src/db');
const { getUpcomingEvents } = require('./src/calendar');
const config = require('./src/config');
initDB();

async function run() {
  // Fetch next 48 hours from both calendars
  const [avivEvents, liatEvents] = await Promise.all([
    getUpcomingEvents(config.AVIV_CALENDAR_ID, config.AVIV_TOKEN_PATH, 48),
    getUpcomingEvents(config.LIAT_CALENDAR_ID, config.LIAT_TOKEN_PATH, 48),
  ]);

  // Filter to tomorrow (2026-05-07) and deduplicate by title+start
  const tomorrow = '2026-05-07';
  const seen = new Set();
  const all = [];

  for (const e of avivEvents) {
    const start = (e.start?.dateTime || e.start?.date || '').substring(0,16);
    if (!start.startsWith(tomorrow)) continue;
    const key = e.summary + '|' + start;
    if (!seen.has(key)) { seen.add(key); all.push({ ...e, _owner: 'aviv' }); }
  }
  for (const e of liatEvents) {
    const start = (e.start?.dateTime || e.start?.date || '').substring(0,16);
    if (!start.startsWith(tomorrow)) continue;
    const key = e.summary + '|' + start;
    if (!seen.has(key)) { seen.add(key); all.push({ ...e, _owner: 'liat' }); }
    else {
      // Mark existing as 'both'
      const existing = all.find(x => x.summary + '|' + (x.start?.dateTime || x.start?.date || '').substring(0,16) === key);
      if (existing) existing._owner = 'both';
    }
  }

  all.sort((a,b) => (a.start?.dateTime||a.start?.date||'') < (b.start?.dateTime||b.start?.date||'') ? -1 : 1);

  console.log('Events for tomorrow (2026-05-07):');
  all.forEach(e => {
    const start = e.start?.dateTime || e.start?.date || '';
    const end = e.end?.dateTime || e.end?.date || '';
    const timeStr = start.includes('T')
      ? new Date(start).toLocaleTimeString('he-IL',{timeZone:'Asia/Jerusalem',hour:'2-digit',minute:'2-digit'}) +
        '–' + new Date(end).toLocaleTimeString('he-IL',{timeZone:'Asia/Jerusalem',hour:'2-digit',minute:'2-digit'})
      : 'כל היום';
    console.log(`- ${e.summary} | ${timeStr} | ${e._owner}`);
  });

  if (all.length === 0) console.log('(no events)');
}
run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
