/**
 * health.js — Periodic health checks for FamilyBot.
 * Runs every 5 minutes. Alerts master group on failures.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { getDB, clearExpiredPendingActions } = require('./db');
const { verifyCalendarAuth, generateAuthUrl } = require('./calendar');
const { runThroughputChecks } = require('./health-throughput');
const config = require('./config');
const logger = require('./logger');

let _client = null;
let _masterGroupId = null;
let _lastAlertTime = 0;
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // max 1 alert per day

// WhatsApp state debounce — only alert after 3 consecutive non-CONNECTED readings (~15 min)
let _waDisconnectCount = 0;
const WA_DISCONNECT_THRESHOLD = 3;
const ALERT_TARGET = process.env.AVIV_PHONE ? `${process.env.AVIV_PHONE}@c.us` : null; // send health alerts to primary parent DM

// Calendar re-auth cooldown — persisted to disk so it survives restarts
const CALENDAR_AUTH_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// Calendar auth is checked at most once per hour (it makes real API calls)
const CALENDAR_CHECK_INTERVAL_MS = 60 * 60 * 1000;
let _lastCalendarCheckMs = 0;
// Throughput/integrity checks run at most once per hour (they scan the DB and
// do an O(n²) duplicate pass — no need every 5-min cycle).
const THROUGHPUT_CHECK_INTERVAL_MS = 60 * 60 * 1000;
let _lastThroughputCheckMs = 0;
// Rate-limit OpenClaw channel auto-reconnect to at most once per 30 min
let lastChannelReconnectMs = 0;
const HEALTH_STATE_PATH = path.join(__dirname, '../data/health-state.json');

function loadHealthState() {
  try {
    return JSON.parse(fs.readFileSync(HEALTH_STATE_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveHealthState(state) {
  try {
    fs.mkdirSync(path.dirname(HEALTH_STATE_PATH), { recursive: true });
    fs.writeFileSync(HEALTH_STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    logger.warn({ component: 'Health', err: e.message }, 'Could not save health state');
  }
}

/**
 * Inject the WhatsApp client and master group ID after they're available.
 * Also flushes any pending re-auth messages that couldn't be sent earlier.
 */
async function initHealth(client, masterGroupId) {
  _client = client;
  _masterGroupId = masterGroupId;

  // Flush any pending health alerts queued while WhatsApp was unavailable
  const state = loadHealthState();
  if (state.pendingAlerts && state.pendingAlerts.length > 0) {
    for (const alert of state.pendingAlerts) {
      try {
        await _client.sendMessage(ALERT_TARGET, alert.msg);
        logger.info({ component: 'Health' }, 'Flushed queued alert: %s', alert.msg.substring(0, 80));
      } catch (e) {
        logger.error({ component: 'Health', err: e.message }, 'Failed to flush alert');
      }
    }
    state.pendingAlerts = [];
    saveHealthState(state);
  }

  // Flush any pending re-auth requests that were queued while client was unavailable
  if (state.pendingReauth) {
    for (const [key, entry] of Object.entries(state.pendingReauth)) {
      if (entry.pending && _client && _masterGroupId) {
        logger.info({ component: 'Health', key }, 'Flushing pending re-auth');
        try {
          await _client.sendMessage(_masterGroupId, entry.msg);
          entry.pending = false;
          entry.sentAt = Date.now();
        } catch (e) {
          logger.error({ component: 'Health', key, err: e.message }, 'Failed to flush re-auth');
        }
      }
    }
    saveHealthState(state);
  }
}

/**
 * Run all health checks. Returns array of failure strings (empty = all good).
 */
