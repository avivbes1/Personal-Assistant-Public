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

// Defaults to 3001 (prod). Overridable via env for isolated/test instances so a
// throwaway server can bind a spare port without colliding with the live bot.
const PORT = parseInt(process.env.VOICE_SERVER_PORT, 10) || 3001;

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
  // A1: surface the resolved host timezone so a UTC drift is observable via /health.
  payload.resolved_timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const { getMessagesPersisted5Min } = require('./message-counter');
    payload.messagesPersistedLast5Min = getMessagesPersisted5Min();
  } catch (_) {}
  // OpenClaw channel status — served from the cached result of the periodic
  // health monitor's check (runChecks), so /health never shells out per request.
  try {
    const { getLastOpenClawChannelResult } = require('./health');
    const chStatus = getLastOpenClawChannelResult();
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

// ── Q1/Q3: Notices query path ────────────────────────────────────────────────
// Shared search cascade used by both /api/notices/search and /api/notices/lookup:
// try the date-bounded "upcoming" window first, fall back to a wider content
// search when that yields nothing. Returns { results (≤20), matched_via }.
//
// A2: from/to are optional date bounds passed straight through to findUpcoming's
// first leg. The cascade runs even when no query is given — an empty date window
// still falls back to findByContent — so callers that hand us only a date range
// never get a bare no-fallback lookup.
function noticeSearch({ q, child, days, from, to } = {}) {
  const { NoticeRepository } = require('./notices/repository');
  const repo = new NoticeRepository();
  let results = repo.findUpcoming({ searchText: q || null, childName: child || null, from, to });
  let matched_via = 'upcoming';
  if (!results || results.length === 0) {
    results = repo.findByContent({ searchText: q || null, childName: child || null, daysBack: days || 14 });
    matched_via = 'content_fallback';
  }
  return { results: (results || []).slice(0, 20), matched_via };
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(buildHealthPayload()));
    }

    // Active round-trip probe: send a tagged message to the test group and wait
    // for it to arrive back. 20s hard request timeout (runProbe waits up to 15s).
    if (req.method === 'GET' && req.url === '/health-probe') {
      let responded = false;
      const finish = (code, payload) => {
        if (responded) return;
        responded = true;
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const timeout = setTimeout(() => finish(504, { ok: false, reason: 'request_timeout' }), 20000);
      try {
        const { runProbe } = require('./health-probe');
        const result = await runProbe();
        clearTimeout(timeout);
        finish(200, result);
      } catch (e) {
        clearTimeout(timeout);
        finish(500, { ok: false, error: e.message });
      }
      return;
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

        // Try live fetchMessages first. Only use the live result when it
        // actually has messages — some client backends (old whatsapp-web.js)
        // return getChatById() successfully but fetchMessages() yields 0 rows.
        // In that case fall through to the dm-history.jsonl log, which has data.
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
              if (result.length > 0) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ ok: true, jid, count: result.length, messages: result, source: 'live' }));
              }
              // 0 live messages — fall through to the log fallback below.
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

    // GET /system-inbox?limit=10&since=<unix_ts>
    // Returns the latest N captured DMs in Aviv's chat — both inbound (Aviv →
    // us) and outbound (system alerts sent to Aviv), each tagged with a
    // `direction` field (see system-message-capture.js). Filtered to
    // timestamp >= since, sorted by timestamp desc.
    if (req.method === 'GET' && req.url.startsWith('/system-inbox')) {
      try {
        const urlObj = new URL(req.url, 'http://localhost');
        const limit = Math.min(parseInt(urlObj.searchParams.get('limit') || '10', 10), 100);
        const since = parseInt(urlObj.searchParams.get('since') || '0', 10) || 0;

        const { SYSTEM_INBOX } = require('./system-message-capture');
        let messages = [];
        try {
          const files = fs.readdirSync(SYSTEM_INBOX).filter(f => f.endsWith('.json'));
          for (const file of files) {
            try {
              const rec = JSON.parse(fs.readFileSync(path.join(SYSTEM_INBOX, file), 'utf8'));
              const ts = Number(rec.timestamp) || 0;
              if (ts >= since) messages.push(rec);
            } catch (_) {}
          }
        } catch (_) {
          // Inbox dir may not exist yet — treat as empty.
        }

        messages.sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
        messages = messages.slice(0, limit);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, count: messages.length, messages }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    // Phase 2.3: notice feedback — Aviv thumbs-up/down notices via the API.
    // GET /feedback/stats → aggregate stats for triage tuning.
    if (req.method === 'GET' && req.url === '/feedback/stats') {
      try {
        const { getFeedbackStats } = require('./db');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, stats: getFeedbackStats() }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    // GET /media/retry[?limit=N] — reprocess failed media attachments from the
    // on-disk archive (the live message object is long gone by cron time).
    // On success: update the message body + status, and replace the earlier
    // "couldn't read this attachment" notice with the real extracted content.
    if (req.method === 'GET' && req.url.startsWith('/media/retry')) {
      try {
        const { getFailedMedia, setMediaStatus, incrementMediaRetry, updateMessageBody, getGroup, getDB } = require('./db');
        const { getArchivedMedia, mimeForExt } = require('./media-archive');
        const { extractFromMedia } = require('./media-parser');
        const urlObj = new URL(req.url, 'http://localhost');
        const limit = Math.min(parseInt(urlObj.searchParams.get('limit') || '10', 10), 50);
        const failed = getFailedMedia(limit);
        const results = [];

        for (const row of failed) {
          // Count the attempt up-front so a permanently-broken file eventually
          // stops being retried (getFailedMedia caps at media_retry_count < 3).
          incrementMediaRetry(row.id);

          // Prefer the recorded path; fall back to a timestamp scan of the archive.
          let buffer = null;
          let mimeType = null;
          try {
            if (row.media_path && fs.existsSync(row.media_path)) {
              buffer = fs.readFileSync(row.media_path);
              mimeType = mimeForExt(row.media_path.split('.').pop());
            }
          } catch (_) {}
          if (!buffer) {
            const archived = getArchivedMedia(row.group_id, row.timestamp);
            if (archived) { buffer = archived.buffer; mimeType = archived.mimeType; }
          }
          if (!buffer) {
            setMediaStatus(row.id, 'failed', 'archived file missing');
            results.push({ id: row.id, status: 'no_archive' });
            continue;
          }

          try {
            const groupName = (getGroup(row.group_id) || {}).name || row.group_id;
            const extracted = await extractFromMedia(buffer, mimeType, row.media_type, null, groupName);
            const ok = extracted && extracted !== '[תמונה]' && !/לא הצלחתי לקרוא/.test(extracted);
            if (ok) {
              updateMessageBody(row.id, extracted);
              setMediaStatus(row.id, 'processed', null);
              // Replace the "couldn't read" placeholder notice with real content.
              try {
                getDB().prepare(
                  'UPDATE notices SET content=? WHERE source_timestamp=? AND group_name=? AND dismissed=0'
                ).run(extracted, row.timestamp, groupName);
              } catch (_) {}
              results.push({ id: row.id, status: 'processed', preview: extracted.substring(0, 80) });
            } else {
              setMediaStatus(row.id, 'failed', 'retry returned no content');
              results.push({ id: row.id, status: 'still_failed' });
            }
          } catch (e) {
            setMediaStatus(row.id, 'failed', e.message);
            results.push({ id: row.id, status: 'error', error: e.message });
          }
        }

        const processed = results.filter(r => r.status === 'processed').length;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, total: failed.length, processed, results }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    // POST /feedback { notice_id, feedback, comment }
    if (req.method === 'POST' && req.url === '/feedback') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { notice_id, feedback, comment } = JSON.parse(body || '{}');
          if (!['good', 'bad', 'missed'].includes(feedback)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: "feedback must be one of 'good', 'bad', 'missed'" }));
          }
          const { saveFeedback } = require('./db');
          const id = saveFeedback(notice_id != null ? notice_id : null, feedback, comment);
          console.log(`[VoiceServer] Feedback saved (id=${id}): notice=${notice_id} → ${feedback}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, id }));
        } catch (e) {
          console.error('[VoiceServer] feedback error:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // B7: Group monitoring state endpoint — for OpenClaw/agents to use instead of raw DB writes
    if (req.method === 'POST' && req.url === '/api/groups/monitoring') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { id, monitored, relatedTo, primaryChild, description } = JSON.parse(body || '{}');
          if (!id) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: 'Missing required field: id (group JID)' }));
          }
          const { setGroupMonitoring, getGroup } = require('./db');
          const existing = getGroup(id);
          if (!existing) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: `Group ${id} not found in DB` }));
          }
          const opts = {};
          if (monitored !== undefined) opts.monitored = !!monitored;
          if (relatedTo !== undefined) opts.relatedTo = relatedTo;
          if (primaryChild !== undefined) opts.primaryChild = primaryChild;
          if (description !== undefined) opts.description = description;
          setGroupMonitoring(id, opts);
          const updated = getGroup(id);
          console.log(`[VoiceServer] Group monitoring updated: ${id} → monitored=${updated.monitored}, related_to=${updated.related_to}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, group: updated }));
        } catch (e) {
          console.error('[VoiceServer] /api/groups/monitoring error:', e.message);
          res.writeHead(e.message.includes('not found') ? 404 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // ── E1: POST /api/calendar/validate ──────────────────────────────────────
    // Source-grounding gate for calendar writes. OpenClaw calls this BEFORE it
    // creates a calendar event: every proposed field (date/time/location) must
    // appear in the source notice, or the write is rejected as fabricated
    // (P-015 / G1). Body: { event_data: { summary?, date?, time?, location? },
    // source_notice_id }. Returns { valid, blocked_fields, reason }.
    if (req.method === 'POST' && req.url === '/api/calendar/validate') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { event_data, source_notice_id } = JSON.parse(body || '{}');

          if (source_notice_id == null) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ valid: false, blocked_fields: [], reason: 'source_notice_id required' }));
          }

          // Look the notice up first so a missing id is a clean 404 (spec E1.4)
          // and so we can echo a content_preview back to the caller (E1.7).
          const { getDB } = require('./db');
          const notice = getDB().prepare('SELECT * FROM notices WHERE id = ?').get(Number(source_notice_id));
          if (!notice) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ valid: false, blocked_fields: [], reason: 'notice not found' }));
          }
          const content = notice.content || '';
          const source_notice = { id: notice.id, content_preview: content.slice(0, 200) };

          const ev = event_data || {};
          const summary = ev.summary || ev.title || null;
          const proposed = {
            date:     ev.date     || null,
            time:     ev.time     || null,
            location: ev.location || null,
            summary,
          };

          // Prefer the canonical grounding check (date/time/location vs. the
          // notice). It deliberately does NOT ground the summary, so we add that
          // substring check ourselves to satisfy spec E1.5 (summary/title too).
          const { validateCalendarWrite } = require('./validation/sourceValidator');
          const check = validateCalendarWrite(source_notice_id, proposed);
          const blocked_fields = [...(check.ungrounded_fields || [])];
          if (summary && !content.toLowerCase().includes(String(summary).toLowerCase())) {
            blocked_fields.push('summary');
          }
          const valid = blocked_fields.length === 0;

          console.log(`[VoiceServer] /api/calendar/validate notice #${source_notice_id} → valid=${valid}${valid ? '' : ` blocked=${blocked_fields.join(',')}`}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            valid,
            source_notice,
            blocked_fields,
            reason: valid ? null : (check.reason || `field(s) absent from source: ${blocked_fields.join(', ')}`),
          }));
        } catch (e) {
          console.error('[VoiceServer] /api/calendar/validate error:', e.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ valid: false, blocked_fields: [], reason: e.message }));
        }
      });
      return;
    }

    // B8: Enum integrity check endpoint — for nightly cron or on-demand checks
    if (req.method === 'GET' && req.url === '/api/integrity/enums') {
      try {
        const { checkEnumIntegrity } = require('./db');
        const violations = checkEnumIntegrity();
        const status = violations.length === 0 ? 'healthy' : 'violations_found';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: violations.length === 0, status, count: violations.length, violations }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // ── Q1: GET /api/notices/search?q=<text>&child=<name>&days=<N> ─────────────
    // Search cascade: upcoming window first, wider content search as fallback.
    if (req.method === 'GET' && req.url.startsWith('/api/notices/search')) {
      try {
        const urlObj = new URL(req.url, 'http://localhost');
        const q = urlObj.searchParams.get('q') || null;
        const child = urlObj.searchParams.get('child') || null;
        const days = parseInt(urlObj.searchParams.get('days') || '', 10) || null;
        const { results, matched_via } = noticeSearch({ q, child, days });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ results, matched_via, count: results.length }));
      } catch (e) {
        console.error('[VoiceServer] /api/notices/search error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // ── Q1: GET /api/notices/upcoming?from=<date>&to=<date>&child=<name> ───────
    if (req.method === 'GET' && req.url.startsWith('/api/notices/upcoming')) {
      try {
        const urlObj = new URL(req.url, 'http://localhost');
        const from = urlObj.searchParams.get('from') || undefined;
        const to = urlObj.searchParams.get('to') || undefined;
        const child = urlObj.searchParams.get('child') || null;
        const { NoticeRepository } = require('./notices/repository');
        const results = new NoticeRepository()
          .findUpcoming({ from, to, childName: child })
          .slice(0, 20);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ results, count: results.length }));
      } catch (e) {
        console.error('[VoiceServer] /api/notices/upcoming error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // ── Q3: GET /api/notices/lookup?query=<text>&child=<name>&from=&to= ────────
    // The OpenClaw tool endpoint Lipa calls before answering schedule questions.
    // Combines the search cascade (when `query` is given) with the plain upcoming
    // lookup, and always includes notice_ids so Lipa can cite sources (G1).
    if (req.method === 'GET' && req.url.startsWith('/api/notices/lookup')) {
      try {
        const urlObj = new URL(req.url, 'http://localhost');
        const query = urlObj.searchParams.get('query') || null;
        const child = urlObj.searchParams.get('child') || null;
        const from = urlObj.searchParams.get('from') || undefined;
        const to = urlObj.searchParams.get('to') || undefined;
        const days = parseInt(urlObj.searchParams.get('days') || '', 10) || null;
        // A2: always route through the cascade — even a from/to-only lookup falls
        // back to content search when the date window is empty (no bare no-fallback
        // branch anymore).
        const { results, matched_via } = noticeSearch({ q: query, child, days, from, to });
        const notice_ids = results.map(r => r.id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ results, matched_via, count: results.length, notice_ids }));
      } catch (e) {
        console.error('[VoiceServer] /api/notices/lookup error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // ── B1: GET /api/context?from=<date>&to=<date>&child=<name> ────────────────
    // Unified family view over a date range: notices (A2 cascade), calendar
    // events (both parents, deduped by id), notice_event rows, and homework.
    // This is the single endpoint Lipa can call to ground any schedule answer.
    if (req.method === 'GET' && req.url.startsWith('/api/context')) {
      try {
        const urlObj = new URL(req.url, 'http://localhost');
        const from = urlObj.searchParams.get('from');
        const to = urlObj.searchParams.get('to');
        const child = urlObj.searchParams.get('child') || null;
        if (!from || !to) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Missing required params: from and to (YYYY-MM-DD)' }));
        }
        console.log(`[VoiceServer] /api/context from=${from} to=${to} child=${child || '-'}`);

        // ── Notices: A2 cascade (upcoming window → content fallback) ──────────
        const { results: noticeResults, matched_via } = noticeSearch({ child, from, to });
        const notices = noticeResults.map(n => ({
          ...n, notice_ids: [n.id], source_type: 'notice',
        }));

        // ── notice_event rows in the window ──────────────────────────────────
        const { getDB } = require('./db');
        // NOTE: notice_event has no `location` column in this schema (drift from
        // the original spec) — select NULL AS location to keep the output field
        // stable without erroring on a missing column.
        let neRows = getDB().prepare(`
          SELECT ne.id, ne.notice_id, ne.event_date, ne.event_time, ne.event_title, NULL AS location,
                 n.group_name, n.content, n.primary_child, n.query_visible
          FROM notice_event ne JOIN notices n ON ne.notice_id = n.id
          WHERE n.dismissed = 0 AND n.query_visible = 1 AND ne.event_date BETWEEN ? AND ?
          ORDER BY ne.event_date, ne.event_time
        `).all(from, to);
        if (child) {
          neRows = neRows.filter(r => r.primary_child === child || (r.content && r.content.includes(child)));
        }
        const notice_events = neRows.map(r => ({
          ...r, notice_ids: [r.notice_id], source_type: 'notice_event',
        }));

        // ── Calendar events: both parents (+ Liat work), deduped by id ────────
        // Mirrors query.js fetchAllUpcomingEvents merge/dedupe, then narrows to
        // the from/to window by event date.
        let calendar_events = [];
        try {
          const config = require('./config');
          const { getUpcomingEvents } = require('./calendar');
          const PARENT1 = process.env.PARENT1_NAME || 'aviv';
          const PARENT2 = process.env.PARENT2_NAME || 'liat';
          const sources = [
            { calendarId: config.AVIV_CALENDAR_ID, tokenPath: config.AVIV_TOKEN_PATH, owner: PARENT1 },
            { calendarId: config.LIAT_CALENDAR_ID, tokenPath: config.LIAT_TOKEN_PATH, owner: PARENT2 },
            ...(config.LIAT_WORK_CALENDAR_ID
              ? [{ calendarId: config.LIAT_WORK_CALENDAR_ID, tokenPath: config.LIAT_TOKEN_PATH, owner: `${PARENT2} (work)` }]
              : []),
          ];
          // Reach far enough ahead to cover the end of the `to` day, plus a buffer.
          const toEndMs = new Date(`${to}T23:59:59Z`).getTime();
          const hoursAhead = Math.max(24, Math.ceil((toEndMs - Date.now()) / 3600000) + 24);
          const byId = new Map();
          for (const { calendarId, tokenPath, owner } of sources) {
            const list = await getUpcomingEvents(calendarId, tokenPath, hoursAhead);
            for (const e of list) {
              if (byId.has(e.id)) {
                const ex = byId.get(e.id);
                if (!ex.owners.includes(owner)) ex.owners.push(owner);
              } else {
                byId.set(e.id, { id: e.id, summary: e.summary, start: e.start, end: e.end, owners: [owner], source: 'calendar' });
              }
            }
          }
          calendar_events = [...byId.values()]
            .filter(e => {
              const d = (e.start?.dateTime || e.start?.date || '').substring(0, 10);
              return d && d >= from && d <= to;
            })
            .map(e => ({ ...e, notice_ids: [], source_type: 'calendar' }));
        } catch (calErr) {
          console.error('[VoiceServer] /api/context calendar error:', calErr.message);
        }

        // ── Homework due within the window ───────────────────────────────────
        let homework = [];
        try {
          const { getPendingHomework } = require('./db');
          homework = getPendingHomework(from)
            .filter(h => !h.due_date || h.due_date <= to)
            .map(h => ({ ...h, notice_ids: [], source_type: 'homework' }));
        } catch (hwErr) {
          console.error('[VoiceServer] /api/context homework error:', hwErr.message);
        }

        console.log(`[VoiceServer] /api/context results: notices=${notices.length} calendar=${calendar_events.length} notice_events=${notice_events.length} homework=${homework.length} matched_via=${matched_via}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ notices, calendar_events, notice_events, homework, matched_via }));
      } catch (e) {
        console.error('[VoiceServer] /api/context error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
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
