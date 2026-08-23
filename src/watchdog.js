/**
 * watchdog.js — Three-layer zombie detection for the WhatsApp bot.
 *
 * Layer 1: Passive event tracking (last notify message, secondary heartbeat signals)
 * Layer 2: Active probe (sendPresenceUpdate with timeout)
 * Layer 3: History monotonicity (fetch 1 message, compare ID)
 *
 * Escalation: time-windowed (1h sliding window)
 *   - 1 zombie reset in 1h → log + reconnect via sock.ws.close()
 *   - 3 zombie resets in 1h → write /tmp/bot-stuck-alert.json, stop auto-reconnect
 */

const fs = require('fs');
const { getIsraelHour } = require('./timeUtils');
const logger = require('./logger');

// ── Thresholds ──
const DAYTIME_STALE_MS    = 45 * 60 * 1000;       // 45min during daytime (08–22)
const NIGHTTIME_STALE_MS  = 10 * 60 * 60 * 1000;  // 10h during nighttime
const PRESENCE_TIMEOUT_MS = 10 * 1000;             // 10s for active probe
const CHECK_INTERVAL_MS   = 60 * 1000;             // every 60s
const ESCALATION_WINDOW_MS = 60 * 60 * 1000;       // 1h sliding window

// ── State ──
let _sock = null;
let _onEscalate = null; // callback(action, reason) — 'reconnect' or 'escalate'
let _checkInterval = null;

const _state = {
  lastNotifyTs: 0,          // timestamp of last type=notify message upsert
  lastHeartbeatTs: 0,       // timestamp of last secondary signal (creds, chats, contacts, etc.)
  lastHistoryMsgId: null,   // last fetched message ID for monotonicity check
  identicalHistoryCount: 0, // consecutive identical history results
  presenceFailCount: 0,     // consecutive presence probe failures
  zombieResets: [],          // timestamps of resets within sliding window
  started: false,
  stopped: false,           // true when escalation stops auto-reconnect
};

/**
 * Called from messages.upsert handler when type === 'notify'.
 */
function onNotify() {
  _state.lastNotifyTs = Date.now();
  // Reset failure counters on real activity
  _state.presenceFailCount = 0;
  _state.identicalHistoryCount = 0;
}

/**
 * Called for secondary heartbeat signals (creds.update, chats.update, etc.)
 */
function onHeartbeat() {
  _state.lastHeartbeatTs = Date.now();
}

/**
 * Attach watchdog to the Baileys socket.
 * @param {object} sock — Baileys socket instance
 * @param {function} escalateCallback — (action: 'reconnect'|'escalate', reason: string) => void
 */
function attachToSocket(sock, escalateCallback) {
  _sock = sock;
  _onEscalate = escalateCallback;

  // Initialize timestamps on attach (give benefit of the doubt)
  const now = Date.now();
  if (!_state.lastNotifyTs) _state.lastNotifyTs = now;
  if (!_state.lastHeartbeatTs) _state.lastHeartbeatTs = now;

  // Start check loop if not already running
  if (!_state.started) {
    _state.started = true;
    _state.stopped = false;
    _checkInterval = setInterval(runCheck, CHECK_INTERVAL_MS);
    _checkInterval.unref(); // don't keep process alive
    logger.info({ component: 'Watchdog' }, 'Started (60s interval, 3-layer zombie detection)');
  }
}

/**
 * Update socket reference (after reconnect creates new socket).
 */
function updateSocket(sock) {
  _sock = sock;
}

/**
 * Stop the watchdog (for clean shutdown).
 */
function stop() {
  if (_checkInterval) {
    clearInterval(_checkInterval);
    _checkInterval = null;
  }
  _state.started = false;
  logger.info({ component: 'Watchdog' }, 'Stopped');
}

/**
 * Get current watchdog state (for health endpoint).
 */
function getState() {
  const now = Date.now();
  const hour = getIsraelHour(now);
  const isDaytime = hour >= 8 && hour < 22;
  const staleThreshold = isDaytime ? DAYTIME_STALE_MS : NIGHTTIME_STALE_MS;
  const notifyAge = _state.lastNotifyTs ? now - _state.lastNotifyTs : null;
  const heartbeatAge = _state.lastHeartbeatTs ? now - _state.lastHeartbeatTs : null;

  return {
    started: _state.started,
    stopped: _state.stopped,
    isDaytime,
    lastNotifyTs: _state.lastNotifyTs,
    lastNotifyAgeMs: notifyAge,
    lastHeartbeatTs: _state.lastHeartbeatTs,
    lastHeartbeatAgeMs: heartbeatAge,
    staleThresholdMs: staleThreshold,
    isStale: notifyAge !== null ? notifyAge > staleThreshold : false,
    presenceFailCount: _state.presenceFailCount,
    identicalHistoryCount: _state.identicalHistoryCount,
    zombieResetsInWindow: _state.zombieResets.filter(ts => now - ts < ESCALATION_WINDOW_MS).length,
  };
}

// ── Internal check logic ──

