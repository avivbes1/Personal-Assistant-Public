'use strict';
/**
 * Babysitter booking microservice — Tudat integration helpers.
 * Onboarding prompt, reply parsing, DM routing.
 */

const http = require('http');

const BOOKING_PORT = 3002;
const BOOKING_SECRET = () => process.env.SHARED_SECRET || '';

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function bookingGet(path) {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: 'localhost', port: BOOKING_PORT, path,
      headers: { 'x-shared-token': BOOKING_SECRET() },
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}

function bookingPost(path, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost', port: BOOKING_PORT, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-shared-token': BOOKING_SECRET(),
      },
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', resolve);
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.write(payload); req.end();
  });
}

// ── Phone list cache ──────────────────────────────────────────────────────────

let _phones = new Set();
let _phonesLastFetch = 0;

async function getBabysitterPhones() {
  if (Date.now() - _phonesLastFetch < 5 * 60 * 1000) return _phones;
  const data = await bookingGet('/babysitters/phones');
  if (data && data.phones) {
    _phones = new Set(data.phones);
    _phonesLastFetch = Date.now();
  }
  return _phones;
}

// ── Onboarding ────────────────────────────────────────────────────────────────

async function checkOnboarding(sendFn) {
  const status = await bookingGet('/status');
  if (!status || status.onboarding_complete) return;
  if (!status.admins_set) {
    await sendFn('📋 *שירות תיאום שמרטפות*: מי מורשה להזמין שמרטפות?\nשלח שם ומספר טלפון לכל אחד, שורה אחת לכל מורשה. לדוגמה:\nאביב 050-4606660\nליאת 050-9244401').catch(() => {});
  }
  if (!status.babysitters_set) {
    await sendFn('📋 *שירות תיאום שמרטפות*: שלח רשימת שמרטפות.\nפורמט: שם, טלפון, תעריף בש"ח לשעה. שורה לכל שמרטפת. לדוגמה:\nלי, 054-6769434, 30').catch(() => {});
  }
}

// ── Reply parser ──────────────────────────────────────────────────────────────

const PHONE_RE = /0([5-9]\d{8})/g;
const RATE_RE = /(\d+)\s*(?:ש["']?ח|nis|₪)/i;

function parseOnboardingReply(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const hasPhones = PHONE_RE.test(text); PHONE_RE.lastIndex = 0;
  const hasRates = RATE_RE.test(text);

  if (!hasPhones) return null;

  if (hasRates) {
    // Babysitter list
    const sitters = [];
    for (const line of lines) {
      const cleaned = line.replace(/^\d+\.\s*/, '').trim();
      PHONE_RE.lastIndex = 0;
      const phoneMatch = PHONE_RE.exec(cleaned); PHONE_RE.lastIndex = 0;
      const rateMatch = RATE_RE.exec(cleaned);
      const name = cleaned.split(/[,،\s]+/)[0].replace(/[0-9\-]/g, '').trim();
      if (phoneMatch && name) {
        sitters.push({
          name,
          phone: '+972' + phoneMatch[1],
          hourly_rate_nis: rateMatch ? parseFloat(rateMatch[1]) : 30,
          gender: 'f',
        });
      }
    }
    if (sitters.length > 0) return { type: 'babysitters', data: { babysitters: sitters } };
  } else {
    // Admin list
    const admins = [];
    for (const line of lines) {
      PHONE_RE.lastIndex = 0;
      const phoneMatch = PHONE_RE.exec(line); PHONE_RE.lastIndex = 0;
      if (!phoneMatch) continue;
      const name = line.replace(/0[5-9]\d[\d\-]{6,}/, '').replace(/[-,\s]+/g, ' ').trim() || 'Admin';
      admins.push({ name, phone: '+972' + phoneMatch[1] });
    }
    if (admins.length > 0) return { type: 'admins', data: { admins } };
  }
  return null;
}

async function handleOnboardingReply(text, sendFn) {
  const status = await bookingGet('/status');
  if (!status || status.onboarding_complete) return false;

  const parsed = parseOnboardingReply(text);
  if (!parsed) return false;

  await bookingPost('/onboarding/' + parsed.type, parsed.data);

  const label = parsed.type === 'admins'
    ? parsed.data.admins.map(a => a.name).join(', ')
    : parsed.data.babysitters.map(s => `${s.name} (${s.hourly_rate_nis}₪/ש)`).join(', ');

  await sendFn(`✅ ${parsed.type === 'admins' ? 'מורשים נרשמו' : 'שמרטפות נרשמו'}: ${label}`).catch(() => {});
  setTimeout(() => checkOnboarding(sendFn).catch(() => {}), 1500);
  return true;
}

module.exports = { getBabysitterPhones, checkOnboarding, handleOnboardingReply };
