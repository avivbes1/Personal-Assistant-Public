'use strict';
// outbound-guard.js — fail-closed interceptors for every live outbound route a
// test can reach (network, SMTP, WhatsApp HTTP, Google Calendar writes, SES,
// subprocesses).
//
// Two layers:
//   LAYER 1 (generic, deny-by-default):
//     - net.Socket.prototype.connect  → denies any non-loopback host, and any
//       loopback host on a port not in an explicit allowlist. This transitively
//       covers TCP, TLS, HTTPS, SMTP, IMAP, SES — anything that opens a socket.
//     - dns.lookup / dns.promises.lookup → denies resolution of any non-loopback
//       hostname, so external hosts can't even be resolved.
//     - child_process.* → allowlist of safe executables; anything else is denied.
//   LAYER 2 (targeted, defense-in-depth): the original module-specific guards
//     (nodemailer, http.request path blocking, googleapis, SES, curl specifics).
//
// Must be required BEFORE any module that uses net/dns/nodemailer/http/googleapis,
// so the patched functions are what those modules capture on first require.
//
// Active ONLY when FAMILYBOT_TEST=1 — a complete no-op in production so that
// requiring it from a non-test context can never alter real behavior.

if (process.env.FAMILYBOT_TEST !== '1') {
  module.exports = {
    blocked: [],
    active: false,
    allowLoopbackPort: () => {},
    ALLOWED_EXECUTABLES: Object.freeze([]),
    LOOPBACK_PORT_ALLOWLIST: new Set(),
  };
  return; // noop in production
}

const path = require('path');
const fs = require('fs');

const blocked = [];

// ── LAYER 1a: Generic network deny-by-default ──────────────────────────────
// Deny any outbound socket to a non-loopback host, and any loopback socket on a
// port that no test has explicitly allowed. Patching net.Socket.prototype.connect
// catches every higher-level client (http/https/tls/smtp/imap/aws-sdk/...).

// Loopback ports that tests may temporarily allow. Empty by default: NO loopback
// port is permitted until a test calls allowLoopbackPort(port).
const LOOPBACK_PORT_ALLOWLIST = new Set();
function allowLoopbackPort(port) {
  const p = Number(port);
  if (Number.isFinite(p)) LOOPBACK_PORT_ALLOWLIST.add(p);
  return LOOPBACK_PORT_ALLOWLIST;
}

function isLoopbackHost(h) {
  if (!h) return true; // undefined/empty host → Node defaults to localhost
  const host = String(h).toLowerCase();
  if (host === 'localhost') return true;
  if (host === '::1') return true;
  if (host === '0.0.0.0' || host === '::') return true; // local bind addresses
  if (host.startsWith('127.')) return true;
  if (host.startsWith('::ffff:127.')) return true;
  return false;
}

// Parse the many net.Socket#connect overloads into {host, port, path}.
// Mirrors Node's internal normalizeArgs: object → options; non-numeric string →
// pipe/IPC path; otherwise (port[, host]).
function parseConnectArgs(args) {
  const first = args[0];
  if (first !== null && typeof first === 'object') {
    return { host: first.host, port: first.port, path: first.path };
  }
  if (typeof first === 'string' && !Number.isFinite(Number(first))) {
    return { host: undefined, port: undefined, path: first }; // IPC pipe/unix socket
  }
  const host = (typeof args[1] === 'string') ? args[1] : undefined;
  return { host, port: first, path: undefined };
}

try {
  const net = require('net');
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const { host, port, path: sockPath } = parseConnectArgs(args);

    // IPC / unix-domain sockets are local filesystem endpoints, not network —
    // they can't reach an external host, so let them through.
    if (sockPath) return origConnect.apply(this, args);

    const p = Number(port);
    let denyReason = null;
    if (!isLoopbackHost(host)) {
      denyReason = 'non-loopback host';
    } else if (!LOOPBACK_PORT_ALLOWLIST.has(p)) {
      denyReason = 'loopback port not in allowlist';
    }

    if (denyReason) {
      blocked.push({ type: 'net_connect', host: host || '(default)', port: p, reason: denyReason, ts: Date.now() });
      const self = this;
      const err = new Error('[TEST GUARD] net connect to ' + (host || 'localhost') + ':' + p + ' blocked (' + denyReason + ')');
      err.code = 'ECONNREFUSED';
      process.nextTick(() => { self.emit('error', err); });
      return this; // do NOT call the real connect
    }

    return origConnect.apply(this, args);
  };
} catch (_) { /* net always present; defensive only */ }

