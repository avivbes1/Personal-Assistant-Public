'use strict';
/**
 * bridge/exporterJob.js — the Instinct Bridge export cycle.
 *
 * Runs every minute (scheduler.js). Claims a batch of pending outbox events,
 * validates each payload, wraps them in one envelope, hands it to the transport
 * (shadow mode for now), and marks each row delivered/failed. A single cycle is
 * the whole unit of work — no long-running loop, so it can never time out
 * (P-002).
 *
 * P-021: records a heartbeat on every real cycle so a silently-dead job is
 * detectable by absence, not just by error.
 * P-026: the whole cycle is best-effort and no-ops when the bridge is disabled;
 * it never touches core message/notice flow.
 */

const bridgeConfig = require('./config');
const { buildEnvelope } = require('./envelope');
const { claimBatch, markDelivered, markFailed } = require('./outboxRepository');
const { sendBatch } = require('./emailTransport');

function emptyStats(extra) {
  return Object.assign({ enqueued: 0, delivered: 0, failed: 0, deadLettered: 0 }, extra || {});
}

/** A claimed row is valid if its payload parsed and carries a known kind. */
function isValidRecord(row) {
  return !!(row && row.payload && (row.payload.kind === 'message' || row.payload.kind === 'notice'));
}

/**
 * Run one export cycle. Returns {enqueued, delivered, failed, deadLettered}.
 */
async function runExporterCycle() {
  // Respect the on-switch. A disabled or misconfigured bridge does nothing and
  // writes no heartbeat (it isn't a job that's expected to run).
  if (!bridgeConfig.enabled) return emptyStats({ skipped: 'disabled' });
  if (!bridgeConfig.valid) {
    recordHeartbeat('error');
    return emptyStats({ skipped: 'invalid_config' });
  }

  let claimed;
  try {
    claimed = claimBatch(bridgeConfig.batchSize);
  } catch (err) {
    console.error('[Bridge] claimBatch failed:', err.message);
    recordHeartbeat('error');
    return emptyStats({ error: err.message });
  }

  if (!claimed || claimed.length === 0) {
    recordHeartbeat('empty');
    return emptyStats();
  }

  // Separate valid records from unparseable/unknown ones. Bad rows fail
  // immediately (they'll dead-letter rather than block the batch forever).
  const good = claimed.filter(isValidRecord);
  const bad = claimed.filter(r => !isValidRecord(r));

  const stats = emptyStats();

  for (const row of bad) {
    const r = markFailed(row.id, new Error('invalid or unparseable payload'));
    if (r.status === 'dead') stats.deadLettered++; else stats.failed++;
  }

  if (good.length > 0) {
    const envelope = buildEnvelope(bridgeConfig.stream, good.map(r => r.payload));
    try {
      const result = sendBatch(envelope);
      if (!result || !result.ok) throw new Error((result && result.error) || 'transport returned not-ok');
      for (const row of good) {
        markDelivered(row.id, result.provider_message_id);
        stats.delivered++;
      }
    } catch (err) {
      console.error('[Bridge] sendBatch failed:', err.message);
      for (const row of good) {
        const r = markFailed(row.id, err);
        if (r.status === 'dead') stats.deadLettered++; else stats.failed++;
      }
    }
  }

  recordHeartbeat(stats.delivered > 0 ? 'ok' : (stats.failed + stats.deadLettered > 0 ? 'error' : 'empty'));
  return stats;
}

function recordHeartbeat(result) {
  try {
    require('../db').recordJobHeartbeat('instinct_bridge_export', result);
  } catch (err) {
    console.warn('[Bridge] heartbeat write failed (non-fatal):', err.message);
  }
}

module.exports = { runExporterCycle };
