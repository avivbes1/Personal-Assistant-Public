process.chdir(__dirname);
require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const { google } = require('googleapis');
const fs = require('fs');
const config = require('./src/config');

async function getEventsForDate(calendarId, tokenPath, date) {
  const creds = JSON.parse(fs.readFileSync(config.GOOGLE_CREDENTIALS_PATH));
  const { client_id, client_secret } = creds.installed;
  const auth = new google.auth.OAuth2(client_id, client_secret);
  auth.setCredentials(JSON.parse(fs.readFileSync(tokenPath)));
  const calendar = google.calendar({ version: 'v3', auth });
  const startOfDay = new Date(date); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date); endOfDay.setHours(23, 59, 59, 999);
  const res = await calendar.events.list({ calendarId, timeMin: startOfDay.toISOString(), timeMax: endOfDay.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 20 });
  return res.data.items || [];
}

function mergeEvents(eventSources) {
  const map = new Map();
  for (const { events, owner } of eventSources) {
    for (const e of events) {
      const start = e.start?.dateTime || e.start?.date || '';
      const key = `${(e.summary || '').trim()}|${start.substring(0, 16)}`;
      if (!map.has(key)) {
        const timeStr = e.start?.dateTime
          ? new Date(e.start.dateTime).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: config.TIMEZONE })
          : 'כל היום';
        map.set(key, { summary: e.summary || 'אירוע', timeStr, sortKey: start, owners: [] });
      }
      const entry = map.get(key);
      if (!entry.owners.includes(owner)) entry.owners.push(owner);
    }
  }
  return [...map.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}

async function main() {
  const targetDate = new Date('2026-05-05T00:00:00+03:00');
  const [avivEvents, liatEvents, liatWorkEvents] = await Promise.all([
    getEventsForDate(config.AVIV_CALENDAR_ID, config.AVIV_TOKEN_PATH, targetDate),
    getEventsForDate(config.LIAT_CALENDAR_ID, config.LIAT_TOKEN_PATH, targetDate),
    config.LIAT_WORK_CALENDAR_ID ? getEventsForDate(config.LIAT_WORK_CALENDAR_ID, config.LIAT_TOKEN_PATH, targetDate) : [],
  ]);

  const merged = mergeEvents([
    { events: avivEvents, owner: 'אביב' },
    { events: liatEvents, owner: 'ליאת' },
    { events: liatWorkEvents, owner: 'ליאת - עבודה' },
  ]);

  const buckets = { both: [], aviv: [], liat: [] };
  merged.forEach(e => {
    const hasAviv = e.owners.includes('אביב');
    const hasLiat = e.owners.some(o => o.startsWith('ליאת'));
    if (hasAviv && hasLiat) buckets.both.push(e);
    else if (hasAviv) buckets.aviv.push(e);
    else buckets.liat.push(e);
  });
  const fmt = e => `• ${e.timeStr} — ${e.summary}\n`;

  let msg = `🌅 *דייג'סט בוקר — יום שני, 5 במאי 2026*\n\n`;
  if (buckets.both.length) { msg += `👫 *ליאת ואביב:*\n`; buckets.both.forEach(e => { msg += fmt(e); }); msg += '\n'; }
  if (buckets.aviv.length) { msg += `👤 *אביב:*\n`; buckets.aviv.forEach(e => { msg += fmt(e); }); msg += '\n'; }
  if (buckets.liat.length) { msg += `👤 *ליאת:*\n`; buckets.liat.forEach(e => { msg += fmt(e); }); msg += '\n'; }
  if (merged.length === 0) msg += '  (אין אירועים)\n';

  console.log('[digest]\n' + msg);

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
    puppeteer: { headless: true, executablePath: '/usr/bin/chromium-browser', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] },
  });
  client.on('ready', async () => {
    const chats = await client.getChats();
    const master = chats.find(c => c.isGroup && c.name === config.MASTER_GROUP_NAME);
    if (!master) { console.error('Master group not found'); process.exit(1); }
    await master.sendMessage(msg);
    console.log('[digest] Sent.');
    setTimeout(() => process.exit(0), 3000);
  });
  client.initialize();
}
main().catch(err => { console.error(err); process.exit(1); });
