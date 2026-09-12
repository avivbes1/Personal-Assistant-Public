#!/usr/bin/env node
'use strict';

/**
 * J2 backfill — one-time re-correction of per-event dates on notices whose
 * Hebrew weekday name contradicted the digit date the message cited
 * (weekday_mismatch=1). Until J2, saveNoticeEvents() wrote the literal date, so
 * an event that should land on Tuesday kept the mismatched Saturday.
 *
 * Idempotent: only touches future events whose event_date_source IS NULL, and
 * stamps event_date_source='weekday_corrected' on success — a second run skips
 * every row it already corrected.
 *
 * Two correction paths, mirroring src/agent.js:
 *   1. A weekday is known for the event (KNOWN_EVENT_WEEKDAYS below, recovered
 *      by reading the source notice — old rows predate the weekday_he field):
 *      snap via nearestWeekdayIso(±3).
 *   2. The parent was weekday_corrected and the event shares its raw date:
 *      inherit the parent's correction delta.
 *
 * Run against the live DB (data/family.db) by default, or set FAMILYBOT_DB_PATH.
 */

const { initDB, getDB } = require('../src/db');
const { extractHebrewWeekday, nearestWeekdayIso } = require('../src/date-parse');
const { addDaysIso } = require('../src/timeUtils');

// Weekdays recovered by reading the source notice content. Old notice_event rows
// were written before events[] carried weekday_he, so the deterministic corrector
// has nothing to key on retroactively — this map supplies that lost input.
//   notice 2807: "...שלישי 12.9 - הכתבה באנגלית" → event 130 asserts שלישי (Tue).
const KNOWN_EVENT_WEEKDAYS = {
  130: 'שלישי',
};

function recomputeExpiresAt(dateIso, timeStr) {
  if (timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    const d = new Date(`${dateIso}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+03:00`);
    return d.getTime() + 2 * 3600000;
  }
  return new Date(`${dateIso}T23:59:59+03:00`).getTime();
}

function main() {
  initDB();
  const db = getDB();

  const rows = db.prepare(
    `SELECT e.id AS eid, e.notice_id, e.event_date, e.event_time, e.event_title,
            e.event_date_source,
            n.relevance_date, n.relevance_date_raw, n.relevance_date_source
     FROM notice_event e
     JOIN notices n ON n.id = e.notice_id
     WHERE n.weekday_mismatch = 1
       AND e.event_date >= date('now')
     ORDER BY e.notice_id, e.id`
  ).all();

  console.log(`[J2 backfill] ${rows.length} future events under weekday_mismatch notices.`);

  const update = db.prepare(
    `UPDATE notice_event
        SET event_date = ?, event_date_raw = ?, event_date_source = 'weekday_corrected', expires_at = ?
      WHERE id = ?`
  );

  let corrected = 0, skipped = 0;
  for (const r of rows) {
    if (r.event_date_source) {
      console.log(`  · event ${r.eid} '${r.event_title}': already has source=${r.event_date_source}, skip.`);
      skipped++;
      continue;
    }

    let target = null, reason = null;
    const wdText = KNOWN_EVENT_WEEKDAYS[r.eid];
    if (wdText) {
      const idx = extractHebrewWeekday(wdText);
      const snapped = idx != null ? nearestWeekdayIso(r.event_date, idx, 3) : null;
      if (snapped && snapped !== r.event_date) {
        target = snapped;
        reason = `weekday '${wdText}' → nearest ${snapped}`;
      }
    } else if (
      r.relevance_date_source === 'weekday_corrected' &&
      r.relevance_date_raw && r.relevance_date &&
      r.event_date === r.relevance_date_raw
    ) {
      const [ry, rm, rd] = r.relevance_date_raw.split('-').map(Number);
      const [fy, fm, fd] = r.relevance_date.split('-').map(Number);
      const delta = Math.round((Date.UTC(fy, fm - 1, fd) - Date.UTC(ry, rm - 1, rd)) / 86400000);
      const shifted = delta ? addDaysIso(r.event_date, delta) : null;
      if (shifted && shifted !== r.event_date) {
        target = shifted;
        reason = `inherit parent delta ${delta}d → ${shifted}`;
      }
    }

    if (!target) {
      console.log(`  · event ${r.eid} '${r.event_title}' (${r.event_date}): no correction derivable, skip.`);
      skipped++;
      continue;
    }

    const expiresAt = recomputeExpiresAt(target, r.event_time);
    update.run(target, r.event_date, expiresAt, r.eid);
    console.log(`  ✓ event ${r.eid} '${r.event_title}': ${r.event_date} → ${target} (${reason}); raw preserved.`);
    corrected++;
  }

  console.log(`[J2 backfill] done — ${corrected} corrected, ${skipped} skipped.`);
}

main();
