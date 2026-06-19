/**
 * deliver-batch.js
 * Invoked by OpenClaw cron at 07:00, 12:00, 16:00, 20:00 Israel time.
 * Summarizes and batches pending routine notices to the master group.
 */

const _log = console.log; console.log = () => {};
const { initDB } = require('./src/db');
initDB();
console.log = _log;

const { deliverBatch } = require('./src/noticeDelivery');
const { sendMessage } = require('./lib/voice-client');

const MASTER_GROUP_JID = process.env.MASTER_GROUP_JID || '120363426994367917@g.us';

function sendToMasterGroup(text) {
  return sendMessage(MASTER_GROUP_JID, text);
}

deliverBatch(sendToMasterGroup)
  .then(() => { console.log('[deliver-batch] Done'); process.exit(0); })
  .catch(err => { console.error('[deliver-batch] Error:', err.message); process.exit(1); });
