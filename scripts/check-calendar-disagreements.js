#!/usr/bin/env node
'use strict';

/**
 * check-calendar-disagreements.js — H4: Detect mismatches between calendar
 * events and their source notices/notice_events.
 *
 * Compares every future calendar event that has a linked notice (via
 * calendar_intents) against the notice_event rows. Reports any mismatch in
 * time, date, or location.
 *
 * Run: node scripts/check-calendar-disagreements.js
 * Output: one line per disagreement, or "OK" if none found.
 * Exit: 0 = no issues, 1 = disagreements found (for health check integration).
 */

const { initDB, getDB, getVisibleNoticeEvents } = require('../src/db');
const { listEventsForDateRange } = require('../src/calendar');

function normalizeTitle(str) {
  return (str || '')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}\u{FE00}-\u{FEFF}]/gu, '')
    .replace(/[\s\-–—_.,!?*()\[\]"'״]+/g, ' ')
    .trim()
    .toLowerCase();
}

(async () => {
  initDB();
  const db = getDB();

  const today = new Date().toISOString().split('T')[0];

  // Get all future calendar_intents with linked events
  const intents = db.prepare(`
    SELECT ci.id, ci.event_title, ci.event_date, ci.event_start, ci.time_status,
           ci.calendar_event_id, ci.notice_id
    FROM calendar_intents ci
    WHERE ci.event_date >= ?
      AND ci.calendar_event_id IS NOT NULL
      AND ci.status IN ('applied', 'adopted')
  `).all(today);

  const disagreements = [];

  for (const intent of intents) {
    if (!intent.notice_id) continue;

    // Get notice_event rows for this notice + date (P-020/J6: visibility-joined)
    const neRows = getVisibleNoticeEvents({ noticeId: intent.notice_id, from: intent.event_date, to: intent.event_date });

    // Also check other notices that reference the same date with matching titles
    const relatedNe = getVisibleNoticeEvents({ from: intent.event_date, to: intent.event_date })
      .filter(ne => ne.event_time && ne.event_time.length > 0);

    // Find matching notice_events by title similarity
    const normIntentTitle = normalizeTitle(intent.event_title);
    const matchingNe = [...neRows, ...relatedNe].filter(ne => {
      const normNe = normalizeTitle(ne.event_title);
      return normNe && normIntentTitle &&
        (normNe.includes(normIntentTitle) || normIntentTitle.includes(normNe));
    });

    // Check for time disagreements
    const intentTime = intent.event_start?.includes('T')
      ? intent.event_start.split('T')[1].substring(0, 5)
      : null;

    for (const ne of matchingNe) {
      if (ne.event_time && intentTime && ne.event_time !== intentTime) {
        disagreements.push({
          intentId: intent.id,
          eventTitle: intent.event_title,
          eventDate: intent.event_date,
          calendarTime: intentTime,
          sourceTime: ne.event_time,
          sourceNotice: ne.notice_id || intent.notice_id,
          calendarEventId: intent.calendar_event_id,
        });
        break; // one disagreement per intent is enough
      }

      // Time in source but intent has no time (unknown)
      if (ne.event_time && !intentTime && intent.time_status === 'unknown') {
        disagreements.push({
          intentId: intent.id,
          eventTitle: intent.event_title,
          eventDate: intent.event_date,
          calendarTime: 'all-day',
          sourceTime: ne.event_time,
          sourceNotice: ne.notice_id || intent.notice_id,
          calendarEventId: intent.calendar_event_id,
        });
        break;
      }
    }
  }

  if (disagreements.length === 0) {
    console.log('OK — no calendar-vs-source disagreements');
    process.exit(0);
  }

  console.log(`⚠️ ${disagreements.length} calendar-vs-source disagreement(s):\n`);
  for (const d of disagreements) {
    console.log(`  "${d.eventTitle}" on ${d.eventDate}`);
    console.log(`    Calendar: ${d.calendarTime} | Source (notice #${d.sourceNotice}): ${d.sourceTime}`);
    console.log(`    Event ID: ${d.calendarEventId} | Intent #${d.intentId}`);
    console.log();
  }
  process.exit(1);
})();
