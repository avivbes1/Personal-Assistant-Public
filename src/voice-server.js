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
const { MessageMedia } = require('whatsapp-web.js');

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

function startVoiceServer(client, getHealthState) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const state = typeof getHealthState === 'function' ? getHealthState() : { whatsapp_connected: !!(client && client.info) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(state));
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
          const chatId = to.includes('@') ? to : `${to.replace('+', '')}@c.us`;
          await client.sendMessage(chatId, text);
          console.log(`[VoiceServer] Text message sent to ${chatId}`);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
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

        const chatId = to.includes('@') ? to : `${to.replace('+', '')}@c.us`;
        const language = lang || 'en';

        console.log(`[VoiceServer] Generating voice for ${chatId} (${language}): "${text.substring(0, 60)}..."`);

        const oggPath = await generateTTS(text, language);
        const data = fs.readFileSync(oggPath).toString('base64');
        fs.unlink(oggPath, () => {});

        const media = new MessageMedia('audio/ogg; codecs=opus', data, 'voice.ogg');
        await client.sendMessage(chatId, media, { sendMediaAsVoice: true });

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

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[VoiceServer] Listening on localhost:${PORT}`);
  });

  return server;
}

module.exports = { startVoiceServer };
