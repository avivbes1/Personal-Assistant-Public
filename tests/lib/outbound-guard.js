'use strict';
// outbound-guard.js — fail-closed interceptors for every live outbound route a
// test can reach (SMTP, WhatsApp HTTP, Google Calendar writes).
//
// Must be required BEFORE any module that uses nodemailer / http / googleapis,
// so the patched functions are what those modules capture on first require.
//
// Active ONLY when FAMILYBOT_TEST=1 — a complete no-op in production so that
// requiring it from a non-test context can never alter real behavior.

if (process.env.FAMILYBOT_TEST !== '1') {
  module.exports = { blocked: [], active: false };
  return; // noop in production
}

const blocked = [];

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

// 5. Subprocess guard — patch child_process spawning functions so a test can
//    never shell out to a dangerous target (curl to the local voice-client /
//    blocked paths, or the openclaw CLI). Legitimate node subprocess spawning
//    passes straight through to the original function.
const child_process = require('child_process');
const basename = (c) => String(c || '').split(/[\\/]/).pop();
// shellForm=true means `command` is a whole shell string (exec); the first token
// is the program and the rest are inline args.
const isDangerous = (command, args, shellForm) => {
  const cmd = String(command || '');
  const prog = shellForm ? basename((cmd.trim().split(/\s+/)[0]) || '') : basename(cmd);
  const argv = Array.isArray(args) ? args.map(String) : [];
  const joined = shellForm ? cmd : (cmd + ' ' + argv.join(' '));
  if (prog === 'curl') {
    if (joined.includes('localhost:3001')) return true;
    if (BLOCKED_PATHS.some(p => joined.includes(p))) return true;
  }
  if (prog === 'openclaw') return true;
  return false;
};
for (const fn of ['execFileSync', 'execFile', 'spawn', 'spawnSync', 'exec']) {
  const orig = child_process[fn];
  if (typeof orig !== 'function') continue;
  const origBound = orig.bind(child_process);
  const shellForm = (fn === 'exec');
  child_process[fn] = function (command, args) {
    // exec takes a single shell command string; execFile*/spawn* take (command, args).
    if (isDangerous(command, args, shellForm)) {
      const entry = { type: 'subprocess', command: String(command), ts: Date.now() };
      blocked.push(entry);
      throw new Error('[TEST GUARD] dangerous subprocess blocked during test execution');
    }
    return origBound.apply(child_process, arguments);
  };
}

module.exports = { blocked, active: true };
