/**
 * groupReconciliation.js
 * Silently checks monitored groups for silence and tracks incidents.
 * Uses Baileys-native APIs (no whatsapp-web.js shims).
 *
 * Runs on startup (60s after ready) and every ~60 minutes (with jitter).
 *
 * Thresholds:
 *   - Daytime (08:00–22:00 Israel): 4 hours
 *   - Nighttime: 12 hours
 *
 * Circuit breaker: after 3 consecutive errors, backs off to 6 hours.
 */

const { getDB } = require('./db');
const config = require('./config');
const { getIsraelHour } = require('./timeUtils');

const RECENTLY_ACTIVE_MS         = 30 * 24 * 60 * 60 * 1000; // only check groups active in last 30d
const RECONCILIATION_INTERVAL_MS = 60 * 60 * 1000;           // base interval: 60 min
const JITTER_MS                  = 5  * 60 * 1000;           // ±5 min random jitter
const BACKOFF_INTERVAL_MS        = 6  * 60 * 60 * 1000;      // 6h after circuit trips
const MAX_CONSECUTIVE_ERRORS     = 3;

let _client        = null;
let _masterGroupId = null;
let _avivDm        = config.AVIV_PHONE ? `${config.AVIV_PHONE}@c.us` : null;
let _scanFn        = null; // scanGroupHistory(chat, opts) — injected from whatsapp.js
let _timer         = null;
let _consecutiveErrors = 0;

/**
 * Get silence threshold based on Israel time of day.
 */
function getSilentThresholdMs() {
  const hour = getIsraelHour();
  if (hour >= 8 && hour < 22) {
    return 4 * 60 * 60 * 1000;   // 4 hours daytime
  }
  return 12 * 60 * 60 * 1000;    // 12 hours nighttime
}

function init(client, masterGroupId, scanGroupHistory) {
  _client        = client;
  _masterGroupId = masterGroupId;
  _scanFn        = scanGroupHistory;
}

/**
 * Returns monitored groups that:
 * - Had messages in the last 30 days (not dead groups)
 * - Have had NO messages within the current silence threshold
 */
function getSilentActiveGroups() {
  const now            = Date.now();
  const silentThreshold = getSilentThresholdMs();
  const cutoff         = now - silentThreshold;
  const recentCutoff   = now - RECENTLY_ACTIVE_MS;

  return getDB().prepare(`
    SELECT g.id, g.name,
      MAX(m.timestamp) as last_msg_ts,
      COUNT(m.id) as total_msgs
    FROM groups g
    JOIN messages m ON m.group_id = g.id
    WHERE g.monitored = 1
    GROUP BY g.id
    HAVING last_msg_ts >= ? AND last_msg_ts < ?
    ORDER BY last_msg_ts ASC
  `).all(recentCutoff, cutoff);
}

/**
 * Alert Aviv via DM.
 */
async function alertAviv(text) {
  try {
    if (_client && _avivDm) await _client.sendMessage(_avivDm, text);
  } catch (err) {
    console.warn('[Reconciliation] Could not send DM to Aviv:', err.message);
  }
}

// --- Silence incident helpers ---

function getIncident(groupId) {
  return getDB().prepare('SELECT * FROM silence_incidents WHERE group_id = ?').get(groupId);
}

function openIncident(groupId) {
  getDB().prepare(
    'INSERT OR IGNORE INTO silence_incidents (group_id, first_detected_at) VALUES (?, ?)'
  ).run(groupId, Date.now());
  getDB().prepare(
    'UPDATE silence_incidents SET acknowledged_at = ? WHERE group_id = ? AND acknowledged_at IS NULL'
  ).run(Date.now(), groupId);
}

function resolveIncident(groupId) {
  getDB().prepare(
    'UPDATE silence_incidents SET resolved_at = ? WHERE group_id = ? AND resolved_at IS NULL'
  ).run(Date.now(), groupId);
}

function incidentIsOpen(groupId) {
  const row = getIncident(groupId);
  return row && row.resolved_at == null;
}

/**
 * Get the set of group JIDs the bot is actually participating in (Baileys-native).
 * Returns a Map of jid → group metadata.
 */
async function fetchParticipatingGroups() {
  const sock = _client && _client._sock;
  if (!sock) return new Map();

  try {
    const groups = await sock.groupFetchAllParticipating();
    return new Map(Object.entries(groups));
  } catch (err) {
    console.warn('[Reconciliation] groupFetchAllParticipating failed:', err.message);
    // Fallback to cached group data on the client
    return _client._groupCache || new Map();
  }
}

/**
 * Main reconciliation pass.
 * - Find silent-but-recently-active monitored groups
 * - Verify group membership via Baileys native API
 * - Attempt force-sync via scanGroupHistory if available
 * - Track incidents (acknowledgment-based suppression)
 * - Resolve incidents when groups become active again
 */
