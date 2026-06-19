/**
 * health.js — Periodic health checks for FamilyBot.
 * Runs every 5 minutes. Alerts master group on failures.
 */

const fs = require('fs');
const path = require('path');
const { getDB, clearExpiredPendingActions } = require('./db');
const { verifyCalendarAuth, generateAuthUrl } = require('./calendar');
const config = require('./config');

let _client = null;
let _masterGroupId = null;
let _lastAlertTime = 0;
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // max 1 alert per day
const ALERT_TARGET = process.env.AVIV_PHONE ? `${process.env.AVIV_PHONE}@c.us` : null; // send health alerts to primary parent DM

// Calendar re-auth cooldown — persisted to disk so it survives restarts
const CALENDAR_AUTH_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// Calendar auth is checked at most once per hour (it makes real API calls)
const CALENDAR_CHECK_INTERVAL_MS = 60 * 60 * 1000;
let _lastCalendarCheckMs = 0;
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
    console.warn('[Health] Could not save health state:', e.message);
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
        console.log('[Health] Flushed queued alert:', alert.msg.substring(0, 80));
      } catch (e) {
        console.error('[Health] Failed to flush alert:', e.message);
      }
    }
    state.pendingAlerts = [];
    saveHealthState(state);
  }

  // Flush any pending re-auth requests that were queued while client was unavailable
  if (state.pendingReauth) {
    for (const [key, entry] of Object.entries(state.pendingReauth)) {
      if (entry.pending && _client && _masterGroupId) {
        console.log(`[Health] Flushing pending re-auth for ${key}`);
        try {
          await _client.sendMessage(_masterGroupId, entry.msg);
          entry.pending = false;
          entry.sentAt = Date.now();
        } catch (e) {
          console.error(`[Health] Failed to flush re-auth for ${key}:`, e.message);
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

  // 3. WhatsApp client connected + receiving messages
  if (_client) {
    try {
      const state = await _client.getState();
      if (state !== 'CONNECTED') failures.push(`WhatsApp state: ${state}`);
    } catch (e) {
      failures.push(`WhatsApp state check error: ${e.message}`);
    }

    // ISSUE-009: Check message ingestion — alert if no messages received for 6h during working hours
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
        const gapMs = nowMs - lastMsgTs;
        const GAP_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours

        if (gapMs > GAP_THRESHOLD_MS) {
          // Don't alert if the gap is explained by Shabbat:
          // last message was on Friday or Saturday (Israel time), and today is Sat or Sun.
          const lastMsgIsraelDay = new Date(lastMsgTs + israelOffset).getUTCDay(); // 0=Sun,5=Fri,6=Sat
          const nowIsraelDay = new Date(nowMs + israelOffset).getUTCDay();
          const lastMsgWasWeekend = lastMsgIsraelDay === 5 || lastMsgIsraelDay === 6;
          const nowIsWeekendOrSundayMorning = nowIsraelDay === 6 ||
            (nowIsraelDay === 0 && israelHour < 14); // give until 14:00 Sunday
          if (lastMsgWasWeekend && nowIsWeekendOrSundayMorning) {
            console.log('[Health] Skipping ingestion alert — gap explained by Shabbat/weekend');
          } else {
            const hours = (gapMs / 3600000).toFixed(1);
            const lastStr = lastMsgTs ? new Date(lastMsgTs).toISOString() : 'never';
            failures.push(`⚠️ No messages from any group in ${hours}h (last: ${lastStr}) — WhatsApp connection may be broken`);
          }
        }
      }
    } catch (e) {
      console.warn('[Health] Ingestion check error:', e.message);
    }
  }

  // 4. Stale pending actions (> 30 min — indicates stuck confirmation flow)
  try {
    const db = getDB();
    const stale = db.prepare('SELECT COUNT(*) as c FROM pending_actions WHERE created_at < ?').get(Date.now() - 30 * 60 * 1000);
    if (stale && stale.c > 0) failures.push(`${stale.c} stale pending action(s) (>30 min)`);
    const cleared = clearExpiredPendingActions();
    if (cleared > 0) console.log(`[Health] Cleared ${cleared} expired pending action(s)`);
  } catch (_) {}

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
      console.log(`[Health] Sent calendar re-auth request for ${key}`);
      state.pendingReauth = state.pendingReauth || {};
      if (state.pendingReauth[key]) state.pendingReauth[key].pending = false;
    } catch (e) {
      console.error(`[Health] Failed to send re-auth for ${key}:`, e.message);
      // Queue for next boot
      state.pendingReauth = state.pendingReauth || {};
      state.pendingReauth[key] = { pending: true, msg, queuedAt: now };
    }
  } else {
    // Client not ready — queue for when it becomes ready
    console.warn(`[Health] Client not ready — queuing re-auth request for ${key}`);
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
    console.warn('[Health] Alert suppressed (cooldown):', message);
    return;
  }
  _lastAlertTime = now;
  console.error('[Health] ALERT:', message);

  const alertMsg = `🚨 *Health Alert*\n${message}`;

  if (_client) {
    try {
      await _client.sendMessage(ALERT_TARGET, alertMsg);
      return;
    } catch (e) {
      console.error('[Health] Failed to send alert (WhatsApp down) — queuing:', e.message);
    }
  }

  // WhatsApp unavailable — queue the alert to disk and flush on reconnect
  const state = loadHealthState();
  state.pendingAlerts = state.pendingAlerts || [];
  state.pendingAlerts.push({ msg: alertMsg, queuedAt: now });
  saveHealthState(state);
  console.warn('[Health] Alert queued to disk for later delivery');
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
      console.log('[Health] Skipping checks — Friday/Saturday');
      return;
    }

    const failures = await runChecks();
    if (failures.length > 0) {
      await sendAlert(failures.join('\n'));
    } else {
      console.log('[Health] ✅ All checks passed');
    }
  } catch (e) {
    console.error('[Health] checkAndAlert error:', e.message);
  }
}

/**
 * Start periodic health checks every intervalMs.
 * Call after WhatsApp is connected.
 */
function startHealthMonitor(intervalMs = 5 * 60 * 1000) {
  console.log(`[Health] Starting monitor (every ${intervalMs / 1000}s)`);
  setInterval(checkAndAlert, intervalMs);
}

/**
 * Send an alert bypassing the cooldown — for critical events like disconnect.
 * Uses the same queue-to-disk fallback if client is unavailable.
 */
async function sendAlertDirect(message) {
  console.error('[Health] DIRECT ALERT:', message);
  const alertMsg = `🚨 *Alert*\n${message}`;
  if (_client) {
    try { await _client.sendMessage(ALERT_TARGET, alertMsg); return; } catch (_) {}
  }
  const state = loadHealthState();
  state.pendingAlerts = state.pendingAlerts || [];
  state.pendingAlerts.push({ msg: alertMsg, queuedAt: Date.now() });
  saveHealthState(state);
}

module.exports = { initHealth, runChecks, checkAndAlert, startHealthMonitor, sendAlertDirect };
