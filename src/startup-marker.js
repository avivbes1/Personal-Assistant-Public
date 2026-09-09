/**
 * startup-marker.js — I3: startup-phase supervisor marker.
 *
 * The external watchdog (infra/watchdog.sh) only detects trouble once the bot has
 * already connected to WhatsApp — a crash or hang *during* startup (before the
 * connection opens) is invisible to it. This marker records the boot phase to a
 * /tmp file so the external watchdog can catch two otherwise-silent failure modes:
 *   - process wedged in phase 'starting' for too long (stuck startup)
 *   - marker missing while pm2 still reports the process 'online' (marker never
 *     written / crashed before writing → likely a crash-loop)
 *
 * File shape: { ts: <epoch ms>, pid: <process pid>, phase: 'starting'|'connected' }
 */

const fs = require('fs');

const MARKER_PATH = process.env.BESINSKY_STARTUP_MARKER || '/tmp/besinsky-startup.json';

function write(phase) {
  try {
    fs.writeFileSync(MARKER_PATH, JSON.stringify({ ts: Date.now(), pid: process.pid, phase }));
  } catch (_) {
    // Best-effort — a failure to write the marker must never block startup.
  }
}

/** Called at process boot, before any slow init. */
function markStarting() {
  write('starting');
}

/** Called once WhatsApp reports connected/ready. */
function markConnected() {
  write('connected');
}

/** Called on clean shutdown so the watchdog doesn't see a stale marker. */
function clear() {
  try {
    fs.unlinkSync(MARKER_PATH);
  } catch (_) {
    // Already gone — fine.
  }
}

module.exports = { markStarting, markConnected, clear, MARKER_PATH };
