/**
 * groupReconciliation.js
 * Detects monitored groups that have gone silent (events stopped firing)
 * and attempts recovery by force-syncing via WhatsApp Web store internals.
 *
 * Runs on startup (60s after ready) and every 6 hours.
 */

const { getDB } = require('./db');
const config = require('./config');

const SILENT_THRESHOLD_MS       = 5  * 24 * 60 * 60 * 1000; // scan if no msgs for 5+ days
const ALERT_THRESHOLD_MS        = 30 * 24 * 60 * 60 * 1000; // DM alert only if 30+ days silent (avoids end-of-year noise)
const RECENTLY_ACTIVE_MS        = 30 * 24 * 60 * 60 * 1000; // only scan if was active in last 30d
const RECONCILIATION_INTERVAL_MS = 6 * 60 * 60 * 1000;      // run every 6h

let _client        = null;
let _masterGroupId = null;
let _avivDm        = config.AVIV_PHONE ? `${config.AVIV_PHONE}@c.us` : null;
let _scanFn        = null; // scanGroupHistory(chat, opts) — injected from whatsapp.js

function init(client, masterGroupId, scanGroupHistory) {
  _client        = client;
  _masterGroupId = masterGroupId;
  _scanFn        = scanGroupHistory;
}

/**
 * Returns monitored groups that:
 * - Had messages in the last 30 days (so we don't alert on dead groups)
 * - Have had NO messages in the last 5 days
 */
function getSilentActiveGroups() {
  const now     = Date.now();
  const cutoff  = now - SILENT_THRESHOLD_MS;
  const recentCutoff = now - RECENTLY_ACTIVE_MS;

  return getDB().prepare(`
    SELECT g.id, g.name,
      MAX(m.timestamp) as last_msg_ts,
      COUNT(m.id) as total_msgs
    FROM groups g
    JOIN messages m ON m.group_id = g.id
    WHERE g.related_to = 'monitored'
    GROUP BY g.id
    HAVING last_msg_ts >= ? AND last_msg_ts < ?
    ORDER BY last_msg_ts ASC
  `).all(recentCutoff, cutoff);
}



/**
 * Alert Aviv via DM (private, not family group).
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
  // Mark acknowledged so we don't re-alert on subsequent runs
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
 * Main reconciliation pass.
 * - Find silent-but-recently-active monitored groups
 * - Force-sync each one
 * - Alert Aviv once per incident (acknowledgment-based suppression)
 * - Resolve incident when group becomes active again
 */
async function reconcileGroups() {
  if (!_client) return;

  try {
    const silentGroups = getSilentActiveGroups();

    // Resolve incidents for groups that are now active
    const activeGroups = getDB().prepare(`
      SELECT g.id FROM groups g
      JOIN messages m ON m.group_id = g.id
      WHERE g.related_to = 'monitored'
      GROUP BY g.id
      HAVING MAX(m.timestamp) >= ?
    `).all(Date.now() - SILENT_THRESHOLD_MS);

    for (const g of activeGroups) {
      if (incidentIsOpen(g.id)) {
        console.log(`[Reconciliation] ✅ Group recovered, closing incident: ${g.id}`);
        resolveIncident(g.id);
      }
    }

    if (silentGroups.length === 0) {
      console.log('[Reconciliation] All recently-active monitored groups have recent messages ✅');
      return;
    }

    console.log(`[Reconciliation] Found ${silentGroups.length} silent group(s) to investigate`);

    for (const group of silentGroups) {
      const daysSilent = Math.floor((Date.now() - group.last_msg_ts) / 86400000);
      const lastDate   = new Date(group.last_msg_ts).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });

      // Already have an open incident — skip, we already warned once
      if (incidentIsOpen(group.id)) {
        console.log(`[Reconciliation] "${group.name}" still silent (${daysSilent}d) — incident open, skipping re-alert`);
        continue;
      }

      console.log(`[Reconciliation] Silent: "${group.name}" — ${daysSilent}d (last: ${lastDate})`);

      // Find the live chat object
      const chats    = await _client.getChats();
      const liveChat = chats.find(c => c.id._serialized === group.id);

      if (!liveChat) {
        console.warn(`[Reconciliation] "${group.name}" not found in live session`);
        openIncident(group.id);
        await alertAviv(
          `⚠️ [Lipa] קבוצה לא נמצאת בסשן:\n` +
          `*${group.name}*\n` +
          `ייתכן שהבוט הוצא מהקבוצה, או שמספר הקבוצה השתנה.`
        );
        continue;
      }

      // Re-scan with extended window (10 days) — fetchMessages pulls from server
      if (_scanFn) {
        await _scanFn(liveChat, { saveDays: 10, parseDays: 10 });
      }

      // Check if we recovered anything
      const recovered = getDB().prepare(
        'SELECT COUNT(*) as c FROM messages WHERE group_id = ? AND timestamp > ?'
      ).get(group.id, Date.now() - SILENT_THRESHOLD_MS);

      if (recovered.c > 0) {
        console.log(`[Reconciliation] ✅ Recovered messages for "${group.name}" (${recovered.c} in window)`);
        resolveIncident(group.id); // in case there was a prior resolved incident
      } else {
        console.warn(`[Reconciliation] ⚠️ "${group.name}" still silent after force-sync (${daysSilent}d) — opening incident`);
        openIncident(group.id);
        // Alert Aviv once
        await alertAviv(
          `⚠️ [Lipa] קבוצה שקטה — לא מקבל הודעות:\n` +
          `*${group.name}*\n` +
          `הודעה אחרונה: ${lastDate} (לפני ${daysSilent} ימים)\n` +
          `ניסיתי לסנכרן מחדש — לא הצלחתי לשחזר הודעות.`
        );
      }
    }
  } catch (err) {
    console.error('[Reconciliation] Error:', err.message);
  }
}

/**
 * Start the periodic reconciliation job.
 * Call after client is ready.
 */
function startReconciliation(client, masterGroupId, scanGroupHistory) {
  init(client, masterGroupId, scanGroupHistory);

  // First run: 60s after ready (give WhatsApp time to fully sync)
  setTimeout(reconcileGroups, 60 * 1000);

  // Recurring: every 6h
  setInterval(reconcileGroups, RECONCILIATION_INTERVAL_MS);

  console.log('[Reconciliation] Started (first check in 60s, then every 6h)');
}

module.exports = { startReconciliation, reconcileGroups };
