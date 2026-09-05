#!/usr/bin/env node
'use strict';

/**
 * generate-digest.js — Build the morning digest from the unified /api/context
 * endpoint (B3).
 *
 * Replaces the old OpenClaw cron payload that shelled into raw SQL against the
 * notices table. Now the digest is grounded in the SAME view Lipa uses to answer
 * schedule questions: calendar events (both parents, deduped), notice_event rows,
 * and notices — so the morning message can never drift from live answers.
 *
 * Contract: prints ONLY the formatted Hebrew digest text to stdout (no logs, no
 * explanations). Diagnostics go to stderr; a fetch failure exits non-zero. The
 * cron job runs `node scripts/generate-digest.js` and sends stdout verbatim.
 *
 * Window: today .. today+7 days (Israel time, via src/timeUtils).
 */

const http = require('http');
const { israelDateIso, addDaysIso } = require('../src/timeUtils');

const TZ = 'Asia/Jerusalem';
const PORT = process.env.VOICE_SERVER_PORT || 3001;
const HOST = process.env.VOICE_SERVER_HOST || 'localhost';

// ── HTTP: pull the unified context view ─────────────────────────────────────
function fetchContext(from, to) {
  const path = `/api/context?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, path, method: 'GET' }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) return reject(new Error(json.error || `HTTP ${res.statusCode}`));
          resolve(json);
        } catch (e) { reject(new Error(`bad response: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout contacting /api/context')); });
    req.end();
  });
}

// ── Formatting helpers ──────────────────────────────────────────────────────

// A YYYY-MM-DD → Hebrew label. Anchor at noon UTC so the calendar day is stable
// regardless of host TZ, then render in Israel time.
function heDate(iso, opts) {
  if (!iso) return '';
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('he-IL', { timeZone: TZ, ...opts });
}

