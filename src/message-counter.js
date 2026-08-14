/**
 * message-counter.js — Rolling counter of messages persisted in the last 5 minutes.
 * Used by the health endpoint to surface throughput metrics.
 */

const WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const _timestamps = [];

/**
 * Record that a message was persisted right now.
 */
function recordMessagePersisted() {
  _timestamps.push(Date.now());
}

/**
 * Get the count of messages persisted in the last 5 minutes.
 * Also prunes old entries.
 */
function getMessagesPersisted5Min() {
  const cutoff = Date.now() - WINDOW_MS;
  // Prune old entries
  while (_timestamps.length > 0 && _timestamps[0] < cutoff) {
    _timestamps.shift();
  }
  return _timestamps.length;
}

module.exports = { recordMessagePersisted, getMessagesPersisted5Min };
