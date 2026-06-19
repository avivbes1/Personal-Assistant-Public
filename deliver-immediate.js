/**
 * deliver-immediate.js
 * Invoked by OpenClaw cron every 5 minutes.
 * Sends urgent/time_sensitive notices to the master group immediately.
 */

const _log = console.log; console.log = () => {};
const { initDB } = require('./src/db');
initDB();
console.log = _log;

const { deliverImmediate } = require('./src/noticeDelivery');
const { sendMessage } = require('./lib/voice-client');

const MASTER_GROUP_JID = process.env.MASTER_GROUP_JID || '120363426994367917@g.us';

function sendToMasterGroup(text) {
  return sendMessage(MASTER_GROUP_JID, text);
}

deliverImmediate(sendToMasterGroup)
  .then(() => { console.log('[deliver-immediate] Done'); process.exit(0); })
  .catch(err => { console.error('[deliver-immediate] Error:', err.message); process.exit(1); });
