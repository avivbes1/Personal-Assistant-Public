'use strict';

/**
 * voice-server.js — Local HTTP server for sending WhatsApp voice messages.
 * Listens on localhost:3001
 * POST /voice { "to": "+15551234567", "text": "...", "lang": "en" }
 */

const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
// MessageMedia compatibility — works with both whatsapp-web.js and Baileys adapter
class MessageMedia {
  constructor(mimetype, data, filename) {
    this.mimetype = mimetype;
    this.data = data;
    this.filename = filename;
  }
}

const PORT = 3001;

const VOICES = {
  en: 'en-US-AndrewNeural',
  he: 'he-IL-AvriNeural',
};

function generateTTS(text, lang) {
  return new Promise((resolve, reject) => {
    const voice = VOICES[lang] || VOICES.en;
    const base = path.join(os.tmpdir(), `lipa_voice_${Date.now()}`);
    const tmpTxt = base + '.txt';
    const tmpMp3 = base + '.mp3';
    const tmpOgg = base + '.ogg';

    // Write text to file to avoid shell quoting issues
    fs.writeFileSync(tmpTxt, text, 'utf8');

    const tmpPy = base + '.py';
    const script = [
      'import asyncio, edge_tts',
      `text = open(${JSON.stringify(tmpTxt)}, encoding='utf-8').read()`,
      'async def main():',
      `    tts = edge_tts.Communicate(text, voice=${JSON.stringify(voice)})`,
      `    await tts.save(${JSON.stringify(tmpMp3)})`,
      'asyncio.run(main())',
    ].join('\n');
    fs.writeFileSync(tmpPy, script, 'utf8');

    exec(`python3 ${JSON.stringify(tmpPy)}`, (err) => {
      fs.unlink(tmpPy, () => {});
      fs.unlink(tmpTxt, () => {});
      if (err) return reject(new Error('TTS failed: ' + err.message));

      // Convert mp3 → ogg/opus (WhatsApp voice format)
      exec(`ffmpeg -i ${JSON.stringify(tmpMp3)} -c:a libopus -b:a 32k ${JSON.stringify(tmpOgg)} -y`, (err2) => {
        fs.unlink(tmpMp3, () => {});
        if (err2) return reject(new Error('ffmpeg failed: ' + err2.message));
        resolve(tmpOgg);
      });
    });
  });
}

// ── Module-level state ──────────────────────────────────────────────────────
// The HTTP server binds to the port immediately on module load (see bottom of
// file) — BEFORE WhatsApp connects. whatsapp.js later calls setClient() from
// its ready handler to wire in the real client. Until then the health endpoint
// reports an "initializing" state, and any endpoint needing the client returns
// 503. This guarantees the health endpoint is reachable during startup, so a
// crash before WhatsApp connects is still observable.
let _client = null;
let _getHealthState = null;
const _initErrors = [];

/**
 * Wire in the real WhatsApp client + health state accessor.
 * Called by whatsapp.js from the 'ready' handler.
 */
function setClient(client, getHealthState) {
  _client = client || null;
  if (typeof getHealthState === 'function') _getHealthState = getHealthState;
  console.log('[VoiceServer] Client wired in — reporting live health state.');
}

/**
 * Record an initialization error so it surfaces in the /health response.
 * whatsapp.js pushes errors here (client.initialize failure, resolveMasterGroup
 * failure, etc.) so Lipa can see them even when WhatsApp never connects.
 */
function addInitError(err) {
  const message = err && err.message ? err.message : String(err);
  _initErrors.push({ ts: Date.now(), message });
  // Keep the array bounded — only the most recent 20 errors matter.
  if (_initErrors.length > 20) _initErrors.shift();
}

