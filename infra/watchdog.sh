#!/bin/bash
# Besinsky bot external watchdog — runs via systemd timer every 5 minutes.
# Detection is out-of-band (not dependent on WhatsApp or LLM).
# Writes results for Lipa's cron to read + sends ntfy.sh backup to Aviv.
# DEBOUNCE: only alerts after 3 consecutive failures (~15 min of confirmed downtime).
set -euo pipefail

NTFY_TOPIC="${NTFY_TOPIC:-besinsky-watchdog-af40ab37}"
ALERT_FILE="/tmp/watchdog-alert.json"
STATE_FILE="/home/ubuntu/besinsky-bot/data/watchdog-state.json"
CONSECUTIVE_FAIL_FILE="/tmp/watchdog-consecutive-fails"
LOG="/var/log/besinsky-watchdog.log"
ALERT_THRESHOLD=3  # consecutive failures before alerting

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Run all checks via node (jq not available)
node -e "
const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const http = require('http');

const failures = [];
const details = [];
const ts = '$TIMESTAMP';
const tsMs = Date.now();

// Check 1: Bot process
let botStatus = 'unknown', restarts = 0;
try {
  const raw = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
  const procs = JSON.parse(raw);
  const bot = procs.find(p => p.name === 'besinsky-bot');
  if (!bot) { botStatus = 'missing'; failures.push('bot-missing'); details.push('Bot not in pm2.'); }
  else {
    botStatus = bot.pm2_env?.status || 'unknown';
    restarts = bot.pm2_env?.restart_time || 0;
    if (botStatus !== 'online') { failures.push('bot-' + botStatus); details.push('Bot status: ' + botStatus + '.'); }
    if (restarts > 200) { failures.push('restart-loop(' + restarts + ')'); details.push('Restart count: ' + restarts + '.'); }
  }
} catch (e) { botStatus = 'pm2_error'; failures.push('bot-pm2_error'); details.push('pm2 check failed: ' + e.message.substring(0,100)); }

// Check 1b: Startup-phase supervisor (I3)
// The health probe below only works once the bot has connected. A crash or hang
// *during* startup is invisible to it. The bot writes /tmp/besinsky-startup.json
// with {ts, pid, phase} — 'starting' at boot, 'connected' once WhatsApp is up.
//   - phase='starting' AND ts > 5min old  → stuck in startup
//   - marker missing AND pm2 says 'online' → marker never written / pre-write crash
const STARTUP_MARKER = process.env.BESINSKY_STARTUP_MARKER || '/tmp/besinsky-startup.json';
const STARTUP_STUCK_MS = 5 * 60 * 1000;
try {
  const marker = JSON.parse(fs.readFileSync(STARTUP_MARKER, 'utf8'));
  const ageMs = tsMs - (marker.ts || 0);
  if (marker.phase === 'starting' && ageMs > STARTUP_STUCK_MS) {
    failures.push('startup-stuck(' + Math.round(ageMs / 60000) + 'min)');
    details.push('Bot stuck in startup for ' + Math.round(ageMs / 60000) + 'min (phase=starting).');
  }
} catch (e) {
  // Marker missing/unreadable. Only a problem if pm2 thinks the bot is running:
  // a healthy connected bot leaves the marker in place, so a missing marker while
  // 'online' means it never got written (crashed before boot, or crash-loop).
  if (botStatus === 'online') {
    failures.push('startup-marker-missing');
    details.push('Startup marker missing while pm2 status=online (bot may be crash-looping before it can write it).');
  }
}

