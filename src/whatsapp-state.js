/**
 * whatsapp-state.js — Pure derivation of the bot's WhatsApp connection state.
 *
 * Extracted from whatsapp.js getHealthState() (I2) so the truthfulness logic —
 * "connected only when the socket is ready, not stale, and not awaiting a QR" —
 * is unit-testable without booting the client or the HTTP server.
 *
 * whatsapp_connected was historically `!!(client && client.info)`, which is
 * always true once the client object is constructed (client.info is populated in
 * the constructor). That reported "connected" through outages. This module ties
 * the boolean to a genuine 'connected' state instead.
 */
'use strict';

// Presence-probe failures at/above this count mean the socket is a zombie.
const PRESENCE_FAIL_LIMIT = 10;

/**
 * @param {object} p
 * @param {boolean} p.hasClient   a client object exists (client && client.info)
 * @param {boolean} p.isReady     socket reports ready (BaileysClient.isReady getter)
 * @param {boolean} p.awaitingQr  a QR is being shown / session not established
 * @param {object|null} p.watchdogState  from watchdog.getState() (null pre-connect)
 * @returns {{ whatsapp_connected: boolean, whatsapp_state: ('connected'|'stale'|'awaiting_qr'|'disconnected') }}
 */
function deriveConnectionState({ hasClient, isReady, awaitingQr, watchdogState }) {
  const wd = watchdogState || null;
  const stale = !!(wd && (wd.isStale || wd.presenceFailCount >= PRESENCE_FAIL_LIMIT));
  // watchdogState is null before the socket opens (the watchdog attaches on
  // 'open'), so a null watchdog is treated as "not yet stale".
  const live = !stale;

  let whatsapp_state;
  if (!hasClient) whatsapp_state = 'disconnected';
  else if (awaitingQr) whatsapp_state = 'awaiting_qr';
  else if (stale) whatsapp_state = 'stale';
  else if (isReady && live) whatsapp_state = 'connected';
  else whatsapp_state = 'disconnected';

  return { whatsapp_connected: whatsapp_state === 'connected', whatsapp_state };
}

module.exports = { deriveConnectionState, PRESENCE_FAIL_LIMIT };
