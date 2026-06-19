/**
 * send-pending.js
 * 1. Re-asks about the unconfigured group "גיל הרך - הורים"
 * 2. Sends a demo follow-up for the 7:30 task so Aviv can test כן/לא
 */
require('dotenv').config();
const config = require('./src/config');
const { initDB, saveFollowUp, claimFollowUp, setFollowUpBotMsgId } = require('./src/db');
const { Client, LocalAuth } = require('whatsapp-web.js');

initDB();

const UNCONFIGURED_GROUP_ID = '120363304480461484@g.us';
const UNCONFIGURED_GROUP_NAME = 'גיל הרך - הורים';

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
  puppeteer: {
    headless: true,
    executablePath: config.CHROMIUM_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
});

// Track pending group question so reply works
const pendingGroupQuestions = new Map();

client.on('ready', async () => {
  try {
    const chats = await client.getChats();
    const masterChat = chats.find(c => c.isGroup && c.name === config.MASTER_GROUP_NAME);
    if (!masterChat) { console.error('Master group not found'); process.exit(1); }
    const masterGroupId = masterChat.id._serialized;

    // ── 1. Re-send group question ────────────────────────────────────────────
    const groupQuestion = `🆕 נוספתי לקבוצה: *${UNCONFIGURED_GROUP_NAME}*\nלמי הקבוצה קשורה? מעוניינים במעקב? (ענו בתגובה להודעה זו)`;
    const groupMsg = await client.sendMessage(masterGroupId, groupQuestion);
    // Write the pending map entry to a temp file so the bot can pick it up (or just note the msg ID)
    console.log(`Group question sent. Msg ID: ${groupMsg.id._serialized}`);
    console.log(`→ Reply to that message with who the group belongs to.`);

    await new Promise(r => setTimeout(r, 1500));

    // ── 2. Send demo follow-up ────────────────────────────────────────────────
    const avivId = `${config.AVIV_PHONE}@c.us`;
    const liatId = `${config.LIAT_PHONE}@c.us`;
    const title = 'להביא טיפות פנסטיל למשפחת בן טולילה';
    const followUpText = `@אביב @ליאת 👀 ביצעת את: *${title}*?\nענה כן / לא`;

    const dbId = saveFollowUp({
      event_id: 'demo2-' + Date.now(),
      event_title: title,
      event_start: '2026-05-04T07:30:00+03:00',
      owner: 'both',
      ask_at: new Date().toISOString(),
    });
    claimFollowUp(dbId);

    const fuMsg = await masterChat.sendMessage(followUpText, { mentions: [avivId, liatId] });
    setFollowUpBotMsgId(dbId, fuMsg.id._serialized);
    console.log(`Follow-up sent. Msg ID: ${fuMsg.id._serialized}`);
    console.log(`→ Reply כן or לא to that message to test the flow.`);

    setTimeout(() => process.exit(0), 2000);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
});

client.on('auth_failure', () => { console.error('Auth failed'); process.exit(1); });
client.initialize();