// Check 1c: PM2 restart rate (I5)
// The watchdog runs every ~5min, so comparing restart_time to the value we
// stored last run gives a 5-minute delta. A jump of >3 restarts means the bot
// is crash-looping — write the stuck-alert file (cleared by whatsapp.js on the
// next successful reconnect).
const RESTART_RATE_FILE = '/tmp/besinsky-restart-rate.json';
const RESTART_JUMP_THRESHOLD = 3;
const RESTART_WINDOW_MS = 6 * 60 * 1000; // tolerate a slightly-late timer tick
try {
  if (botStatus !== 'pm2_error' && botStatus !== 'missing') {
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(RESTART_RATE_FILE, 'utf8')); } catch {}
    if (prev && typeof prev.restarts === 'number' && (tsMs - prev.ts) <= RESTART_WINDOW_MS) {
      const delta = restarts - prev.restarts;
      if (delta > RESTART_JUMP_THRESHOLD) {
        failures.push('crash-loop(' + delta + '/' + Math.round((tsMs - prev.ts) / 60000) + 'min)');
        details.push('Bot restarted ' + delta + ' times in ' + Math.round((tsMs - prev.ts) / 60000) + 'min — crash loop.');
        fs.writeFileSync('/tmp/bot-stuck-alert.json', JSON.stringify({
          ts: tsMs,
          msg: 'Bot crash-loop: ' + delta + ' PM2 restarts in ' + Math.round((tsMs - prev.ts) / 60000) + 'min (restart_time=' + restarts + '). Needs investigation — check pm2 logs.'
        }));
      }
    }
    fs.writeFileSync(RESTART_RATE_FILE, JSON.stringify({ ts: tsMs, restarts }));
  }
} catch (e) {
  details.push('Restart-rate check error: ' + e.message.substring(0, 80));
}

// Check 1d: Log freshness (I5)
// A frozen/wedged process keeps its pm2 status 'online' but stops writing logs.
// During daytime (08–22 Israel) the bot logs constantly, so a stdout log older
// than 30min means the process is stuck. Nighttime is legitimately quiet, so
// only check during active hours.
const OUT_LOG = process.env.BESINSKY_OUT_LOG || '/home/ubuntu/.pm2/logs/besinsky-bot-out.log';
const LOG_STALE_MS = 30 * 60 * 1000;
try {
  const israelHour = new Date(tsMs + 3 * 60 * 60 * 1000).getUTCHours(); // UTC+3
  const isDaytime = israelHour >= 8 && israelHour < 22;
  if (isDaytime && botStatus === 'online') {
    const logAgeMs = tsMs - fs.statSync(OUT_LOG).mtimeMs;
    if (logAgeMs > LOG_STALE_MS) {
      const ageMin = Math.round(logAgeMs / 60000);
      failures.push('log-frozen(' + ageMin + 'min)');
      details.push('PM2 stdout log not written for ' + ageMin + 'min during daytime — process likely frozen.');
      fs.writeFileSync('/tmp/bot-stuck-alert.json', JSON.stringify({
        ts: tsMs,
        msg: 'Bot process frozen: no log output for ' + ageMin + 'min during daytime (pm2 status=online). Restart may be needed.'
      }));
    }
  }
} catch (e) {
  // Missing log file / stat error — non-fatal, note it but don't alert.
  details.push('Log-freshness check skipped: ' + e.message.substring(0, 80));
}

// Check 2: Health probe (HTTP, no external deps)
function httpGet(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, reason: 'parse_error' }); } });
    });
    req.on('error', () => resolve({ ok: false, reason: 'unreachable' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
  });
}