async function runChecks() {
  const failures = [];

  // 1. DB accessible and key tables exist
  try {
    const db = getDB();
    db.prepare('SELECT 1').get();
    const requiredTables = ['messages', 'groups', 'reminders', 'follow_ups', 'conversation_history', 'family_members', 'pending_actions'];
    for (const t of requiredTables) {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
      if (!row) failures.push(`Missing DB table: ${t}`);
    }
  } catch (e) {
    failures.push(`DB error: ${e.message}`);
  }

  // 2. Calendar credentials valid — check at most once per hour (real API calls)
  const nowMs = Date.now();
  if (nowMs - _lastCalendarCheckMs >= CALENDAR_CHECK_INTERVAL_MS) {
    _lastCalendarCheckMs = nowMs;
    try {
      const avivAuth = await verifyCalendarAuth(config.AVIV_TOKEN_PATH);
      if (!avivAuth.ok) {
        await sendCalendarAuthRequest('aviv', config.AVIV_CALENDAR_ID, 'אביב', 'לחץ');
      }
    } catch (e) {
      failures.push(`Calendar auth check error: ${e.message}`);
    }
    try {
      const liatAuth = await verifyCalendarAuth(config.LIAT_TOKEN_PATH);
      if (!liatAuth.ok) {
        await sendCalendarAuthRequest('liat', config.LIAT_CALENDAR_ID, 'ליאת', 'לחצי');
      }
    } catch (e) {
      failures.push(`Calendar auth check error (Liat): ${e.message}`);
    }
  }

  // 3. WhatsApp client connected + receiving messages (debounced — 3 consecutive failures)
  if (_client) {
    try {
      const state = await _client.getState();
      if (state !== 'CONNECTED') {
        _waDisconnectCount++;
        if (_waDisconnectCount >= WA_DISCONNECT_THRESHOLD) {
          failures.push(`WhatsApp state: ${state} (${_waDisconnectCount} consecutive checks)`);
        } else {
          logger.warn({ component: 'Health', state, consecutive: _waDisconnectCount, threshold: WA_DISCONNECT_THRESHOLD }, 'WhatsApp not connected — debouncing');
        }
      } else {
        if (_waDisconnectCount > 0) {
          logger.info({ component: 'Health', recoveredAfter: _waDisconnectCount }, 'WhatsApp reconnected — resetting debounce counter');
        }
        _waDisconnectCount = 0;
      }
    } catch (e) {
      _waDisconnectCount++;
      if (_waDisconnectCount >= WA_DISCONNECT_THRESHOLD) {
        failures.push(`WhatsApp state check error: ${e.message} (${_waDisconnectCount} consecutive)`);
      } else {
        logger.warn({ component: 'Health', err: e.message, consecutive: _waDisconnectCount }, 'WhatsApp state check failed — debouncing');
      }
    }

    // OUTAGE DETECTION: if ALL groups are silent during working hours, check connection and alert.
    // Per-group silence is NOT alerted (groups can be legitimately quiet).
    // Only a global silence across all groups signals a real outage.
    // Gap is measured in ACTIVE hours only (08:00–23:00 Israel) — nighttime is excluded.
    try {
      const nowMs = Date.now();
      const israelOffset = 3 * 60 * 60 * 1000; // UTC+3
      const israelHour = new Date(nowMs + israelOffset).getUTCHours();
      const isWorkingHours = israelHour >= 8 && israelHour < 23;

      if (isWorkingHours) {
        const db = getDB();
        const lastMsg = db.prepare(
          "SELECT MAX(timestamp) as ts FROM messages WHERE group_id != '120363426994367917@g.us'"
        ).get();
        const lastMsgTs = lastMsg && lastMsg.ts ? lastMsg.ts : 0;

        // Compute active (daytime) hours elapsed since last message — ignore 23:00–07:00
        const activeHours = (() => {
          const DAY_START = 7, DAY_END = 23;
          let activeMs = 0;
          let t = lastMsgTs;
          while (t < nowMs) {
            const h = new Date(t + israelOffset).getUTCHours();
            if (h >= DAY_START && h < DAY_END) {
              // Advance to end of this working segment or nowMs
              const dayEnd = new Date(t + israelOffset);
              dayEnd.setUTCHours(DAY_END, 0, 0, 0);
              const dayEndMs = dayEnd.getTime() - israelOffset;
              const step = Math.min(dayEndMs, nowMs) - t;
              activeMs += step;
              t = dayEndMs;
            } else {
              // Skip to next 07:00
              const nextStart = new Date(t + israelOffset);
              nextStart.setUTCHours(h < DAY_START ? DAY_START : DAY_START + 24, 0, 0, 0);
              t = nextStart.getTime() - israelOffset;
            }
          }
          return activeMs / 3600000;
        })();

        const ACTIVE_GAP_THRESHOLD_H = 9; // 9 active daytime hours

        if (activeHours > ACTIVE_GAP_THRESHOLD_H) {
          // Don't alert if gap is explained by Shabbat
          const lastMsgIsraelDay = new Date(lastMsgTs + israelOffset).getUTCDay();
          const nowIsraelDay = new Date(nowMs + israelOffset).getUTCDay();
          const lastMsgWasWeekend = lastMsgIsraelDay === 5 || lastMsgIsraelDay === 6;
          const nowIsWeekendOrSundayMorning = nowIsraelDay === 6 ||
            (nowIsraelDay === 0 && israelHour < 14);

          if (lastMsgWasWeekend && nowIsWeekendOrSundayMorning) {
            logger.info({ component: 'Health' }, 'Skipping outage alert — gap explained by Shabbat/weekend');
          } else {
            // Check outage alert cooldown separately (4h, not 24h)
            const OUTAGE_COOLDOWN_MS = 4 * 60 * 60 * 1000;
            const healthState = loadHealthState();
            const lastOutageAlert = healthState.lastOutageAlert || 0;

            if (nowMs - lastOutageAlert > OUTAGE_COOLDOWN_MS) {
              // Auto-check WhatsApp connection state
              let connState = 'UNKNOWN';
              try { connState = await _client.getState(); } catch (_) {}

              const hours = activeHours.toFixed(1);
              let outageMsg;
              if (connState !== 'CONNECTED') {
                outageMsg = `🔴 Global outage: all groups silent for ${hours} active hours\nWhatsApp disconnected (state: ${connState}).\nNeed QR scan → open WhatsApp on bot's phone → Linked Devices → scan new code.`;
              } else {
                outageMsg = `🔴 Global outage: all groups silent for ${hours} active hours\nWhatsApp shows connected but no group messages received.\nLikely needs session reset (QR scan).`;
              }

              healthState.lastOutageAlert = nowMs;
              saveHealthState(healthState);
              await sendAlertDirect(outageMsg);
              logger.error({ component: 'Health', activeGapH: hours, waState: connState }, 'Global outage alert sent');
            } else {
              const minLeft = Math.round((OUTAGE_COOLDOWN_MS - (nowMs - lastOutageAlert)) / 60000);
              logger.warn({ component: 'Health', cooldownMinLeft: minLeft, activeGapH: activeHours.toFixed(1) }, 'Outage detected but alert on cooldown');
            }
          }
        }
      }
    } catch (e) {
      logger.warn({ component: 'Health', err: e.message }, 'Outage check error');
    }
  }

  // 4. OpenClaw channel status — verify WhatsApp channel is linked and connected
  try {
    const channelStatus = await checkOpenClawChannel();
    if (!channelStatus.ok) {
      const msg = channelStatus.error || 'OpenClaw WhatsApp channel not connected';
      failures.push(msg);
      logger.warn({ component: 'Health' }, msg);
      // Write alert flag file for external monitoring
      try {
        fs.writeFileSync('/tmp/openclaw-channel-alert.json', JSON.stringify({
          ts: Date.now(),
          message: msg,
          details: channelStatus.details || null,
        }));
      } catch (writeErr) {
        logger.warn({ component: 'Health', err: writeErr.message }, 'Could not write channel alert flag');
      }

      // Auto-reconnect OpenClaw channel when the socket is stale (silently dead).
      // Only act on genuine staleness (>= 30 min), rate-limited to once per 30 min.
      if (channelStatus.error && channelStatus.error.includes('stale')) {
        const staleMin = channelStatus.details?.staleMin || 0;
        const now = Date.now();
        if (staleMin >= 30 && now - lastChannelReconnectMs > 30 * 60 * 1000) {
          lastChannelReconnectMs = now;
          logger.warn({ component: 'Health', staleMin }, 'Auto-reconnecting OpenClaw channel (stale socket)');
          execFile('systemctl', ['--user', 'restart', 'openclaw-gateway'], { timeout: 30000 }, (err) => {
            if (err) logger.error({ component: 'Health', err: err.message }, 'OpenClaw gateway restart failed');
            else logger.info({ component: 'Health' }, 'OpenClaw gateway restart triggered successfully');
          });
        }
      }
    } else if (!(channelStatus.details && channelStatus.details.skipped)) {
      // Only clear the alert flag when the check actually confirmed the channel
      // is healthy. If the check was skipped (CLI unavailable/timed out), we have
      // no real signal about channel state — leave any existing flag in place.
      try { fs.unlinkSync('/tmp/openclaw-channel-alert.json'); } catch (_) {}
    }
  } catch (e) {
    logger.warn({ component: 'Health', err: e.message }, 'OpenClaw channel check error');
  }

  // 5. Stale pending actions (> 30 min — indicates stuck confirmation flow)
  try {
    const db = getDB();
    const stale = db.prepare('SELECT COUNT(*) as c FROM pending_actions WHERE created_at < ?').get(Date.now() - 30 * 60 * 1000);
    if (stale && stale.c > 0) failures.push(`${stale.c} stale pending action(s) (>30 min)`);
    const cleared = clearExpiredPendingActions();
    if (cleared > 0) logger.info({ component: 'Health', cleared }, 'Cleared expired pending action(s)');
  } catch (_) {}

  // 6. Throughput & integrity checks (WORKPLAN-V4 A4) — catch silent failure.
  //    Throttled to hourly since they scan the DB; other checks stay 5-min.
  const nowThroughput = Date.now();
  if (nowThroughput - _lastThroughputCheckMs >= THROUGHPUT_CHECK_INTERVAL_MS) {
    _lastThroughputCheckMs = nowThroughput;
    try {
      const throughputFailures = runThroughputChecks();
      for (const f of throughputFailures) failures.push(f);
    } catch (e) {
      logger.error({ component: 'Health', err: e.message }, 'Throughput checks error');
    }
  }

  return failures;
}

