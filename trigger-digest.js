/**
 * One-shot script: send morning digest to master group, then exit.
 * Run with: node trigger-digest.js
 */
process.chdir(__dirname);
require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const { initDB } = require('./src/db');
const { sendMorningDigest, initScheduler } = require('./src/scheduler');

initDB();

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
  puppeteer: {
    headless: true,
    executablePath: '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
});

client.on('ready', async () => {
  console.log('[trigger-digest] WhatsApp ready. Sending digest...');

  initScheduler(async (msg) => {
    const chats = await client.getChats();
    const master = chats.find(c => c.isGroup && c.name === process.env.MASTER_GROUP_NAME);
    if (!master) {
      console.error('[trigger-digest] Master group not found:', process.env.MASTER_GROUP_NAME);
      process.exit(1);
    }
    await master.sendMessage(msg);
    console.log('[trigger-digest] Digest sent to:', master.name);
  });

  await sendMorningDigest();
  setTimeout(() => process.exit(0), 3000);
});

client.on('auth_failure', () => {
  console.error('[trigger-digest] Auth failed.');
  process.exit(1);
});

client.initialize();
