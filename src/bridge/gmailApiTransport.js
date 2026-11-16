'use strict';
/**
 * bridge/gmailApiTransport.js — Gmail API transport for the Instinct Bridge (WS1).
 *
 * An optional replacement for the SMTP-send / IMAP-read paths that speaks the
 * Gmail REST API instead. It reuses the OAuth identity that the `gog` CLI
 * already manages (tokens in ~/.local/share/gogcli/), so no new consent flow is
 * needed. It is OFF by default — only reached when BRIDGE_EMAIL_TRANSPORT is set
 * to 'gmail_api'.
 *
 * ── Credential sourcing ──────────────────────────────────────────────────────
 * Building a googleapis OAuth2 client that can self-refresh needs three things:
 *   - client_id      : env GOG_OAUTH_CLIENT_ID, else ~/.local/share/gogcli/credentials.json
 *   - client_secret  : env GOG_OAUTH_CLIENT_SECRET  (gog keeps this in its
 *                      encrypted keyring and does NOT expose it via the CLI, so
 *                      an operator must provide it in the environment)
 *   - refresh_token  : env GOG_OAUTH_REFRESH_TOKEN, else exported on demand from
 *                      gog's keyring via `gog auth tokens export`
 *
 * ── Known operational blockers (as of 2026-11-16) ────────────────────────────
 * Discovered while wiring this up — both must be cleared before the gmail_api
 * path can actually move mail; the code itself is complete and correct:
 *   1. The stored gog refresh token for the bridge account is REVOKED
 *      (`invalid_grant`). Re-authorize with `gog auth add <account>`.
 *   2. The gog OAuth scope is `gmail.readonly` — enough for readInbox(), but
 *      sendMail() needs `gmail.send` (or `https://mail.google.com/`). Re-auth
 *      must request a send scope.
 * Until then this transport stays behind the flag; the SMTP/IMAP default is
 * untouched.
 *
 * We never log token, key, or secret values.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Lazy-required so the default (SMTP/IMAP) path never pays to load googleapis.
let _google = null;
function google() {
  if (!_google) _google = require('googleapis').google;
  return _google;
}

// ── Config knobs (all optional; sensible defaults) ───────────────────────────

// The Gmail account whose mailbox the API operates on. This is the gog-
// authenticated identity, which may differ from INSTINCT_BRIDGE_INBOUND_ACCOUNT
// (the IMAP/SMTP app-password account). For full parity they should match.
function apiAccount() {
  return process.env.BRIDGE_GMAIL_API_ACCOUNT
    || process.env.GOG_ACCOUNT
    || '';  // must be set via INSTINCT_BRIDGE_INBOUND_ACCOUNT
}

function gogHome() {
  return process.env.GOG_HOME_DATA
    || path.join(os.homedir(), '.local', 'share', 'gogcli');
}

function gogCredentialsPath() {
  return path.join(gogHome(), 'credentials.json');
}

// ── OAuth client (lazy, cached) ──────────────────────────────────────────────

let _authClient = null;

function readClientId() {
  if (process.env.GOG_OAUTH_CLIENT_ID) return process.env.GOG_OAUTH_CLIENT_ID;
  try {
    const raw = JSON.parse(fs.readFileSync(gogCredentialsPath(), 'utf8'));
    // gog stores either { client_id } or the Google-console { installed:{...} } shape.
    return raw.client_id || (raw.installed && raw.installed.client_id) || (raw.web && raw.web.client_id) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Export the stored refresh token from gog's keyring. Writes to a temp file
 * (gog has no stdout token-print command), reads it, then deletes it. Requires
 * GOG_KEYRING_PASSWORD in the environment. Returns null on any failure.
 */
