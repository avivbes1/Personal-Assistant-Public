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
const { claimBatch, markDelivered, markFailed, markNeedsReview, releaseClaim } = require('./outboxRepository');
const { sendBatch, isBillingError, isUncertainError } = require('./emailTransport');
const billingState = require('./billingState');

function emptyStats(extra) {
  return Object.assign(
    { enqueued: 0, delivered: 0, failed: 0, deadLettered: 0, needsReview: 0 },
    extra || {}
  );
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

  // Billing circuit breaker: while tripped, claim nothing and send nothing so a
  // paused account is never contacted and rows stay pending for after unpause.
  // A warning is logged on every skipped cycle (P-026: this only ever trips on a
  // real provider billing error, never on an estimate).
  if (billingState.isBillingPaused()) {
    const st = billingState.getBillingState();
    console.warn(
      `[Bridge] export cycle SKIPPED — billing paused since ${st.paused_at || 'unknown'} ` +
      `(${st.error || 'no error recorded'}). Unpause manually after restoring credit.`
    );
    recordHeartbeat('empty');
    return emptyStats({ skipped: 'billing_paused' });
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
    const r = markFailed(row.id, new Error('invalid or unparseable payload'), row.claim_generation);
    if (r.status === 'dead') stats.deadLettered++;
    else if (r.status !== 'stale') stats.failed++;
  }

  if (good.length > 0) {
    const envelope = buildEnvelope(bridgeConfig.stream, good.map(r => r.payload));
    try {
      const result = await sendBatch(envelope);
      if (result && result.skipped === 'billing_paused') {
        // Transport declined because the breaker is set — release the rows back
        // to the queue (no attempt consumed) so they go out once unpaused.
        for (const row of good) releaseClaim(row.id, row.claim_generation);
        stats.skipped = 'billing_paused';
      } else if (!result || !result.ok) {
        throw new Error((result && result.error) || 'transport returned not-ok');
      } else {
        for (const row of good) {
          const r = markDelivered(row.id, result.provider_message_id, row.claim_generation);
          if (r.status === 'delivered') stats.delivered++;
        }
      }
    } catch (err) {
      console.error('[Bridge] sendBatch failed:', err.message);
      if (isBillingError(err)) {
        // Trip the breaker on a REAL provider billing failure, then release the
        // claimed rows (no attempt consumed — the outage isn't their fault).
        billingState.pauseBilling(err);
        console.warn('[Bridge] billing error detected — bridge sends PAUSED:', err.message);
        for (const row of good) releaseClaim(row.id, row.claim_generation);
        stats.skipped = 'billing_paused';
      } else if (isUncertainError(err)) {
        // Delivery is ambiguous (timeout/dropped socket after possible accept) —
        // park for review rather than risk a duplicate on blind retry.
        for (const row of good) {
          const r = markNeedsReview(row.id, err.message, row.claim_generation);
          if (r.status === 'needs_review') stats.needsReview++;
        }
      } else {
        for (const row of good) {
          const r = markFailed(row.id, err, row.claim_generation);
          if (r.status === 'dead') stats.deadLettered++;
          else if (r.status !== 'stale') stats.failed++;
        }
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
