#!/bin/bash
# Besinsky bot external watchdog — runs via systemd timer every 2 minutes.
# Detection is out-of-band (not dependent on WhatsApp or LLM).
# Writes results for Lipa's cron to read + sends ntfy.sh backup to Aviv.
set -euo pipefail

NTFY_TOPIC="${NTFY_TOPIC:-besinsky-watchdog-af40ab37}"
ALERT_FILE="/tmp/watchdog-alert.json"
STATE_FILE="/home/ubuntu/besinsky-bot/data/watchdog-state.json"
LOG="/var/log/besinsky-watchdog.log"

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

  if (failures.length > 0) {
    fs.appendFileSync('$LOG', ts + ' FAIL ' + failures.join(' ') + '\n');

    // Write alert flag file for Lipa's cron
    fs.writeFileSync('$ALERT_FILE', JSON.stringify({
      ts: tsMs,
      message: '⚠️ Watchdog alert: ' + failures.join(' '),
      details: details.join(' '),
      probeResult: probe
    }, null, 2));

    // Send to ntfy.sh (Aviv's backup — best effort)
    const msg = 'WATCHDOG: ' + failures.join(' ') + '\n' + details.join(' ');
    const postData = msg;
    const ntfyReq = https.request({
      hostname: 'ntfy.sh',
      path: '/$NTFY_TOPIC',
      method: 'POST',
      headers: { 'Title': 'Besinsky Bot Alert', 'Priority': 'high', 'Tags': 'warning' },
      timeout: 5000
    });
    ntfyReq.on('error', () => {});
    ntfyReq.write(postData);
    ntfyReq.end();
  } else {
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
