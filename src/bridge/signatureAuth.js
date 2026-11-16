'use strict';
/**
 * bridge/signatureAuth.js — Ed25519 signed-request auth for the Instinct↔Lipa
 * bridge (WS2).
 *
 * Signing format (v1), per public-keys/README.md:
 *   canonical string : `v1\n<unix_ts>\n<request_id>\n<sha256hex(payload)>`
 *   header line      : `SIG: v1 <unix_ts> <base64(signature)>`
 *   replay window    : |now - ts| <= 15 min
 *
 * `payload` is the exact JSON body of the message (the bytes placed in the email
 * after the AUTH:/SIG: header lines and the blank separator), trimmed. Both the
 * signer and the verifier derive the request_id from that payload's JSON
 * `request_id` field, so canonical reconstruction is unambiguous.
 *
 * Keys live under `.keys/` (see public-keys/README.md):
 *   - lipa-ed25519.pem        private  — signs OUR outbound replies (this box)
 *   - lipa-ed25519-pub.pem    public   — our public key (Instinct verifies with it)
 *   - instinct-ed25519-pub.pem public  — Instinct's key (we verify inbound with it)
 *
 * Purely additive. Never throws at require time; a missing key surfaces as a
 * null and the caller falls back to the legacy AUTH: token path. We never log
 * key material, signatures, or token values.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Replay window: |now - ts| must be within this many seconds.
const REPLAY_WINDOW_SEC = 15 * 60; // 15 minutes

// request_id dedup store: request_id -> expiry epoch ms. Entries live for the
// replay window (after that the ts check rejects a replay anyway).
const DEDUP_TTL_MS = REPLAY_WINDOW_SEC * 1000;
const seenRequestIds = new Map();

// ── Key loading (lazy, cached, non-throwing) ─────────────────────────────────

function keysDir() {
  // Resolve relative to the repo root (two levels up from src/bridge/).
  return process.env.BRIDGE_KEYS_DIR || path.join(__dirname, '..', '..', '.keys');
}

let _keys = null; // { privateKey, lipaPublicKey, instinctPublicKey }

/**
 * Load the Lipa private key and both public keys from disk. Cached after the
 * first successful load. Returns an object whose fields may be null when the
 * corresponding file is missing or unreadable — callers must handle nulls.
 */
function loadKeys() {
  if (_keys) return _keys;
  const dir = keysDir();
  const read = (file, loader) => {
    try {
      return loader(fs.readFileSync(path.join(dir, file)));
    } catch (_) {
      return null;
    }
  };
  _keys = {
    privateKey: read('lipa-ed25519.pem', (b) => crypto.createPrivateKey(b)),
    lipaPublicKey: read('lipa-ed25519-pub.pem', (b) => crypto.createPublicKey(b)),
    instinctPublicKey: read('instinct-ed25519-pub.pem', (b) => crypto.createPublicKey(b)),
  };
  return _keys;
}

function getInstinctPublicKey() { return loadKeys().instinctPublicKey; }
function getLipaPublicKey() { return loadKeys().lipaPublicKey; }
function getPrivateKey() { return loadKeys().privateKey; }

// ── Canonical string + primitives ────────────────────────────────────────────

function sha256hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/** Build the canonical string that gets signed/verified. */
function buildCanonical(unixTs, requestId, payload) {
  return `v1\n${unixTs}\n${requestId || ''}\n${sha256hex(payload)}`;
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Low-level signer. Produces the `SIG:` header line for a given payload using
 * the supplied private key. `tsOverride` is for tests (replay-window cases).
 */
function signWith(requestId, jsonPayload, privateKey, tsOverride) {
  if (!privateKey) throw new Error('[Bridge][Sig] private key unavailable');
  const payload = String(jsonPayload).trim();
  const ts = Number.isFinite(tsOverride) ? tsOverride : nowUnix();
  const canonical = buildCanonical(ts, requestId, payload);
  const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey);
  return `SIG: v1 ${ts} ${signature.toString('base64')}`;
}

// ── Outbound signing (production: uses the Lipa private key) ──────────────────