async function run() {
  const probe = await httpGet('http://localhost:3001/health-probe', 20000);
  if (!probe.ok) {
    failures.push('probe-fail(' + (probe.reason || 'unknown') + ')');
    details.push('Health probe failed: ' + (probe.reason || 'unknown') + '.');
  }

  const health = await httpGet('http://localhost:3001/health', 5000).catch(() => ({}));
  const waConnected = health.whatsapp_connected || false;
  if (!waConnected && !probe.ok) {
    failures.push('wa-disconnected');
    details.push('WhatsApp not connected.');
  }

  const state = {
    ts, tsMs,
    ok: failures.length === 0,
    failures: failures.join(' '),
    details: details.join(' '),
    botStatus, restarts,
    probeOk: probe.ok || false,
    probeReason: probe.reason || null,
    probeMs: probe.roundTripMs || 0,
    waConnected
  };

  fs.writeFileSync('$STATE_FILE', JSON.stringify(state, null, 2));

  // ── Debounce: track consecutive failures ──
  const CONSECUTIVE_FAIL_FILE = '$CONSECUTIVE_FAIL_FILE';
  const ALERT_THRESHOLD = parseInt('$ALERT_THRESHOLD', 10);

  if (failures.length > 0) {
    // Increment consecutive failure count
    let consecutiveFails = 1;
    try {
      const prev = parseInt(fs.readFileSync(CONSECUTIVE_FAIL_FILE, 'utf8').trim(), 10);
      if (!isNaN(prev)) consecutiveFails = prev + 1;
    } catch {} // file doesn't exist yet
    fs.writeFileSync(CONSECUTIVE_FAIL_FILE, String(consecutiveFails));

    fs.appendFileSync('$LOG', ts + ' FAIL(' + consecutiveFails + '/' + ALERT_THRESHOLD + ') ' + failures.join(' ') + '\n');

    if (consecutiveFails >= ALERT_THRESHOLD) {
      // Write alert flag file for Lipa's cron
      fs.writeFileSync('$ALERT_FILE', JSON.stringify({
        ts: tsMs,
        message: '⚠️ Watchdog alert (' + consecutiveFails + ' consecutive failures): ' + failures.join(' '),
        details: details.join(' '),
        consecutiveFails,
        probeResult: probe
      }, null, 2));

      // Send to ntfy.sh (Aviv's backup — best effort)
      const msg = 'WATCHDOG (' + consecutiveFails + 'x): ' + failures.join(' ') + '\n' + details.join(' ');
      const ntfyReq = https.request({
        hostname: 'ntfy.sh',
        path: '/$NTFY_TOPIC',
        method: 'POST',
        headers: { 'Title': 'Besinsky Bot Alert', 'Priority': 'high', 'Tags': 'warning' },
        timeout: 5000
      });
      ntfyReq.on('error', () => {});
      ntfyReq.write(msg);
      ntfyReq.end();
    } else {
      fs.appendFileSync('$LOG', ts + ' DEBOUNCE: ' + consecutiveFails + '/' + ALERT_THRESHOLD + ' — suppressing alert\n');
    }
  } else {
    // All clear — reset consecutive failure counter
    try { fs.unlinkSync(CONSECUTIVE_FAIL_FILE); } catch {}
    fs.appendFileSync('$LOG', ts + ' OK probe=' + (probe.roundTripMs || 0) + 'ms\n');
    // Clear alert file
    try { fs.unlinkSync('$ALERT_FILE'); } catch {}
  }

  // Check 3: Volume anomaly (message/notice pipeline)
  let volumeAlerts = [];
  try {
    const { execSync } = require('child_process');
    const volRaw = execSync('cd /home/ubuntu/besinsky-bot && node scripts/volume-check.js 2>/dev/null', { encoding: 'utf8', timeout: 10000 });
    const vol = JSON.parse(volRaw);
    if (vol.alerts && vol.alerts.length > 0) {
      vol.alerts.forEach(a => {
        failures.push('volume-' + a);
        details.push('Volume alert: ' + a + '.');
      });
    }
    state.volume = vol;
  } catch (e) {
    // volume check failed — non-critical, log but don't alert
    state.volumeError = e.message.substring(0, 100);
  }

  // Re-write state with volume info
  fs.writeFileSync('$STATE_FILE', JSON.stringify(state, null, 2));

  // Give ntfy request time to complete
  setTimeout(() => process.exit(0), 1000);
}

run().catch(e => {
  fs.appendFileSync('$LOG', ts + ' ERROR ' + e.message + '\n');
  process.exit(1);
});
"
