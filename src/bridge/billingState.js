'use strict';
/**
 * bridge/billingState.js — the billing circuit breaker for the Instinct Bridge.
 *
 * When the email transport reports a REAL provider billing failure (insufficient
 * credit / quota exceeded / SES AccountSendingPausedException), the bridge trips
 * this breaker: it records billing_paused=true with a timestamp and the error,
 * and every subsequent send is skipped until an operator manually unpauses.
 *
 * This is deliberately NOT a cost estimator — there are no dollar caps or
 * predicted-spend limits. The breaker only ever trips on an actual provider
 * rejection, so it can never over-block on a guess.
 *
 * State lives in a small JSON file (default data/bridge-state.json) rather than
 * the DB, so it survives independently of the outbox and is trivially inspected
 * and edited by hand during an incident. The path is overridable via
 * INSTINCT_BRIDGE_STATE_PATH (read on every call, so tests can isolate it).
 */

const fs = require('fs');
const path = require('path');

function statePath() {
  return process.env.INSTINCT_BRIDGE_STATE_PATH ||
    path.join(__dirname, '..', '..', 'data', 'bridge-state.json');
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch (_) {
    // Missing / unreadable / malformed → treat as not-paused (fail open on read
    // only; the breaker still trips on a real provider error).
    return { billing_paused: false };
  }
}

function writeState(state) {
  const file = statePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (_) {}
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
  return state;
}

/** True if sends are currently paused for billing. */
function isBillingPaused() {
  return !!readState().billing_paused;
}

/** Trip the breaker. Records the timestamp and the provider error text. */
function pauseBilling(error) {
  const errText = error == null ? null : (error.message || String(error));
  return writeState({
    billing_paused: true,
    paused_at: new Date().toISOString(),
    error: errText,
  });
}

/** Manually clear the breaker (operator action after topping up credit). */
function unpauseBilling() {
  return writeState({
    billing_paused: false,
    unpaused_at: new Date().toISOString(),
  });
}

/** Full current state object, for logging / the health endpoint. */
function getBillingState() {
  return readState();
}

module.exports = {
  isBillingPaused,
  pauseBilling,
  unpauseBilling,
  getBillingState,
  statePath,
};
