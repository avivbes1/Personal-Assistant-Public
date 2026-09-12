/**
 * Regression: 2026-09-12 — Weekday correction on notice events (J2)
 *
 * The parent notice gets its relevance_date snapped to its asserted Hebrew
 * weekday (D1), but until J2 saveNoticeEvents() wrote each event's literal date
 * untouched. Notice 2807 said "שלישי 12.9 - הכתבה באנגלית": 12.9 is a Saturday,
 * the message asserts Tuesday, so the English essay must land on 2026-09-15 —
 * yet the notice_event row kept 2026-09-12.
 *
 * applyEventWeekdayCorrections() now runs the same deterministic snap on events,
 * preserving the literal date in date_raw and stamping date_source (P-016 —
 * weekday_he is advisory input, nearestWeekdayIso decides). saveNoticeEvents()
 * persists date_source/date_raw into event_date_source/event_date_raw.
 *
 * UC-1: weekday_he path — the 2807 essay (12.9 / שלישי) yields 2026-09-15,
 *       date_source='weekday_corrected', date_raw='2026-09-12'. (Acceptance.)
 * UC-2: delta inheritance — a no-weekday event sharing the parent's raw date
 *       shifts by the parent's raw→corrected delta.
 * UC-3: no correction derivable — no weekday, date != parent raw → untouched,
 *       date_source stays unset.
 * UC-4: a weekday_he that already agrees with the date is a no-op.
 * UC-5: saveNoticeEvents round-trips event_date_source / event_date_raw.
 */

const { applyEventWeekdayCorrections } = require('../../src/agent');
const { initDB, getDB, saveNotice, saveNoticeEvents } = require('../../src/db');

module.exports = {
  async run() {
    const errors = [];

    // ── UC-1: weekday_he path (the acceptance case) ─────────────────────────
    {
      const events = [{ date: '2026-09-12', time: null, title: 'הכתבה באנגלית', weekday_he: 'שלישי' }];
      applyEventWeekdayCorrections(events, {
        relevanceDateSource: 'weekday_corrected',
        relevanceDateRaw: '2026-09-10',
        relevanceDate: '2026-09-11',
      });
      const e = events[0];
      if (e.date !== '2026-09-15') errors.push(`UC-1: expected 2026-09-15, got ${e.date}`);
      if (e.date_raw !== '2026-09-12') errors.push(`UC-1: expected date_raw 2026-09-12, got ${e.date_raw}`);
      if (e.date_source !== 'weekday_corrected') errors.push(`UC-1: expected date_source weekday_corrected, got ${e.date_source}`);
    }

    // ── UC-2: delta inheritance (no weekday, shares parent raw date) ─────────
    {
      // Parent snapped 2026-09-10 → 2026-09-11 (delta +1). Event shares the raw.
      const events = [{ date: '2026-09-10', time: null, title: 'בוקרטוב' }];
      applyEventWeekdayCorrections(events, {
        relevanceDateSource: 'weekday_corrected',
        relevanceDateRaw: '2026-09-10',
        relevanceDate: '2026-09-11',
      });
      const e = events[0];
      if (e.date !== '2026-09-11') errors.push(`UC-2: expected 2026-09-11, got ${e.date}`);
      if (e.date_raw !== '2026-09-10') errors.push(`UC-2: expected date_raw 2026-09-10, got ${e.date_raw}`);
      if (e.date_source !== 'weekday_corrected') errors.push(`UC-2: expected date_source weekday_corrected, got ${e.date_source}`);
    }

    // ── UC-3: no correction derivable → untouched ───────────────────────────
    {
      // No weekday_he; date differs from parent raw; parent not weekday_corrected.
      const events = [{ date: '2027-01-12', time: null, title: 'אספת הורים' }];
      applyEventWeekdayCorrections(events, {
        relevanceDateSource: 'weekday_corrected',
        relevanceDateRaw: '2026-09-10',
        relevanceDate: '2026-09-11',
      });
      const e = events[0];
      if (e.date !== '2027-01-12') errors.push(`UC-3: date must be untouched, got ${e.date}`);
      if (e.date_raw != null) errors.push(`UC-3: date_raw must stay unset, got ${e.date_raw}`);
      if (e.date_source != null) errors.push(`UC-3: date_source must stay unset, got ${e.date_source}`);
    }

    // ── UC-4: weekday_he already agrees → no-op ─────────────────────────────
    {
      // 2026-09-15 IS a Tuesday (שלישי); nothing should change.
      const events = [{ date: '2026-09-15', time: null, title: 'x', weekday_he: 'שלישי' }];
      applyEventWeekdayCorrections(events, { relevanceDateSource: null, relevanceDateRaw: null, relevanceDate: null });
      const e = events[0];
      if (e.date !== '2026-09-15') errors.push(`UC-4: agreeing weekday must be a no-op, got ${e.date}`);
      if (e.date_source != null) errors.push(`UC-4: date_source must stay unset on no-op, got ${e.date_source}`);
    }

    // ── UC-5: saveNoticeEvents persists the provenance columns ──────────────
    initDB();
    const db = getDB();
    const clean = () => db.prepare("DELETE FROM notices WHERE thread_key='j2-wd-test'").run();
    clean();
    try {
      const nid = saveNotice({
        group_name: 'J2-Test', content: 'שלישי 12.9 - הכתבה באנגלית',
        relevance_date: '2026-09-11', source_timestamp: Date.now(), delivery_status: 'pending',
      });
      db.prepare("UPDATE notices SET thread_key='j2-wd-test' WHERE id=?").run(nid);

      const events = [{ date: '2026-09-12', time: null, title: 'הכתבה באנגלית', weekday_he: 'שלישי' }];
      applyEventWeekdayCorrections(events, {
        relevanceDateSource: 'weekday_corrected', relevanceDateRaw: '2026-09-10', relevanceDate: '2026-09-11',
      });
      saveNoticeEvents(nid, events);

      const row = db.prepare(
        'SELECT event_date, event_date_source, event_date_raw FROM notice_event WHERE notice_id=?'
      ).get(nid);
      if (!row) errors.push('UC-5: no notice_event row saved');
      else {
        if (row.event_date !== '2026-09-15') errors.push(`UC-5: stored event_date ${row.event_date}, want 2026-09-15`);
        if (row.event_date_source !== 'weekday_corrected') errors.push(`UC-5: stored event_date_source ${row.event_date_source}`);
        if (row.event_date_raw !== '2026-09-12') errors.push(`UC-5: stored event_date_raw ${row.event_date_raw}`);
      }
    } finally {
      clean();
    }

    return errors.length === 0
      ? { pass: true, message: 'J2: per-event weekday correction (weekday_he + delta inheritance) and event_date_source/raw persistence verified.' }
      : { pass: false, message: errors.join('\n         ') };
  },
};