/**
 * Send a personalized calendar re-auth request to the master group.
 * Cooldown is persisted to disk (survives restarts).
 * If client is not ready yet, queues the message and flushes on next initHealth().
 */
async function sendCalendarAuthRequest(key, email, nameHe, verbHe) {
  const now = Date.now();
  const state = loadHealthState();
  state.reauth = state.reauth || {};
  const lastSent = state.reauth[key] || 0;

  if (now - lastSent < CALENDAR_AUTH_COOLDOWN_MS) return;

  const url = generateAuthUrl(email);
  const msg = `⚠️ ליפא לא יכול לגשת ליומן של ${nameHe}.\n${nameHe}, ${verbHe} על הלינק, היכנס${verbHe === 'לחצי' ? 'י' : ''} עם ${email}, ושלח${verbHe === 'לחצי' ? 'י' : ''} לי את ה-URL מסרגל הכתובות:\n${url}`;

  // Record immediately to prevent duplicate sends across restarts
  state.reauth[key] = now;

  if (_client && _masterGroupId) {
    try {
      await _client.sendMessage(_masterGroupId, msg);
      logger.info({ component: 'Health', key }, 'Sent calendar re-auth request');
      state.pendingReauth = state.pendingReauth || {};
      if (state.pendingReauth[key]) state.pendingReauth[key].pending = false;
    } catch (e) {
      logger.error({ component: 'Health', key, err: e.message }, 'Failed to send re-auth');
      // Queue for next boot
      state.pendingReauth = state.pendingReauth || {};
      state.pendingReauth[key] = { pending: true, msg, queuedAt: now };
    }
  } else {
    // Client not ready — queue for when it becomes ready
    logger.warn({ component: 'Health', key }, 'Client not ready — queuing re-auth request');
    state.pendingReauth = state.pendingReauth || {};
    state.pendingReauth[key] = { pending: true, msg, queuedAt: now };
  }

  saveHealthState(state);
}

