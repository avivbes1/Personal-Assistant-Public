/**
 * trigger-followup.js — manually fire a demo follow-up message to the master group.
 * Usage: node trigger-followup.js
 */
require('dotenv').config();
const config = require('./src/config');
const { initDB, saveFollowUp, claimFollowUp, setFollowUpBotMsgId } = require('./src/db');
const { Client, LocalAuth } = require('whatsapp-web.js');

initDB();

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
  puppeteer: {
    headless: true,
    executablePath: config.CHROMIUM_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
});

client.on('ready', async () => {
  try {
    const chats = await client.getChats();
    const masterChat = chats.find(c => c.isGroup && c.name === config.MASTER_GROUP_NAME);
    if (!masterChat) { console.error('Master group not found'); process.exit(1); }

    const avivId = `${config.AVIV_PHONE}@c.us`;
    const liatId = `${config.LIAT_PHONE}@c.us`;

    const title = 'להביא טיפות פנסטיל למשפחת בן טולילה';
    const msg = `@אביב @ליאת 👀 ביצעת את: *${title}*?\nענה כן / לא`;

    // Save a demo follow-up to DB so replies can be tracked
    const dbId = saveFollowUp({
      event_id: 'demo-' + Date.now(),
      event_title: title,
      event_start: '2026-05-04T07:30:00+03:00',
      owner: 'both',
      ask_at: new Date().toISOString(),
    });
    claimFollowUp(dbId);

    const sentMsg = await masterChat.sendMessage(msg, { mentions: [avivId, liatId] });
    setFollowUpBotMsgId(dbId, sentMsg.id._serialized);
    console.log('Follow-up sent! Message ID:', sentMsg.id._serialized);
    console.log('Reply "כן" or "לא" to that message in the master group to test the flow.');

    setTimeout(() => process.exit(0), 2000);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
});

client.on('auth_failure', () => { console.error('Auth failed'); process.exit(1); });
client.initialize();
