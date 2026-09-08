#!/usr/bin/env node
'use strict';

/**
 * adopt-orphan-events.js — H2: Reconcile calendar events with the notice pipeline.
 *
 * For each future calendar event that has no calendar_intents row, try to match
 * it to a notice by (date, normalized title). On match:
 *   - Write notices.calendar_event_id
 *   - Create a calendar_intents row with status='adopted'
 *   - Derive time_status from the notice
 *
 * Unmatched events go to an orphan_calendar_events table for visibility.
 *
 * Run: node scripts/adopt-orphan-events.js [--dry-run]
 * Schedule: daily via health check or cron.
 */

const { initDB, getDB } = require('../src/db');
const { listEventsForDateRange } = require('../src/calendar');
const crypto = require('crypto');

const DRY_RUN = process.argv.includes('--dry-run');

function normalizeTitle(str) {
  return (str || '')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}\u{FE00}-\u{FEFF}]/gu, '')
    .replace(/[\s\-–—_.,!?*()\[\]"'״]+/g, ' ')
    .trim()
    .toLowerCase();
}

function _normalizeForFingerprint(text) {
  if (!text) return '';
  return text
    .replace(/[\u0591-\u05C7]/g, '')
    .replace(/[-–—:,.!?"'״]/g, ' ')
    .replace(/\bה/g, '')
    .replace(/\bו/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 40);
}

function fingerprint(date, contentPrefix) {
  const raw = [(date || '').trim(), _normalizeForFingerprint(contentPrefix)].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex').substring(0, 16);
}

(async () => {
  initDB();
  const db = getDB();

  // Ensure orphan_calendar_events table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS orphan_calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      calendar_event_id TEXT NOT NULL UNIQUE,
      summary TEXT,
      event_date TEXT,
      event_start TEXT,
      created_at INTEGER NOT NULL,
      last_checked_at INTEGER NOT NULL
    )
  `);

  // Get all calendar_event_ids already in the pipeline
  const knownEventIds = new Set(
    db.prepare('SELECT calendar_event_id FROM calendar_intents WHERE calendar_event_id IS NOT NULL')
      .all().map(r => r.calendar_event_id)
  );
  const knownFromNotices = new Set(
    db.prepare('SELECT calendar_event_id FROM notices WHERE calendar_event_id IS NOT NULL')
      .all().map(r => r.calendar_event_id)
  );
  for (const id of knownFromNotices) knownEventIds.add(id);

  // Fetch future calendar events (next 30 days)
  const today = new Date().toISOString().split('T')[0];
  let events;
  try {
    events = await listEventsForDateRange(today, 0, 30);
  } catch (e) {
    console.error('Failed to fetch calendar events:', e.message);
    process.exit(1);
  }

  const orphans = [];
  let adopted = 0;
  let alreadyKnown = 0;

  for (const event of events) {
    if (knownEventIds.has(event.id)) {
      alreadyKnown++;
      continue;
    }

    const eventDate = (event.start?.dateTime || event.start?.date || '').slice(0, 10);
    const eventTitle = event.summary || '';
    const normTitle = normalizeTitle(eventTitle);

    if (!eventDate) continue;

    // Try to match a notice by date + title similarity
    const candidates = db.prepare(
      'SELECT id, content, relevance_date, relevance_time FROM notices WHERE relevance_date = ? AND dismissed = 0'
    ).all(eventDate);

    // Also check notice_event rows
    const neRows = db.prepare(
      'SELECT notice_id, event_title, event_time FROM notice_event WHERE event_date = ?'
    ).all(eventDate);

    let matchedNoticeId = null;
    let matchedTimeStatus = 'unknown';

    // Match against notices
    for (const n of candidates) {
      const normContent = normalizeTitle((n.content || '').substring(0, 100));
      if (normTitle && normContent && (normContent.includes(normTitle) || normTitle.includes(normContent))) {
        matchedNoticeId = n.id;
        matchedTimeStatus = n.relevance_time ? 'known' : 'unknown';
        break;
      }
    }

    // Match against notice_event rows (more precise)
    if (!matchedNoticeId) {
      for (const ne of neRows) {
        const normNeTitle = normalizeTitle(ne.event_title);
        if (normTitle && normNeTitle && (normNeTitle.includes(normTitle) || normTitle.includes(normNeTitle))) {
          matchedNoticeId = ne.notice_id;
          matchedTimeStatus = ne.event_time ? 'known' : 'unknown';
          break;
        }
      }
    }

    if (matchedNoticeId) {
      const fp = fingerprint(eventDate, eventTitle);
      const eventStart = event.start?.dateTime || null;
      const eventEnd = event.end?.dateTime || null;
      const now = Date.now();

      if (DRY_RUN) {
        console.log(`[DRY] ADOPT: "${eventTitle}" on ${eventDate} → notice #${matchedNoticeId} (time_status=${matchedTimeStatus})`);
      } else {
        // Create calendar_intents row
        db.prepare(`
          INSERT INTO calendar_intents (source, event_title, event_date, event_start, event_end, raw_message, status, calendar_event_id, created_at, notice_id, fingerprint, updated_at, time_status)
          VALUES ('adopted', ?, ?, ?, ?, '', 'adopted', ?, ?, ?, ?, ?, ?)
        `).run(eventTitle, eventDate, eventStart, eventEnd, event.id, now, matchedNoticeId, fp, now, matchedTimeStatus);

        // Link notice to calendar event
        db.prepare('UPDATE notices SET calendar_event_id = ?, calendar_status = ? WHERE id = ? AND calendar_event_id IS NULL')
          .run(event.id, 'adopted', matchedNoticeId);

        console.log(`ADOPTED: "${eventTitle}" on ${eventDate} → notice #${matchedNoticeId} (time_status=${matchedTimeStatus})`);
      }
      adopted++;
    } else {
      orphans.push({ id: event.id, summary: eventTitle, date: eventDate, start: event.start?.dateTime });
    }
  }

  // Record orphans
  const now = Date.now();
  for (const o of orphans) {
    if (DRY_RUN) {
      console.log(`[DRY] ORPHAN: "${o.summary}" on ${o.date}`);
    } else {
      db.prepare(`
        INSERT INTO orphan_calendar_events (calendar_event_id, summary, event_date, event_start, created_at, last_checked_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(calendar_event_id) DO UPDATE SET last_checked_at = ?
      `).run(o.id, o.summary, o.date, o.start, now, now, now);
    }
  }

  console.log(`\nResults: ${adopted} adopted, ${orphans.length} orphaned, ${alreadyKnown} already known`);
  if (DRY_RUN) console.log('(dry run — no changes made)');
})();