/**
 * Send a health alert to Aviv's private DM (with 24h cooldown to avoid spam).
 * If WhatsApp is unavailable, queues the alert and flushes on next initHealth() call.
 */
async function sendAlert(message) {
  const now = Date.now();
  if (now - _lastAlertTime < ALERT_COOLDOWN_MS) {
    logger.warn({ component: 'Health' }, 'Alert suppressed (cooldown): %s', message);
    return;
  }
  _lastAlertTime = now;
  logger.error({ component: 'Health' }, 'ALERT: %s', message);

  const alertMsg = `🚨 *Health Alert*\n${message}`;

  if (_client) {
    try {
      await _client.sendMessage(ALERT_TARGET, alertMsg);
      return;
    } catch (e) {
      logger.error({ component: 'Health', err: e.message }, 'Failed to send alert (WhatsApp down) — queuing');
    }
  }

  // WhatsApp unavailable — queue the alert to disk and flush on reconnect
  const state = loadHealthState();
  state.pendingAlerts = state.pendingAlerts || [];
  state.pendingAlerts.push({ msg: alertMsg, queuedAt: now });
  saveHealthState(state);
  logger.warn({ component: 'Health' }, 'Alert queued to disk for later delivery');
}

/**
 * Run checks and alert if failures found. Skips on Friday and Saturday (Israel time).
 */
