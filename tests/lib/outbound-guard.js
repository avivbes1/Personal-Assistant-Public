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

module.exports = { blocked, active: true };
