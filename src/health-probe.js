/**
 * health-probe.js — Active round-trip health probe for the WhatsApp bot.
 *
 * Sends a uniquely-tagged message to the test group and waits to observe the
 * exact same text arrive back through the messages.upsert stream (as a fromMe
 * echo). This confirms the full send→receive loop is actually alive, which a
 * socket "connected" flag alone does not guarantee (see the silently-dead
 * socket failure mode handled in health.js / watchdog.js).
 *
 * Wiring:
 *   - baileys-client.js calls attachSocket()/updateSocket() as the socket is
 *     created/recreated. We register our OWN messages.upsert listener on the
 *     socket here rather than relying on the main handler, because that handler
 *     filters to type==='notify' and Baileys delivers fromMe sent-message echoes
 *     as type 'append', not 'notify' — so the probe echo would never be seen.
 *   - voice-server.js exposes runProbe() over GET /health-probe.
 */

const logger = require('./logger');

// 'Lipa test' group — a low-traffic group safe to send probe pings into.
const TEST_GROUP_JID = '120363410168878869@g.us';
const PROBE_TIMEOUT_MS = 15 * 1000;

let _sock = null;

// Single in-flight probe, or null when idle. Acts as the concurrency guard.
// Shape: { text, resolve, sentAt, timer }
let _pending = null;

/**
 * Register a probe-only messages.upsert listener on the socket. Unlike the main
 * handler in baileys-client.js, this does NOT filter by type — it inspects every
 * upserted message (including type 'append', which is how fromMe echoes arrive)
 * so the probe's own round-trip echo is reliably observed.
 */
function registerListener(sock) {
  if (!sock || !sock.ev) return;
  sock.ev.on('messages.upsert', ({ messages }) => {
    if (!_pending) return; // cheap early-out when no probe is in flight
    for (const rawMsg of messages) onMessage(rawMsg);
  });
}

/** Called from baileys-client.js when the socket is first created. */
function attachSocket(sock) {
  _sock = sock;
  registerListener(sock);
}

/** Called from baileys-client.js when a reconnect creates a new socket. */
function updateSocket(sock) {
  _sock = sock;
  registerListener(sock);
}

/** Extract the plain-text body from a raw Baileys message (or null). */
function extractText(rawMsg) {
  const m = rawMsg && rawMsg.message;
  if (!m) return null;
  return m.conversation
    || (m.extendedTextMessage && m.extendedTextMessage.text)
    || null;
}

/**
 * Called for every raw message on the probe's own upsert listener — including
 * our own fromMe echoes, which is exactly what the probe is waiting to observe.
 */
function onMessage(rawMsg) {
  if (!_pending) return;
  try {
    const text = extractText(rawMsg);
    if (text && text === _pending.text) {
      resolvePending({ ok: true, roundTripMs: Date.now() - _pending.sentAt });
    }
  } catch (_) {}
}

/** Settle the in-flight probe and clear state so the next probe can run. */
function resolvePending(result) {
  if (!_pending) return;
  clearTimeout(_pending.timer);
  const { resolve } = _pending;
  _pending = null;
  resolve(result);
}

/**
 * Send a tagged probe to the test group and wait for it to round-trip.
 * @returns {Promise<{ok:true, roundTripMs:number} | {ok:false, reason:string}>}
 */
async function runProbe() {
  if (_pending) return { ok: false, reason: 'probe_in_progress' };
  if (!_sock) return { ok: false, reason: 'no_socket' };

  const text = `🔍 probe:${Date.now()}`;

  // Register the one-shot listener state *before* sending, so an echo that
  // arrives faster than sendMessage() resolves is still matched.
  const result = new Promise((resolve) => {
    _pending = {
      text,
      resolve,
      sentAt: Date.now(),
      timer: setTimeout(() => {
        logger.warn({ component: 'HealthProbe', text }, 'Probe timed out');
        resolvePending({ ok: false, reason: 'timeout' });
      }, PROBE_TIMEOUT_MS),
    };
    if (_pending.timer.unref) _pending.timer.unref(); // don't keep process alive
  });

  try {
    await _sock.sendMessage(TEST_GROUP_JID, { text });
    logger.info({ component: 'HealthProbe', text }, 'Probe sent, awaiting round-trip');
  } catch (e) {
    logger.error({ component: 'HealthProbe', err: e.message }, 'Probe send failed');
    resolvePending({ ok: false, reason: 'send_failed' });
  }

  return result;
}

module.exports = { attachSocket, updateSocket, runProbe };