// ── LAYER 1b: DNS deny-by-default ──────────────────────────────────────────
// Refuse to resolve any non-loopback hostname so external hosts are unreachable
// even before a socket is opened.
try {
  const dns = require('dns');

  const origLookup = dns.lookup;
  if (typeof origLookup === 'function') {
    dns.lookup = function (hostname, options, callback) {
      if (typeof options === 'function') { callback = options; }
      if (!isLoopbackHost(hostname)) {
        blocked.push({ type: 'dns_lookup', host: String(hostname), ts: Date.now() });
        const err = new Error('[TEST GUARD] DNS lookup of ' + hostname + ' blocked');
        err.code = 'ENOTFOUND';
        if (typeof callback === 'function') {
          process.nextTick(() => callback(err));
          return;
        }
        throw err;
      }
      return origLookup.apply(dns, arguments);
    };
  }

  if (dns.promises && typeof dns.promises.lookup === 'function') {
    const origPromisesLookup = dns.promises.lookup;
    dns.promises.lookup = function (hostname) {
      if (!isLoopbackHost(hostname)) {
        blocked.push({ type: 'dns_lookup', host: String(hostname), ts: Date.now() });
        const err = new Error('[TEST GUARD] DNS lookup of ' + hostname + ' blocked');
        err.code = 'ENOTFOUND';
        return Promise.reject(err);
      }
      return origPromisesLookup.apply(dns.promises, arguments);
    };
  }
} catch (_) { /* dns always present; defensive only */ }

// ── LAYER 2: targeted, module-specific guards (defense-in-depth) ────────────

// 1. SMTP guard — patch nodemailer.createTransport so every transport is a
//    stub that records the send and throws instead of delivering.
try {
  const nodemailer = require('nodemailer');
  nodemailer.createTransport = function () {
    return {
      sendMail: async (opts = {}) => {
        const entry = { type: 'smtp', to: opts.to, subject: opts.subject, ts: Date.now() };
        blocked.push(entry);
        throw new Error('[TEST GUARD] SMTP sendMail blocked during test execution');
      },
      verify: async () => true,
      close: () => {},
    };
  };
} catch (_) { /* nodemailer not installed */ }

// 2. WhatsApp / HTTP guard — patch http.request so any send to the local
//    voice-client (localhost:3001) is intercepted and errored.
const http = require('http');
const origRequest = http.request.bind(http);
const BLOCKED_PATHS = ['/send-message', '/send-document', '/send-image', '/fill-form'];
http.request = function (opts, cb) {
  // opts may be a string URL or an options object; normalize defensively.
  const o = (typeof opts === 'string') ? {} : (opts || {});
  const host = o.hostname || o.host || '';
  const port = Number(o.port) || 80;
  const urlPath = o.path || '';
  if (
    (host === 'localhost' || host === '127.0.0.1') &&
    port === 3001 &&
    BLOCKED_PATHS.some(p => urlPath.startsWith(p))
  ) {
    const entry = { type: 'whatsapp_http', path: urlPath, ts: Date.now() };
    blocked.push(entry);
    // Return a fake request that emits an error asynchronously (fail-closed).
    const EventEmitter = require('events');
    const fakeReq = new EventEmitter();
    fakeReq.write = () => {};
    fakeReq.end = () => {
      process.nextTick(() =>
        fakeReq.emit('error', new Error('[TEST GUARD] HTTP send to localhost:3001' + urlPath + ' blocked'))
      );
    };
    fakeReq.abort = () => {};
    fakeReq.destroy = () => {};
    fakeReq.setTimeout = () => fakeReq;
    return fakeReq;
  }
  return origRequest(opts, cb);
};

// 3. Calendar write guard — patch googleapis so calendar.events write methods
//    throw. Read methods (list/get) are left untouched.
try {
  const { google } = require('googleapis');
  const origCalendar = google.calendar.bind(google);
  google.calendar = function (...args) {
    const cal = origCalendar(...args);
    const origEvents = cal && cal.events;
    if (origEvents) {
      const writeMethods = ['insert', 'update', 'patch', 'delete'];
      for (const method of writeMethods) {
        if (typeof origEvents[method] === 'function') {
          origEvents[method] = async () => {
            const entry = { type: 'calendar_write', method, ts: Date.now() };
            blocked.push(entry);
            throw new Error('[TEST GUARD] Google Calendar ' + method + ' blocked during test execution');
          };
        }
      }
    }
    return cal;
  };
} catch (_) { /* googleapis not installed */ }

