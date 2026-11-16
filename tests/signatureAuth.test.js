'use strict';

/**
 * Tests for src/bridge/signatureAuth.js (WS2 — Ed25519 signed requests).
 *
 * Covers the sign+verify round-trip with a freshly generated test keypair, plus
 * the rejection paths the bridge auth relies on: payload tampering, wrong key,
 * replay window, replay dedup, and a missing SIG line. Also exercises the
 * production key-loading path (loadKeys/signOutbound) against a temp .keys dir
 * via BRIDGE_KEYS_DIR, so we never touch the real private key.
 *
 * Run standalone:  node tests/signatureAuth.test.js
 * Or via the suite: node tests/run-all.js
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sig = require('../src/bridge/signatureAuth');

const cases = [];
function check(label, fn) { cases.push({ label, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// Build a message body in the on-the-wire shape verifyInbound() consumes:
//   <SIG line>\n\n<json payload>
function bodyFor(sigLine, payload, authLine) {
  return [authLine, sigLine, '', payload].filter((l) => l != null).join('\n');
}

// ── Round-trip: sign with a test key, verify with its public half ────────────
check('round-trip verifies', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const payload = JSON.stringify({ request_id: 'req-rt', ok: true, result: { pong: true } });
  const sigLine = sig.signWith('req-rt', payload, privateKey);
  assert(sigLine.startsWith('SIG: v1 '), 'SIG header format');
  const res = sig.verifyInbound(bodyFor(sigLine, payload), publicKey);
  assert(res.valid, `expected valid, got ${res.reason}`);
  assert(res.requestId === 'req-rt', `requestId echoed, got ${res.requestId}`);
});

// request_id is derived from the JSON payload, not the header — a numeric id in
// the payload must still reconstruct the same canonical string.
check('round-trip with numeric request_id in payload', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const payload = JSON.stringify({ request_id: 42, ok: true });
  // Signer passes the stringified id (matches verifier's String(parsed.request_id)).
  const sigLine = sig.signWith('42', payload, privateKey);
  assert(sig.verifyInbound(bodyFor(sigLine, payload), publicKey).valid, 'numeric id round-trip');
});

// Dual-header: a legacy AUTH: line present alongside SIG must not disturb the
// payload extraction (both lanes send BOTH during the transition).
check('round-trip ignores a co-present AUTH line', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const payload = JSON.stringify({ request_id: 'req-dual', ok: true });
  const sigLine = sig.signWith('req-dual', payload, privateKey);
  const res = sig.verifyInbound(bodyFor(sigLine, payload, 'AUTH:some-legacy-token'), publicKey);
  assert(res.valid, `expected valid with AUTH present, got ${res.reason}`);
});

// ── Negative: tampered payload ───────────────────────────────────────────────
check('tampered payload fails', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const payload = JSON.stringify({ request_id: 'req-t', ok: true });
  const sigLine = sig.signWith('req-t', payload, privateKey);
  const tampered = bodyFor(sigLine, payload.replace('true', 'false'));
  const res = sig.verifyInbound(tampered, publicKey);
  assert(!res.valid && res.reason === 'bad_signature', `expected bad_signature, got ${res.reason}`);
});

// ── Negative: wrong public key ───────────────────────────────────────────────
check('wrong key fails', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const { publicKey: other } = crypto.generateKeyPairSync('ed25519');
  const payload = JSON.stringify({ request_id: 'req-w', ok: true });
  const sigLine = sig.signWith('req-w', payload, privateKey);
  const res = sig.verifyInbound(bodyFor(sigLine, payload), other);
  assert(!res.valid && res.reason === 'bad_signature', `expected bad_signature, got ${res.reason}`);
});

// ── Negative: replay window (timestamp too old) ──────────────────────────────
check('stale timestamp rejected (replay window)', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const payload = JSON.stringify({ request_id: 'req-old', ok: true });
  const staleTs = Math.floor(Date.now() / 1000) - (sig.REPLAY_WINDOW_SEC + 60);
  const sigLine = sig.signWith('req-old', payload, privateKey, staleTs);
  const res = sig.verifyInbound(bodyFor(sigLine, payload), publicKey);
  assert(!res.valid && res.reason === 'replay_window', `expected replay_window, got ${res.reason}`);
});

// A timestamp just inside the window still verifies (boundary sanity).
check('timestamp just inside window accepted', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const payload = JSON.stringify({ request_id: 'req-edge', ok: true });
  const ts = Math.floor(Date.now() / 1000) - (sig.REPLAY_WINDOW_SEC - 30);
  const sigLine = sig.signWith('req-edge', payload, privateKey, ts);
  assert(sig.verifyInbound(bodyFor(sigLine, payload), publicKey).valid, 'inside-window should verify');
});

// ── Negative: replay dedup (same request_id twice) ───────────────────────────
check('replayed request_id rejected (dedup)', () => {
  sig._resetDedup();
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const payload = JSON.stringify({ request_id: 'req-dup', ok: true });
  const sigLine = sig.signWith('req-dup', payload, privateKey);
  const body = bodyFor(sigLine, payload);
  assert(sig.verifyInbound(body, publicKey).valid, 'first use should verify');
  const second = sig.verifyInbound(body, publicKey);
  assert(!second.valid && second.reason === 'replay_dedup', `expected replay_dedup, got ${second.reason}`);
});

// ── Negative: no SIG line at all ─────────────────────────────────────────────
check('missing SIG line reported', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const res = sig.verifyInbound('AUTH:legacy-token\n\n{"request_id":"x"}', publicKey);
  assert(!res.valid && res.reason === 'no_sig_line', `expected no_sig_line, got ${res.reason}`);
});

// ── Production path: loadKeys() + signOutbound() against a temp .keys dir ─────
// Exercises the real key-loading + signing code without touching the live
// private key. Uses a fresh keypair written to a temp dir via BRIDGE_KEYS_DIR.
check('loadKeys + signOutbound round-trip via temp keys dir', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigauth-keys-'));
  try {
    fs.writeFileSync(path.join(dir, 'lipa-ed25519.pem'),
      privateKey.export({ type: 'pkcs8', format: 'pem' }));
    fs.writeFileSync(path.join(dir, 'lipa-ed25519-pub.pem'),
      publicKey.export({ type: 'spki', format: 'pem' }));
    // Instinct pub = our test public key, so verifyInbound accepts what we sign.
    fs.writeFileSync(path.join(dir, 'instinct-ed25519-pub.pem'),
      publicKey.export({ type: 'spki', format: 'pem' }));

    // Fresh module instance bound to the temp dir (signatureAuth caches keys).
    const prev = process.env.BRIDGE_KEYS_DIR;
    process.env.BRIDGE_KEYS_DIR = dir;
    delete require.cache[require.resolve('../src/bridge/signatureAuth')];
    const freshSig = require('../src/bridge/signatureAuth');
    try {
      const keys = freshSig.loadKeys();
      assert(keys.privateKey && keys.lipaPublicKey && keys.instinctPublicKey, 'all keys loaded');

      const payload = JSON.stringify({ request_id: 'req-prod', ok: true });
      const sigLine = freshSig.signOutbound('req-prod', payload);
      assert(sigLine && sigLine.startsWith('SIG: v1 '), 'signOutbound produced a header');

      freshSig._resetDedup();
      const res = freshSig.verifyInbound(bodyFor(sigLine, payload), freshSig.getInstinctPublicKey());
      assert(res.valid, `production round-trip should verify, got ${res.reason}`);
    } finally {
      // Restore the default-keys module instance for any later test/import.
      delete require.cache[require.resolve('../src/bridge/signatureAuth')];
      if (prev == null) delete process.env.BRIDGE_KEYS_DIR;
      else process.env.BRIDGE_KEYS_DIR = prev;
      require('../src/bridge/signatureAuth');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function run() {
  let passed = 0;
  const failures = [];
  for (const { label, fn } of cases) {
    try {
      fn();
      passed++;
    } catch (err) {
      failures.push(`${label}: ${err.message}`);
    }
  }
  return failures.length === 0
    ? { pass: true, message: `signatureAuth: ${passed}/${cases.length} checks passed` }
    : { pass: false, message: `signatureAuth: ${failures.length} failed:\n  ${failures.join('\n  ')}` };
}

module.exports = { run };

// Standalone execution
if (require.main === module) {
  console.log('\n=== signatureAuth.test.js ===\n');
  let failed = 0;
  for (const { label, fn } of cases) {
    try {
      fn();
      console.log(`  ✅ ${label}`);
    } catch (err) {
      failed++;
      console.log(`  ❌ ${label}: ${err.message}`);
    }
  }
  console.log(`\n=== Results: ${cases.length - failed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}