/**
 * Create the `SIG: v1 <ts> <base64>` header line for an outbound reply, signed
 * with the Lipa private key.
 *
 * @param {string} requestId  request_id embedded in jsonPayload (or '' / null)
 * @param {string} jsonPayload the exact JSON body string that will be emailed
 * @returns {string|null}      the SIG header line, or null if the private key
 *                             is unavailable (caller then sends AUTH: only)
 */
function signOutbound(requestId, jsonPayload) {
  const priv = getPrivateKey();
  if (!priv) return null;
  try {
    return signWith(requestId, jsonPayload, priv);
  } catch (err) {
    console.error('[Bridge][Sig] signOutbound failed:', err.message);
    return null;
  }
}

// ── Inbound verification ─────────────────────────────────────────────────────

/** Extract the JSON payload from a body by dropping AUTH:/SIG: header lines. */
function extractPayload(body) {
  return String(body)
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('AUTH:') && !t.startsWith('SIG:');
    })
    .join('\n')
    .trim();
}

/** Parse the SIG: line → { ts, signature } or null if absent/malformed. */
function parseSigLine(body) {
  const line = String(body)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('SIG:'));
  if (!line) return null;
  // Format: SIG: v1 <unix_ts> <base64(signature)>
  const m = line.match(/^SIG:\s*v1\s+(\d+)\s+(\S+)\s*$/);
  if (!m) return null;
  return { ts: parseInt(m[1], 10), signatureB64: m[2] };
}

function pruneDedup() {
  const now = Date.now();
  for (const [id, exp] of seenRequestIds) {
    if (exp <= now) seenRequestIds.delete(id);
  }
}

/**
 * Verify an inbound signed request.
 *
 * @param {string} body               raw message body (may contain AUTH + SIG)
 * @param {crypto.KeyObject} senderPublicKey  the sender's Ed25519 public key
 * @returns {{valid:boolean, reason?:string, ts?:number, requestId?:string}}
 */
function verifyInbound(body, senderPublicKey) {
  if (!body) return { valid: false, reason: 'empty_body' };
  if (!senderPublicKey) return { valid: false, reason: 'no_public_key' };

  const sig = parseSigLine(body);
  if (!sig) return { valid: false, reason: 'no_sig_line' };

  // Replay window on the timestamp.
  const skew = Math.abs(nowUnix() - sig.ts);
  if (!Number.isFinite(sig.ts) || skew > REPLAY_WINDOW_SEC) {
    return { valid: false, reason: 'replay_window', ts: sig.ts };
  }

  const payload = extractPayload(body);

  // request_id is carried inside the JSON payload; both signer and verifier
  // derive it from there so the canonical string matches exactly.
  let requestId = '';
  try {
    const parsed = JSON.parse(payload);
    if (parsed && parsed.request_id != null) requestId = String(parsed.request_id);
  } catch (_) {
    // Non-JSON payload: request_id stays '' (matches signer's null→'' rule).
  }

  const canonical = buildCanonical(sig.ts, requestId, payload);
  let ok = false;
  try {
    ok = crypto.verify(null, Buffer.from(canonical, 'utf8'), senderPublicKey, Buffer.from(sig.signatureB64, 'base64'));
  } catch (_) {
    ok = false;
  }
  if (!ok) return { valid: false, reason: 'bad_signature', ts: sig.ts, requestId };

  // Replay dedup on request_id (within the TTL). Skip when no request_id.
  if (requestId) {
    pruneDedup();
    if (seenRequestIds.has(requestId)) {
      return { valid: false, reason: 'replay_dedup', ts: sig.ts, requestId };
    }
    seenRequestIds.set(requestId, Date.now() + DEDUP_TTL_MS);
  }

  return { valid: true, ts: sig.ts, requestId };
}

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Clear the dedup store (tests only). */
function _resetDedup() {
  seenRequestIds.clear();
}

module.exports = {
  REPLAY_WINDOW_SEC,
  loadKeys,
  getInstinctPublicKey,
  getLipaPublicKey,
  getPrivateKey,
  buildCanonical,
  sha256hex,
  signWith,
  signOutbound,
  verifyInbound,
  extractPayload,
  parseSigLine,
  _resetDedup,
};
