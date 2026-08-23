/**
 * deliver-immediate.js
 * Invoked by OpenClaw cron every 5 minutes.
 * Sends urgent/time_sensitive notices to the master group immediately.
 */

const http = require('http');
const _log = console.log; console.log = () => {};
const { initDB } = require('./src/db');
initDB();
console.log = _log;

const { deliverImmediate } = require('./src/noticeDelivery');

const MASTER_GROUP_JID = process.env.MASTER_GROUP_JID || '120363426994367917@g.us';

function sendToMasterGroup(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ to: MASTER_GROUP_JID, text });
    const req = http.request({
      hostname: 'localhost', port: 3001, path: '/send-message',
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(JSON.parse(data));
        else reject(new Error(`send-message returned ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('send-message timeout')); });
    req.end(body);
  });
}

deliverImmediate(sendToMasterGroup)
  .then(() => { console.log('[deliver-immediate] Done'); process.exit(0); })
  .catch(err => { console.error('[deliver-immediate] Error:', err.message); process.exit(1); });