async function reconcileGroups() {
  if (!_client) return;

  try {
    const silentThreshold = getSilentThresholdMs();
    const thresholdLabel = silentThreshold < 12 * 60 * 60 * 1000
      ? `${silentThreshold / (60 * 60 * 1000)}h (daytime)`
      : `${silentThreshold / (60 * 60 * 1000)}h (nighttime)`;

    // Fetch live group participation via Baileys native API
    const liveGroups = await fetchParticipatingGroups();

    const silentGroups = getSilentActiveGroups();

    // Resolve incidents for groups that are now active
    const activeGroups = getDB().prepare(`
      SELECT g.id FROM groups g
      JOIN messages m ON m.group_id = g.id
      WHERE g.monitored = 1
      GROUP BY g.id
      HAVING MAX(m.timestamp) >= ?
    `).all(Date.now() - silentThreshold);

    for (const g of activeGroups) {
      if (incidentIsOpen(g.id)) {
        console.log(`[Reconciliation] ✅ Group recovered, closing incident: ${g.id}`);
        resolveIncident(g.id);
      }
    }

    if (silentGroups.length === 0) {
      console.log(`[Reconciliation] All recently-active monitored groups have recent messages ✅ (threshold: ${thresholdLabel})`);
      _consecutiveErrors = 0;
      return;
    }

    console.log(`[Reconciliation] Found ${silentGroups.length} silent group(s) to investigate (threshold: ${thresholdLabel})`);

    for (const group of silentGroups) {
      const hoursSilent = Math.round((Date.now() - group.last_msg_ts) / (60 * 60 * 1000));
      const lastDate = new Date(group.last_msg_ts).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
      const lastTime = new Date(group.last_msg_ts).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });

      // Already have an open incident — skip re-processing
      if (incidentIsOpen(group.id)) {
        console.log(`[Reconciliation] "${group.name}" still silent (${hoursSilent}h) — incident open, skipping`);
        continue;
      }

      console.log(`[Reconciliation] Silent: "${group.name}" — ${hoursSilent}h (last: ${lastDate} ${lastTime})`);

      // Check if the group exists in Baileys live session using raw JID
      // group.id is already in Baileys-compatible @g.us format
      const groupJid = group.id;
      const liveMeta = liveGroups.get(groupJid);

      if (!liveMeta) {
        console.warn(`[Reconciliation] "${group.name}" (${groupJid}) not found in live session — handled by health monitor`);
        openIncident(groupJid);
        continue;
      }

      // Attempt force-sync via the injected scanGroupHistory function
      if (_scanFn) {
        try {
          // Build a minimal chat object compatible with scanGroupHistory
          // Use the BaileysClient.getChatById which returns a BaileysChat
          const chat = await _client.getChatById(groupJid);
          await _scanFn(chat, { saveDays: 3, parseDays: 1 });
        } catch (err) {
          console.warn(`[Reconciliation] Force-sync failed for "${group.name}": ${err.message}`);
        }
      }

      // Check if we recovered anything after sync attempt
      const recovered = getDB().prepare(
        'SELECT COUNT(*) as c FROM messages WHERE group_id = ? AND timestamp > ?'
      ).get(groupJid, Date.now() - silentThreshold);

      if (recovered.c > 0) {
        console.log(`[Reconciliation] ✅ Recovered messages for "${group.name}" (${recovered.c} in window)`);
        resolveIncident(groupJid);
      } else {
        console.log(`[Reconciliation] "${group.name}" still silent after check (${hoursSilent}h) — opening incident`);
        openIncident(groupJid);
      }
    }

    // Success — reset circuit breaker
    _consecutiveErrors = 0;
  } catch (err) {
    _consecutiveErrors++;
    console.error(`[Reconciliation] Error (consecutive: ${_consecutiveErrors}):`, err.message);

    if (_consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.warn(`[Reconciliation] ⚠️ Circuit breaker tripped (${_consecutiveErrors} consecutive errors) — backing off to 6h`);
    }
  }
}

/**
 * Schedule the next reconciliation run with jitter.
 * Respects circuit breaker backoff.
 */
function scheduleNext() {
  if (_timer) clearTimeout(_timer);

  let interval;
  if (_consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    interval = BACKOFF_INTERVAL_MS;
  } else {
    const jitter = Math.floor(Math.random() * JITTER_MS * 2) - JITTER_MS; // ±5 min
    interval = RECONCILIATION_INTERVAL_MS + jitter;
  }

  _timer = setTimeout(async () => {
    await reconcileGroups();
    scheduleNext();
  }, interval);
}

/**
 * Start the periodic reconciliation job.
 * Call after client is ready.
 */
function startReconciliation(client, masterGroupId, scanGroupHistory) {
  init(client, masterGroupId, scanGroupHistory);

  // First run: 60s after ready
  setTimeout(async () => {
    await reconcileGroups();
    scheduleNext();
  }, 60 * 1000);

  console.log('[Reconciliation] Started (first check in 60s, then every ~60min with ±5min jitter)');
}

module.exports = { startReconciliation, reconcileGroups };
