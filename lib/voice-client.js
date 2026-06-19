/**
 * voice-client.js
 * Single shared client for the voice server HTTP API.
 * Contract: POST /send-message { to: string, text: string } → { ok: boolean, error?: string }
 *
 * All delivery scripts must use this module — never construct raw HTTP calls to the voice server.
 */

const http = require('http');

const VOICE_SERVER_URL = process.env.VOICE_SERVER_URL || 'http://localhost:3001';
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Send a text message to a WhatsApp JID or phone number via the local voice server.
 * @param {string} to  - WhatsApp JID (e.g. "120363...@g.us") or E.164 number ("+972...")
 * @param {string} text - Message body
 * @returns {Promise<void>} Resolves on success, rejects with Error on failure
 */
function sendMessage(to, text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ to, text });
    const url = new URL(VOICE_SERVER_URL + '/send-message');

    const req = http.request({
      host: url.hostname,
      port: url.port || 3001,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const r = JSON.parse(body);
          if (r.ok || r.success) {
            resolve();
          } else {
            reject(new Error(r.error || `Voice server returned status ${res.statusCode}`));
          }
        } catch {
          // Non-JSON response — treat 2xx as success
          if (res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`Voice server returned non-JSON status ${res.statusCode}`));
        }
      });
    });

    req.setTimeout(DEFAULT_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error('Voice server request timed out'));
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { sendMessage };
