/**
 * send-to-group.js — Send a one-off message to the master group
 * Usage: node send-to-group.js "your message"
 */
process.chdir(__dirname);
require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const config = require('./src/config');

const message = process.argv[2];
if (!message) {
  console.error('Usage: node send-to-group.js "message"');
  process.exit(1);
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
  puppeteer: {
    headless: true,
    executablePath: config.CHROMIUM_PATH || '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
});

client.on('ready', async () => {
  console.log('[send-to-group] WhatsApp ready. Searching for master group...');
  const chats = await client.getChats();
  const master = chats.find(c => c.isGroup && c.name === config.MASTER_GROUP_NAME);
  if (!master) {
    console.error('[send-to-group] Master group not found:', config.MASTER_GROUP_NAME);
    process.exit(1);
  }
  await master.sendMessage(message);
  console.log('[send-to-group] Sent to:', master.name);
  setTimeout(() => process.exit(0), 2000);
});

client.on('auth_failure', () => {
  console.error('[send-to-group] Auth failure');
  process.exit(1);
});

client.initialize();
