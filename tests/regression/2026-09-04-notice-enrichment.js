/**
 * Regression: 2026-09-04 — Notice enrichment on follow-up (K4)
 *
 * When a later message in a group added info to an earlier notice (teacher
 * announces "parent meeting on 9.9", then two days later posts the time), the
 * follow-up landed as a SEPARATE notice and the original stayed incomplete.
 * enrichNoticeByThreadKey() now gap-fills the original from the follow-up,
 * matching on thread_key within 14 days — strictly filling empty fields, never
 * overwriting a set one, and appending the follow-up's source.
 *
 * UC-1: a follow-up fills the original's NULL relevance_time, promotes
 *       calendar_worthy 0→1, and appends the new source (created_at preserved).
 * UC-2: a set field is NEVER overwritten (different time on follow-up ignored).
 * UC-3: a linked calendar_intent flips time_status 'unknown' → 'updated' once a
 *       time arrives.
 * UC-4: no matching thread → skip (enriched:false), and a null thread_key skips.
 * UC-5: match window is 14 days — an older-than-14d original is not enriched.
 */

const {
  initDB,
  getDB,
  saveNotice,
  enrichNoticeByThreadKey,
} = require('../../src/db');

const DAY = 24 * 60 * 60 * 1000;

module.exports = {
  async run() {
    const errors = [];
    initDB();
    const db = getDB();

    // Isolate this test's rows by a unique thread/group prefix.
    const clean = () => {
      db.prepare("DELETE FROM calendar_intents WHERE event_title LIKE 'K4-%'").run();
      db.prepare("DELETE FROM notices WHERE thread_key LIKE 'k4-%'").run();
    };
    clean();

    try {
      const now = Date.now();

      // ── UC-1: gap-fill time + promote calendar_worthy + append source ──────
      const oldId = saveNotice({
        group_name: 'K4-GroupA', content: 'אסיפת הורים ב-9.9',
        relevance_date: '2026-09-09', relevance_time: null,
        source_timestamp: now, delivery_status: 'pending', calendar_worthy: 0,
      });
      db.prepare("UPDATE notices SET thread_key='k4-pm' WHERE id=?").run(oldId);
      const origCreatedAt = db.prepare('SELECT created_at FROM notices WHERE id=?').get(oldId).created_at;

      const newId = saveNotice({
        group_name: 'K4-GroupB', content: 'אסיפת הורים בשעה 18:00',
        relevance_date: '2026-09-09', relevance_time: '18:00',
        source_timestamp: now + 2 * DAY, delivery_status: 'pending', calendar_worthy: 1,
      });
      db.prepare("UPDATE notices SET thread_key='k4-pm' WHERE id=?").run(newId);

      const r1 = enrichNoticeByThreadKey(newId, 'k4-pm', {
        relevance_time: '18:00', relevance_date: '2026-09-09', relevant_datetime: null,
        valid_until: '2026-09-09', event_type: null, calendar_worthy: 1,
      }, 'K4-GroupB');

      if (!r1.enriched) errors.push('UC-1: expected enriched:true');
      if (r1.oldId !== oldId) errors.push(`UC-1: enriched wrong notice (got ${r1.oldId}, want ${oldId})`);
      if (!r1.fields || !r1.fields.includes('relevance_time')) errors.push('UC-1: relevance_time not reported enriched');
      if (!r1.fields || !r1.fields.includes('calendar_worthy')) errors.push('UC-1: calendar_worthy not reported enriched');

      const oldRow = db.prepare('SELECT relevance_time, calendar_worthy, sources, created_at FROM notices WHERE id=?').get(oldId);
      if (oldRow.relevance_time !== '18:00') errors.push(`UC-1: time not filled (got ${oldRow.relevance_time})`);
      if (oldRow.calendar_worthy !== 1) errors.push(`UC-1: calendar_worthy not promoted (got ${oldRow.calendar_worthy})`);
      if (oldRow.created_at !== origCreatedAt) errors.push('UC-1: created_at must be preserved');
      let sources;
      try { sources = JSON.parse(oldRow.sources); } catch (_) { sources = null; }
      if (!Array.isArray(sources) || !sources.includes('K4-GroupA') || !sources.includes('K4-GroupB')) {
        errors.push(`UC-1: sources not appended correctly (got ${oldRow.sources})`);
      }

      // Idempotency: re-running must not double-append or re-enrich.
      const r1b = enrichNoticeByThreadKey(newId, 'k4-pm', {
        relevance_time: '18:00', calendar_worthy: 1,
      }, 'K4-GroupB');
      if (r1b.enriched) errors.push('UC-1: re-run should be a no-op (enriched:false)');

      // ── UC-2: never overwrite a set field ─────────────────────────────────
      const setId = saveNotice({
        group_name: 'K4-G', content: 'x', relevance_date: '2026-09-09', relevance_time: '17:00',
        source_timestamp: now, delivery_status: 'pending', calendar_worthy: 1,
      });
      db.prepare("UPDATE notices SET thread_key='k4-set' WHERE id=?").run(setId);
      const fuId = saveNotice({
        group_name: 'K4-G', content: 'y', relevance_date: '2026-09-09', relevance_time: '18:00',
        source_timestamp: now + 1000, delivery_status: 'pending', calendar_worthy: 1,
      });
      db.prepare("UPDATE notices SET thread_key='k4-set' WHERE id=?").run(fuId);
      enrichNoticeByThreadKey(fuId, 'k4-set', { relevance_time: '18:00', calendar_worthy: 1 }, 'K4-G');
      const setRow = db.prepare('SELECT relevance_time FROM notices WHERE id=?').get(setId);
      if (setRow.relevance_time !== '17:00') errors.push(`UC-2: set time overwritten (got ${setRow.relevance_time})`);

      // ── UC-3: linked calendar_intent time_status unknown → updated ─────────
      db.prepare(
        "INSERT INTO calendar_intents (source, event_title, event_date, status, created_at, notice_id, time_status) " +
        "VALUES ('realtime','K4-intent','2026-09-09','pending',?,?, 'unknown')"
      ).run(now, oldId);
      // Re-enrich with a fresh original that still lacks a time, so relevance_time
      // is among the enriched fields and the intent update fires.
      const oldId2 = saveNotice({
        group_name: 'K4-GroupA', content: 'טיול ב-10.9', relevance_date: '2026-09-10', relevance_time: null,
        source_timestamp: now, delivery_status: 'pending', calendar_worthy: 0,
      });
      db.prepare("UPDATE notices SET thread_key='k4-trip' WHERE id=?").run(oldId2);
      db.prepare(
        "INSERT INTO calendar_intents (source, event_title, event_date, status, created_at, notice_id, time_status) " +
        "VALUES ('realtime','K4-trip','2026-09-10','pending',?,?, 'unknown')"
      ).run(now, oldId2);
      const fu2 = saveNotice({
        group_name: 'K4-GroupA', content: 'טיול בשעה 8:00', relevance_date: '2026-09-10', relevance_time: '08:00',
        source_timestamp: now + DAY, delivery_status: 'pending', calendar_worthy: 0,
      });
      db.prepare("UPDATE notices SET thread_key='k4-trip' WHERE id=?").run(fu2);
      enrichNoticeByThreadKey(fu2, 'k4-trip', { relevance_time: '08:00' }, 'K4-GroupA');
      const intent = db.prepare('SELECT time_status FROM calendar_intents WHERE notice_id=?').get(oldId2);
      if (!intent || intent.time_status !== 'updated') {
        errors.push(`UC-3: intent time_status not updated (got ${intent && intent.time_status})`);
      }

      // ── UC-4: no matching thread, and null thread_key, both skip ───────────
      const r4a = enrichNoticeByThreadKey(fu2, 'k4-no-such-thread', { relevance_time: '09:00' }, 'K4-GroupA');
      if (r4a.enriched) errors.push('UC-4: nonexistent thread should skip');
      const r4b = enrichNoticeByThreadKey(fu2, null, { relevance_time: '09:00' }, 'K4-GroupA');
      if (r4b.enriched) errors.push('UC-4: null thread_key should skip');

      // ── UC-5: original older than 14 days is out of window ─────────────────
      const staleId = saveNotice({
        group_name: 'K4-Old', content: 'stale', relevance_date: '2026-08-01', relevance_time: null,
        source_timestamp: now - 20 * DAY, delivery_status: 'pending', calendar_worthy: 0,
      });
      // created_at is stamped to now inside saveNotice, so backdate it explicitly.
      db.prepare("UPDATE notices SET thread_key='k4-stale', created_at=? WHERE id=?").run(now - 20 * DAY, staleId);
      const freshFu = saveNotice({
        group_name: 'K4-Old', content: 'stale time', relevance_date: '2026-08-01', relevance_time: '10:00',
        source_timestamp: now, delivery_status: 'pending', calendar_worthy: 0,
      });
      db.prepare("UPDATE notices SET thread_key='k4-stale' WHERE id=?").run(freshFu);
      const r5 = enrichNoticeByThreadKey(freshFu, 'k4-stale', { relevance_time: '10:00' }, 'K4-Old');
      if (r5.enriched) errors.push('UC-5: original >14d old must be out of window');
    } finally {
      clean();
    }

    return errors.length === 0
      ? { pass: true, message: 'K4: follow-up enrichment gap-fills prior notice, never overwrites, updates calendar intent, respects 14d window.' }
      : { pass: false, message: errors.join('\n         ') };
  },
};