async function runCheck() {
  if (_state.stopped) return; // escalated, don't check anymore

  try {
    const now = Date.now();
    const hour = getIsraelHour(now);
    const isDaytime = hour >= 8 && hour < 22;
    const staleThreshold = isDaytime ? DAYTIME_STALE_MS : NIGHTTIME_STALE_MS;

    // Layer 1: Passive event tracking
    const notifyAge = now - _state.lastNotifyTs;
    const heartbeatAge = now - _state.lastHeartbeatTs;

    // If we have recent notify messages, everything is fine
    if (notifyAge < staleThreshold) return;

    // If heartbeat signals are fresh (within half the stale threshold), give benefit of doubt
    if (heartbeatAge < staleThreshold / 2) return;

    logger.warn({ component: 'Watchdog', notifyAgeMin: Math.round(notifyAge / 60000), heartbeatAgeMin: Math.round(heartbeatAge / 60000) }, 'Layer 1 triggered: stale notify and heartbeat');

    // Layer 2: Active probe
    const probeOk = await activeProbe();
    if (probeOk) {
      // Socket is alive, just quiet period — reset presence fail count
      _state.presenceFailCount = 0;
      return;
    }

    _state.presenceFailCount++;
    logger.warn({ component: 'Watchdog', consecutiveFails: _state.presenceFailCount }, 'Layer 2: presence probe failed');

    if (_state.presenceFailCount < 2) return; // need 2 consecutive failures

    // Layer 3: History monotonicity (daytime only)
    if (isDaytime) {
      const historyChanged = await checkHistoryMonotonicity();
      if (historyChanged) {
        // History is changing, socket might be temporarily unresponsive
        logger.info({ component: 'Watchdog' }, 'Layer 3: history is changing, deferring zombie action');
        return;
      }

      _state.identicalHistoryCount++;
      logger.warn({ component: 'Watchdog', consecutiveIdentical: _state.identicalHistoryCount }, 'Layer 3: identical history');

      if (_state.identicalHistoryCount < 3) return; // need 3 consecutive identical
    }

    // ── Zombie detected — escalate ──
    const reason = `no notify for ${Math.round(notifyAge / 60000)}min, presence probe failed ${_state.presenceFailCount}x` +
      (isDaytime ? `, history static ${_state.identicalHistoryCount}x` : '');

    triggerEscalation(reason);
  } catch (e) {
    logger.error({ component: 'Watchdog', err: e.message }, 'Check error');
  }
}

async function activeProbe() {
  if (!_sock) return false;
  try {
    const result = await Promise.race([
      _sock.sendPresenceUpdate('available').then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), PRESENCE_TIMEOUT_MS)),
    ]);
    return result;
  } catch (e) {
    logger.warn({ component: 'Watchdog', err: e.message }, 'Presence probe error');
    return false;
  }
}

async function checkHistoryMonotonicity() {
  if (!_sock) return false;
  try {
    // Fetch 1 message from a known active group (master group)
    const masterJid = '120363426994367917@g.us';
    const messages = await Promise.race([
      _sock.fetchMessageHistory(1, { remoteJid: masterJid }, null).catch(() => null),
      new Promise(resolve => setTimeout(() => resolve(null), 10000)),
    ]);

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      // fetchMessageHistory may not be available in all Baileys versions
      // Fall back to treating as "changed" to avoid false positives
      return true;
    }

    const msgId = messages[0]?.key?.id;
    if (!msgId) return true;

    const changed = msgId !== _state.lastHistoryMsgId;
    _state.lastHistoryMsgId = msgId;

    if (changed) {
      _state.identicalHistoryCount = 0;
    }

    return changed;
  } catch (e) {
    // If the method doesn't exist or fails, don't trigger false zombie
    logger.warn({ component: 'Watchdog', err: e.message }, 'History check unavailable');
    return true; // treat as changed to avoid false positives
  }
}

function triggerEscalation(reason) {
  const now = Date.now();

  // Clean sliding window
  _state.zombieResets = _state.zombieResets.filter(ts => now - ts < ESCALATION_WINDOW_MS);
  _state.zombieResets.push(now);

  // Reset detection counters
  _state.presenceFailCount = 0;
  _state.identicalHistoryCount = 0;
  // Reset lastNotifyTs to avoid re-triggering immediately after reconnect
  _state.lastNotifyTs = now;
  _state.lastHeartbeatTs = now;

  const resetsInWindow = _state.zombieResets.length;

  if (resetsInWindow >= 3) {
    // 3 resets in 1h — escalate, stop auto-reconnect
    logger.error({ component: 'Watchdog', resetsInWindow }, 'ESCALATION: zombie resets in 1h — stopping auto-reconnect');
    _state.stopped = true;
    if (_onEscalate) _onEscalate('escalate', reason);
  } else {
    // 1-2 resets — reconnect
    logger.warn({ component: 'Watchdog', resetNumber: resetsInWindow }, 'Zombie reset in 1h — triggering reconnect');
    if (_onEscalate) _onEscalate('reconnect', reason);
  }
}

module.exports = {
  onNotify,
  onHeartbeat,
  attachToSocket,
  updateSocket,
  stop,
  getState,
};