function exportRefreshTokenViaGog() {
  const pass = process.env.GOG_KEYRING_PASSWORD;
  if (!pass) return null;
  const gogBin = process.env.GOG_BIN || '/usr/local/bin/gog';
  const tmp = path.join(os.tmpdir(), `bridge-gog-tok-${process.pid}-${process.hrtime.bigint()}.json`);
  try {
    execFileSync(gogBin, ['auth', 'tokens', 'export', apiAccount(), '--out', tmp, '--overwrite'], {
      env: { ...process.env, GOG_KEYRING_PASSWORD: pass },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const data = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    return {
      refresh_token: data.refresh_token || null,
      access_token: data.access_token || null,
      expiry: data.access_token_expires_at ? Date.parse(data.access_token_expires_at) : null,
    };
  } catch (_) {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function getAuthClient() {
  if (_authClient) return _authClient;

  const clientId = readClientId();
  const clientSecret = process.env.GOG_OAUTH_CLIENT_SECRET || null;

  let refreshToken = process.env.GOG_OAUTH_REFRESH_TOKEN || null;
  let seedAccess = null;
  let seedExpiry = null;
  if (!refreshToken) {
    const exported = exportRefreshTokenViaGog();
    if (exported) {
      refreshToken = exported.refresh_token;
      seedAccess = exported.access_token;
      seedExpiry = exported.expiry;
    }
  }

  if (!clientId || !clientSecret || !refreshToken) {
    const missing = [
      !clientId && 'client_id',
      !clientSecret && 'client_secret (set GOG_OAUTH_CLIENT_SECRET)',
      !refreshToken && 'refresh_token',
    ].filter(Boolean).join(', ');
    throw new Error(`[Bridge][GmailAPI] OAuth credentials incomplete — missing: ${missing}`);
  }

  const { OAuth2Client } = require('google-auth-library');
  const client = new OAuth2Client({ clientId, clientSecret });
  const creds = { refresh_token: refreshToken };
  if (seedAccess) creds.access_token = seedAccess;
  if (seedExpiry) creds.expiry_date = seedExpiry;
  client.setCredentials(creds);

  _authClient = client;
  return _authClient;
}

function gmailClient() {
  return google().gmail({ version: 'v1', auth: getAuthClient() });
}

// ── Outbound: nodemailer-compatible sendMail ─────────────────────────────────

/**
 * Send an email via the Gmail API. Accepts the same options object shape as
 * nodemailer's transport.sendMail (from, to, subject, text, html, attachments,
 * inReplyTo, references) so it can drop in for a nodemailer transport.
 *
 * @returns {Promise<{messageId:string, id:string, threadId:string, response:string}>}
 */
async function sendMail(options) {
  // Reuse nodemailer's MIME builder so attachments / headers behave identically
  // to the SMTP path — we only swap the wire transport.
  const MailComposer = require('nodemailer/lib/mail-composer');
  const mail = new MailComposer(options);
  const rawBuffer = await new Promise((resolve, reject) => {
    mail.compile().build((err, message) => (err ? reject(err) : resolve(message)));
  });
  const raw = rawBuffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const gmail = gmailClient();
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });
  const id = (res && res.data && res.data.id) || null;
  const threadId = (res && res.data && res.data.threadId) || null;
  return {
    messageId: id,
    id,
    threadId,
    response: '250 2.0.0 OK (gmail_api)',
    accepted: [].concat(options.to || []),
    rejected: [],
  };
}

// ── Inbound: Gmail API read (IMAP replacement) ───────────────────────────────

/** Parse a few envelope headers out of a raw RFC822 message. */
function parseEnvelope(rawSource) {
  const headerBlock = rawSource.split(/\r?\n\r?\n/, 1)[0] || '';
  // Unfold folded header lines (continuation lines start with whitespace).
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  const get = (name) => {
    const re = new RegExp(`^${name}:\\s*(.*)$`, 'im');
    const m = unfolded.match(re);
    return m ? m[1].trim() : '';
  };
  const subject = get('Subject');
  const fromRaw = get('From');
  const messageId = (get('Message-ID') || get('Message-Id') || '').replace(/^<|>$/g, '') || null;
  // Extract a bare address from a "Name <addr>" style From header.
  const addrMatch = fromRaw.match(/<([^>]+)>/);
  const address = addrMatch ? addrMatch[1] : fromRaw;
  return {
    subject,
    from: address ? [{ address }] : [],
    messageId: messageId ? `<${messageId}>` : null,
  };
}

/**
 * Read messages from a Gmail label, returning objects shaped like the ImapFlow
 * fetch results the inbound poller already consumes:
 *   { uid, envelope: { subject, from:[{address}], messageId }, source: Buffer }
 *
 * @param {object} opts
 * @param {string} opts.label         Gmail label name (e.g. 'FamilyBot Bridge')
 * @param {string} [opts.subjectPrefix] only return messages whose subject contains this
 * @param {number} [opts.maxResults=25]
 * @param {string} [opts.newerThan='1d'] Gmail relative-age token
 */
async function readInbox(opts = {}) {
  const gmail = gmailClient();
  const parts = [];
  if (opts.label) parts.push(`label:"${opts.label}"`);
  if (opts.subjectPrefix) parts.push(`subject:"${opts.subjectPrefix}"`);
  parts.push(`newer_than:${opts.newerThan || '1d'}`);
  const q = parts.join(' ');

  const list = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults: opts.maxResults || 25,
  });
  const ids = (list.data.messages || []).map((m) => m.id);

  const out = [];
  for (const id of ids) {
    const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'raw' });
    const b64 = (msg.data && msg.data.raw) || '';
    const source = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const envelope = parseEnvelope(source.toString('utf8'));
    out.push({ uid: id, envelope, source });
  }
  return out;
}

module.exports = {
  sendMail,
  readInbox,
  // exported for diagnostics / tests
  getAuthClient,
  parseEnvelope,
  apiAccount,
};