// YYYY-MM-DD → "dd.mm" (day-first, the Israeli convention). Empty for a bad iso.
function ddmm(iso, sep = '.') {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}${sep}${m[2]}` : '';
}

// "שבת 05.09" — Hebrew short weekday + day-first date, for an event line.
function heDayLabel(iso) {
  const wd = heDate(iso, { weekday: 'short' });
  const dm = ddmm(iso);
  return [wd, dm].filter(Boolean).join(' ');
}

function eventStartIso(e) {
  return (e.start?.dateTime || e.start?.date || '').slice(0, 10);
}

// Time for a timed event ("HH:MM"), or '' for an all-day event (which the
// caller then omits entirely — spec B3.9).
function eventTime(e) {
  if (e.start?.dateTime) {
    return new Date(e.start.dateTime).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
  }
  return '';
}

// Normalize a title for dedupe: strip emojis/punctuation, collapse whitespace.
// Mirrors calendarGate.normalizeTitle so calendar↔notice_event matching agrees.
function normTitle(str) {
  return (str || '')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}\u{FE00}-\u{FEFF}]/gu, '')
    .replace(/[\s\-–—_.,!?*()\[\]"']+/g, ' ')
    .trim()
    .toLowerCase();
}

function firstLine(text, max = 70) {
  const line = (text || '').split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

// Owners on a calendar event may be 'aviv'/'liat'/'liat (work)' or Hebrew.
function ownerFlags(owners = []) {
  const os = owners.map(o => String(o).toLowerCase());
  return {
    aviv: os.some(o => o.includes('aviv') || o.includes('אביב')),
    liat: os.some(o => o.includes('liat') || o.includes('ליאת')),
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const today = israelDateIso();
  const weekEnd = addDaysIso(today, 7);

  let ctx;
  try {
    ctx = await fetchContext(today, weekEnd);
  } catch (e) {
    process.stderr.write(`[generate-digest] ${e.message}\n`);
    process.exit(1);
  }

  const notices = ctx.notices || [];
  const calendarEvents = ctx.calendar_events || [];
  const noticeEvents = ctx.notice_events || [];

  // Header: ☀️ *בוקר טוב — [hebrew_day] [dd/mm]* (spec B3.6/B3.8).
  const heDay = heDate(today, { weekday: 'long' });   // e.g. "יום שבת"
  const sections = [`☀️ *בוקר טוב — ${heDay} ${ddmm(today, '/')}*`];

  // ── Calendar events grouped by owner (aviv / liat / both) ─────────────────
  // aviv-only → לאביב, liat-only → לליאת, both (or unknown owner) → משפחה.
  const buckets = { aviv: [], liat: [], both: [] };
  for (const e of calendarEvents) {
    const { aviv, liat } = ownerFlags(e.owners);
    if (aviv && liat) buckets.both.push(e);
    else if (aviv) buckets.aviv.push(e);
    else if (liat) buckets.liat.push(e);
    else buckets.both.push(e); // owner unknown → show to family rather than drop
  }
  const byStart = (a, b) => (eventStartIso(a) + eventTime(a)).localeCompare(eventStartIso(b) + eventTime(b));
  for (const list of Object.values(buckets)) list.sort(byStart);

  const fmtEvent = e => {
    const summary = firstLine(e.summary || 'אירוע', 60);
    const time = eventTime(e); // '' for all-day → omitted (spec B3.9)
    const when = [heDayLabel(eventStartIso(e)), time].filter(Boolean).join(' ');
    return `• ${when} — ${summary}`;
  };

  // Emit a calendar section only when it has events (spec B3.7 — omit empties).
  const calSection = (label, list) =>
    list.length ? `*📅 ${label}:*\n${list.map(fmtEvent).join('\n')}` : null;
  const avivSec = calSection('לאביב', buckets.aviv);
  const liatSec = calSection('לליאת', buckets.liat);
  const bothSec = calSection('לשניהם / משפחה', buckets.both);
  if (avivSec) sections.push(avivSec);
  if (liatSec) sections.push(liatSec);
  if (bothSec) sections.push(bothSec);

  // ── 💡 לתשומת לב: notice_events + notices ─────────────────────────────────
  // Dedup 1: drop a notice_event whose (date, title) matches a calendar event —
  // the calendar entry is the authoritative version, so prefer it (spec B3.5).
  const calKeys = calendarEvents.map(e => ({ date: eventStartIso(e), title: normTitle(e.summary) }));
  const matchesCalendar = (date, title) => {
    const nt = normTitle(title);
    return calKeys.some(k => k.date === date && k.title && nt &&
      (k.title.includes(nt) || nt.includes(k.title)));
  };

  const attentionEvents = noticeEvents
    .filter(ne => !matchesCalendar(ne.event_date, ne.event_title))
    .sort((a, b) => `${a.event_date}${a.event_time || ''}`.localeCompare(`${b.event_date}${b.event_time || ''}`));

  // Dedup 2: a notice whose id already appears as a notice_event above is
  // redundant — its dated events are shown, so skip the parent notice.
  const surfacedNoticeIds = new Set(noticeEvents.map(ne => ne.notice_id));
  const attentionNotices = notices.filter(n => !surfacedNoticeIds.has(n.id));

  const attentionLines = [];
  for (const ne of attentionEvents) {
    const time = ne.event_time ? ` ${ne.event_time}` : '';
    attentionLines.push(`• ${heDayLabel(ne.event_date)}${time} — ${firstLine(ne.event_title || ne.content, 70)}`);
  }
  for (const n of attentionNotices) {
    const dayLbl = n.relevance_date ? heDayLabel(n.relevance_date) : '';
    const prefix = dayLbl ? `${dayLbl} — ` : '';
    // Surface the day/date-mismatch warning inline so it isn't silently lost.
    const warn = (n.weekday_mismatch && n.validation_notes) ? '⚠️ ' : '';
    attentionLines.push(`• ${warn}${prefix}${firstLine(n.content, 70)}`);
  }
  if (attentionLines.length) sections.push(`*💡 לתשומת לב:*\n${attentionLines.join('\n')}`);

  // Blank line between sections; single trailing newline.
  process.stdout.write(`${sections.join('\n\n')}\n`);
})();