function buildHealthPayload() {
  let payload;
  if (typeof _getHealthState === 'function') {
    const state = _getHealthState();
    payload = { status: state.whatsapp_connected ? 'ready' : 'initializing', ...state };
  } else {
    payload = {
      status: 'initializing',
      whatsapp_connected: false,
      uptime_s: Math.round(process.uptime()),
    };
  }
  payload.init_errors = _initErrors;
  try {
    const { getMessagesPersisted5Min } = require('./message-counter');
    payload.messagesPersistedLast5Min = getMessagesPersisted5Min();
  } catch (_) {}
  // OpenClaw channel status
  try {
    const { checkOpenClawChannel } = require('./health');
    const chStatus = checkOpenClawChannel();
    payload.openclaw_channel = {
      ok: chStatus.ok,
      ...(chStatus.details || {}),
      ...(chStatus.error ? { error: chStatus.error } : {}),
    };
  } catch (_) {
    payload.openclaw_channel = { ok: null, error: 'check unavailable' };
  }
  return payload;
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(buildHealthPayload()));
    }

    // ISSUE-019: Pipeline health endpoint for Lipa supervision
    if (req.method === 'GET' && req.url === '/health/pipeline') {
      try {
        const { getDB } = require('./db');
        const db = getDB();
        const stuck = db.prepare(
          "SELECT id, group_id, processing_started_at FROM messages WHERE pipeline_state='PROCESSING' AND processing_started_at < ?"
        ).all(Date.now() - 5 * 60 * 1000);
        const hourStats = db.prepare(
          "SELECT pipeline_state, COUNT(*) as cnt FROM messages WHERE timestamp > ? GROUP BY pipeline_state"
        ).all(Date.now() - 3600000);
        const byState = {};
        for (const r of hourStats) byState[r.pipeline_state] = r.cnt;
        const total = Object.values(byState).reduce((s, v) => s + v, 0);
        const failed = byState['FAILED'] || 0;
        const failRate = total > 0 ? ((failed / total) * 100).toFixed(1) : '0.0';
        let profileHealth = { status: 'unknown' };
        try { profileHealth = require('./family-context').getProfileHealth(); } catch (_) {}
        const payload = {
          status: stuck.length === 0 && parseFloat(failRate) < 20 && profileHealth.status !== 'stale' ? 'healthy' : 'degraded',
          stuck_messages: stuck.length,
          hour_stats: byState,
          failure_rate_percent: failRate,
          total_messages_1h: total,
          family_profile: profileHealth,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(payload));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // ISSUE-019: Config propose endpoint for Lipa autonomous fixes
    if (req.method === 'POST' && req.url === '/config/propose') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { key, newValue, reason, proposedBy } = JSON.parse(body);
          const { setConfigValue } = require('./db');
          const result = setConfigValue(key, newValue, reason, proposedBy || 'lipa');
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: result.error }));
          }
          console.log(`[VoiceServer] Config change: ${key} ${result.oldValue} → ${result.newValue} (${reason})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // GET /chat-history?jid=<phone>@c.us&limit=30
    // Returns last N messages. Tries fetchMessages() first; falls back to
    // the local dm-history.jsonl log when Puppeteer page eval is broken.
    if (req.method === 'GET' && req.url.startsWith('/chat-history')) {
      try {
        const urlObj = new URL(req.url, 'http://localhost');
        const defaultJid = process.env.AVIV_PHONE ? `${process.env.AVIV_PHONE}@c.us` : null;
        const jid = urlObj.searchParams.get('jid') || defaultJid;
        const limit = Math.min(parseInt(urlObj.searchParams.get('limit') || '30', 10), 100);

        // Try live fetchMessages first
        if (_client) {
          try {
            const chat = await _client.getChatById(jid);
            if (chat) {
              const messages = await chat.fetchMessages({ limit });
              const result = messages.map(m => ({
                id: m.id._serialized,
                ts: m.timestamp * 1000,
                from: m.fromMe ? 'bot' : (m.author || m.from),
                body: m.body,
                type: m.type,
                fromMe: m.fromMe,
              }));
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ ok: true, jid, count: result.length, messages: result, source: 'live' }));
            }
          } catch (_liveErr) {
            // fall through to log file
          }
        }

        // Fallback: read from dm-history.jsonl
        const histPath = require('path').join(__dirname, '../data/dm-history.jsonl');
        let lines = [];
        try {
          const content = require('fs').readFileSync(histPath, 'utf8');
          lines = content.split('\n').filter(Boolean).map(l => {
            try { return JSON.parse(l); } catch { return null; }
          }).filter(Boolean);
        } catch (_) {}
        // Filter by jid — resolve LID to phone via getPhoneByJid, then match
        const { getPhoneByJid } = require('./babysitter-onboarding');
        // Resolve the query JID to a phone number if it's a LID
        let queryPhone = null;
        if (jid.endsWith('@lid')) {
          try { queryPhone = await getPhoneByJid(jid); } catch (_) {}
        }
        const jidUser = jid.replace(/@(c\.us|lid|s\.whatsapp\.net)$/g, '').replace(/\+/g, '');
        const queryPhoneNorm = queryPhone ? queryPhone.replace(/\D/g, '') : null;
        const filtered = lines.filter(m => {
          const mJid = (m.jid || '').replace(/@(c\.us|lid|s\.whatsapp\.net)$/g, '').replace(/\+/g, '');
          const mPhone = (m.phone || '').replace(/\D/g, '');
          // Match by: direct JID user part, resolved phone, stored phone field, or outbound
          if (m.fromMe) return true;
          if (mJid === jidUser) return true;
          if (queryPhoneNorm && (mPhone === queryPhoneNorm || mJid === queryPhoneNorm)) return true;
          return false;
        });
        const result = filtered.slice(-limit).map(m => ({
          ts: m.ts || m.logged,
          from: m.fromMe ? 'bot' : (m.phone || m.jid),
          body: m.body || '',
          type: m.type || 'chat',
          fromMe: m.fromMe,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, jid, count: result.length, messages: result, source: 'log' }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/send-message') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body);
          const { to, text } = parsed;
          if (!to || !text) {
            res.writeHead(400);
            return res.end(JSON.stringify({
              error: 'Missing required fields',
              received: Object.keys(parsed),
              required: ['to', 'text']
            }));
          }
          if (!_client) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'WhatsApp client not ready' }));
          }
          const chatId = to.includes('@') ? to : `${to.replace('+', '')}@c.us`;
          const sentMsg = await _client.sendMessage(chatId, text);
          const msgId = sentMsg && sentMsg.id ? sentMsg.id._serialized : null;
          console.log(`[VoiceServer] Text message sent to ${chatId}${msgId ? ' (id: ' + msgId.substring(0, 40) + ')' : ''}`);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, msgId }));
        } catch (err) {
          console.error('[VoiceServer] send-message error:', err.message);
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/voice') {
      res.writeHead(404);
      return res.end('Not found');
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { to, text, lang } = JSON.parse(body);
        if (!to || !text) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'Missing to or text' }));
        }
        if (!_client) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'WhatsApp client not ready' }));
        }

        const chatId = to.includes('@') ? to : `${to.replace('+', '')}@c.us`;
        const language = lang || 'en';

        console.log(`[VoiceServer] Generating voice for ${chatId} (${language}): "${text.substring(0, 60)}..."`);

        const oggPath = await generateTTS(text, language);
        const data = fs.readFileSync(oggPath).toString('base64');
        fs.unlink(oggPath, () => {});

        const media = new MessageMedia('audio/ogg; codecs=opus', data, 'voice.ogg');
        await _client.sendMessage(chatId, media, { sendAudioAsVoice: true });

        console.log(`[VoiceServer] Voice sent to ${chatId}`);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('[VoiceServer] Error:', err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  return server;
}

// ── Start the server immediately on module load ─────────────────────────────
// Binds to port 3001 before WhatsApp connects, so /health is reachable during
// startup and reports { status: 'initializing', whatsapp_connected: false }.
let _server = null;

function startServer() {
  if (_server) return _server;
  _server = createServer();
  _server.on('error', (err) => {
    console.error(`[VoiceServer] Server error on port ${PORT}:`, err.message);
  });
  _server.listen(PORT, '127.0.0.1', () => {
    console.log(`[VoiceServer] Listening on localhost:${PORT} (initializing — client not yet wired)`);
  });
  return _server;
}

startServer();

/**
 * Backward-compatible entry point. Older code called startVoiceServer(client,
 * getHealthState) from the ready handler; that now just wires the client into
 * the already-running server.
 */
function startVoiceServer(client, getHealthState) {
  setClient(client, getHealthState);
  return _server;
}

module.exports = { startVoiceServer, setClient, addInitError };