// 4. SES guard — stub @aws-sdk/client-ses so SESClient.prototype.send records
//    the attempt and throws instead of dispatching an email via Amazon SES.
try {
  const ses = require('@aws-sdk/client-ses');
  if (ses && ses.SESClient && ses.SESClient.prototype) {
    ses.SESClient.prototype.send = async function () {
      const entry = { type: 'ses', ts: Date.now() };
      blocked.push(entry);
      throw new Error('[TEST GUARD] SES send blocked during test execution');
    };
  }
} catch (_) { /* @aws-sdk/client-ses not installed */ }

// 5. Subprocess guard — ALLOWLIST approach. A test may only shell out to a known
//    safe executable; anything else (including curl and the openclaw CLI) is
//    denied and recorded. 'curl'/'openclaw' are ALWAYS denied regardless of the
//    allowlist, and the original curl-specific path checks are kept as an extra
//    safety net.
const child_process = require('child_process');

const ALLOWED_EXECUTABLES = Object.freeze([
  'node', 'python3', 'tesseract', 'git', 'bash', 'sh', 'cat', 'ls', 'head',
  'tail', 'grep', 'sed', 'awk', 'wc', 'sort', 'uniq', 'find', 'mkdir', 'rm',
  'cp', 'mv', 'touch', 'chmod', 'echo', 'printf', 'true', 'false', 'test',
  'env', 'timeout', 'dirname', 'basename', 'realpath', 'readlink', 'date',
  'tr', 'cut', 'tee', 'xargs',
]);
const ALLOWED_SET = new Set(ALLOWED_EXECUTABLES);
const ALWAYS_DENY = new Set(['curl', 'openclaw']);

const basename = (c) => String(c || '').split(/[\\/]/).pop();

// Resolve an executable token to its basename, following symlinks for absolute
// paths (so /usr/local/bin/node and a nvm shim both normalize to 'node').
function resolveBasename(cmd) {
  let c = String(cmd || '').trim();
  // Strip surrounding quotes a shell string may carry.
  if ((c.startsWith('"') && c.endsWith('"')) || (c.startsWith("'") && c.endsWith("'"))) {
    c = c.slice(1, -1);
  }
  if (path.isAbsolute(c)) {
    try { c = fs.realpathSync(c); } catch (_) { /* path may not exist; fall back to literal */ }
  }
  return basename(c);
}

// For shell-form (exec): the first token after stripping leading VAR=value env
// assignments is the program.
function programFromShell(cmdStr) {
  const tokens = String(cmdStr || '').trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  return tokens[i] || '';
}

// Additional curl-specific safety (redundant with ALWAYS_DENY but kept explicit).
const curlHitsBlockedTarget = (joined) =>
  joined.includes('localhost:3001') || BLOCKED_PATHS.some(p => joined.includes(p));

function subprocessDenied(command, args, shellForm) {
  const cmd = String(command || '');
  let prog;
  if (shellForm) {
    prog = resolveBasename(programFromShell(cmd));
  } else {
    prog = resolveBasename(cmd);
  }
  const argv = Array.isArray(args) ? args.map(String) : [];
  const joined = shellForm ? cmd : (cmd + ' ' + argv.join(' '));

  // Always-deny set (curl/openclaw) first.
  if (ALWAYS_DENY.has(prog)) {
    if (prog === 'curl' && curlHitsBlockedTarget(joined)) return 'curl to blocked target';
    return prog + ' always denied';
  }
  // Deny-by-default: anything not explicitly allowed.
  if (!ALLOWED_SET.has(prog)) return 'executable not in allowlist: ' + (prog || '(empty)');
  return null;
}

for (const fn of ['execFileSync', 'execFile', 'spawn', 'spawnSync', 'exec', 'execSync']) {
  const orig = child_process[fn];
  if (typeof orig !== 'function') continue;
  const origBound = orig.bind(child_process);
  const shellForm = (fn === 'exec' || fn === 'execSync');
  child_process[fn] = function (command, args) {
    // exec/execSync take a single shell command string; execFile*/spawn* take (command, args).
    const reason = subprocessDenied(command, args, shellForm);
    if (reason) {
      const entry = { type: 'subprocess', command: String(command), reason, ts: Date.now() };
      blocked.push(entry);
      throw new Error('[TEST GUARD] subprocess blocked during test execution (' + reason + ')');
    }
    return origBound.apply(child_process, arguments);
  };
}

module.exports = {
  blocked,
  active: true,
  allowLoopbackPort,
  ALLOWED_EXECUTABLES,
  LOOPBACK_PORT_ALLOWLIST,
};