async function checkAndAlert() {
  try {
    // Skip health checks on Friday (5) and Saturday (6) — groups are quiet on Shabbat
    const nowIsrael = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const dayOfWeek = nowIsrael.getDay(); // 0=Sun, 5=Fri, 6=Sat
    if (dayOfWeek === 5 || dayOfWeek === 6) {
      logger.info({ component: 'Health' }, 'Skipping checks — Friday/Saturday');
      return;
    }

    const failures = await runChecks();
    if (failures.length > 0) {
      await sendAlert(failures.join('\n'));
    } else {
      logger.info({ component: 'Health' }, 'All checks passed');
    }
  } catch (e) {
    logger.error({ component: 'Health', err: e.message }, 'checkAndAlert error');
  }
}

/**
 * Start periodic health checks every intervalMs.
 * Call after WhatsApp is connected.
 */
function startHealthMonitor(intervalMs = 5 * 60 * 1000) {
  logger.info({ component: 'Health', intervalS: intervalMs / 1000 }, 'Starting monitor');
  setInterval(checkAndAlert, intervalMs);
}

/**
 * Send an alert bypassing the cooldown — for critical events like disconnect.
 * Uses the same queue-to-disk fallback if client is unavailable.
 */
async function sendAlertDirect(message) {
  logger.error({ component: 'Health' }, 'DIRECT ALERT: %s', message);
  const alertMsg = `🚨 *Alert*\n${message}`;
  if (_client) {
    try { await _client.sendMessage(ALERT_TARGET, alertMsg); return; } catch (_) {}
  }
  const state = loadHealthState();
  state.pendingAlerts = state.pendingAlerts || [];
  state.pendingAlerts.push({ msg: alertMsg, queuedAt: Date.now() });
  saveHealthState(state);
}

// Cache the last real check result so the /health HTTP endpoint can serve it
// without shelling out per request. Populated by checkOpenClawChannel().
let _lastChannelResult = { ok: null, details: { pending: true } };

/** Parse a timestamp that may be epoch-ms (number) or an ISO/date string. */
function parseTimestamp(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Check OpenClaw WhatsApp channel status via CLI (async — does not block the event loop).
 * Returns { ok: true } if channel is linked+connected+healthy, or { ok: false, error, details }.
 * The result is cached in _lastChannelResult for the /health endpoint to reuse.
 */
async function checkOpenClawChannel() {
  let result;
  try {
    const { stdout } = await execFileAsync('openclaw', ['channels', 'status', '--json'], {
      timeout: 15000,
      encoding: 'utf8',
    });
    const data = JSON.parse(stdout);
    const wa = data.channels && data.channels.whatsapp;
    if (!wa) {
      result = { ok: false, error: 'OpenClaw WhatsApp channel not found in status', details: { channels: Object.keys(data.channels || {}) } };
    } else if (!wa.configured) {
      result = { ok: false, error: 'OpenClaw WhatsApp channel not configured', details: { configured: false } };
    } else if (!wa.linked) {
      result = { ok: false, error: 'OpenClaw WhatsApp channel not linked', details: { linked: false, statusState: wa.statusState } };
    } else if (!wa.connected) {
      result = { ok: false, error: 'OpenClaw WhatsApp channel disconnected', details: { connected: false, linked: wa.linked, statusState: wa.statusState } };
    } else if (wa.healthState && wa.healthState !== 'healthy') {
      result = { ok: false, error: `OpenClaw WhatsApp channel unhealthy (healthState: ${wa.healthState})`, details: { healthState: wa.healthState, connected: true, statusState: wa.statusState } };
    } else {
      // Connected + healthy — trust it. Silently-dead-socket detection is now
      // handled by the bot's active round-trip probe (/health-probe) plus
      // OpenClaw's own internal reconnection logic. Timestamps kept for info.
      const lastInboundAt = parseTimestamp(wa.lastInboundAt);
      const lastEventAt = parseTimestamp(wa.lastEventAt);
      result = { ok: true, details: { linked: true, connected: true, statusState: wa.statusState, healthState: wa.healthState, lastInboundAt, lastEventAt } };
    }
  } catch (e) {
    // CLI not available or timed out — don't fail the whole health check
    logger.warn({ component: 'Health', err: e.message }, 'Could not run openclaw channels status');
    result = { ok: true, details: { skipped: true, reason: e.message } };
  }
  _lastChannelResult = result;
  return result;
}

/**
 * Return the most recent checkOpenClawChannel() result without shelling out.
 * Used by the /health HTTP endpoint to avoid per-request subprocess overhead.
 */
function getLastOpenClawChannelResult() {
  return _lastChannelResult;
}

module.exports = { initHealth, runChecks, checkAndAlert, startHealthMonitor, sendAlertDirect, checkOpenClawChannel, getLastOpenClawChannelResult };
