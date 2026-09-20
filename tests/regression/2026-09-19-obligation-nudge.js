/**
 * Regression: 2026-09-19 — Obligation nudge correctness (Phase Q)
 *
 * Three notices (3149, 3150, 3204) about the same obligation ("שלחו סרטון
 * עד יום שישי 20.9") produced three separate nudges with the wrong date (20.9
 * instead of the weekday-corrected 18.9), because detectObligationDeadline()
 * re-parsed the raw text instead of trusting the stored weekday correction.
 *
 * Phase Q fixes five bugs:
 *   Q1: detectObligationDeadline() uses resolveNoticeDate() first
 *   Q2: dedup by obligation_key, not notice_id
 *   Q3: re-validate deadline before sending
 *   Q4: sweep window [today, tomorrow] instead of exact tomorrow
 *   Q5: backfill existing nudge rows
 *
 * UC-1: weekday_mismatch=1 → resolver returns corrected date, not raw text date
 * UC-2: three notices, same obligation → one nudge citing all three sources
 * UC-3: missed sweep day → nudge still fires (late, not lost)
 * UC-4: date corrected after recording → re-resolved before send
 * UC-5: past-deadline nudges marked 'missed', not sent
 */

const { initDB, getDB } = require('../../src/db');
const { detectObligationDeadline, computeObligationKey, recordObligationNudge, checkObligationNudges } = require('../../src/proactive');
const { resolveNoticeDate } = require('../../src/date-parse');
const { israelDateIso, addDaysIso } = require('../../src/timeUtils');

module.exports = {
  async run() {
    const errors = [];

    // ── UC-1: resolveNoticeDate returns weekday-corrected date ───────────────
    {
      // A notice says "עד יום שישי 20.9" but Friday is actually 18.9.
      // The notice has relevance_date_source='weekday_corrected' and relevance_date='2026-09-18'.
      const fakeNotice = {
        id: null,  // no DB lookup
        content: 'עדי ובאבל ביקשו שליחת סרטון של המשפט האישי של נטע עד יום שישי 20.9',
        relevance_date: '2026-09-18',
        relevance_date_source: 'weekday_corrected',
        weekday_mismatch: 1,
      };
      const resolved = resolveNoticeDate(fakeNotice);
      if (!resolved) errors.push('UC-1: resolveNoticeDate returned null');
      else if (resolved.iso !== '2026-09-18') errors.push(`UC-1: expected 2026-09-18, got ${resolved.iso}`);
      else if (resolved.source !== 'relevance_weekday_corrected') errors.push(`UC-1: expected source=relevance_weekday_corrected, got ${resolved.source}`);
    }

    // ── UC-1b: detectObligationDeadline on notice row uses corrected date ────
    {
      const fakeNotice = {
        id: null,
        content: 'עדי ובאבל ביקשו שליחת סרטון של המשפט האישי של נטע עד יום שישי 20.9',
        relevance_date: '2026-09-18',
        relevance_date_source: 'weekday_corrected',
        weekday_mismatch: 1,
      };
      const deadline = detectObligationDeadline(fakeNotice);
      if (!deadline) errors.push('UC-1b: detectObligationDeadline returned null');
      else {
        if (deadline.deadlineDate !== '2026-09-18') errors.push(`UC-1b: expected deadlineDate 2026-09-18, got ${deadline.deadlineDate}`);
        if (deadline.deadlineSource !== 'relevance_weekday_corrected') errors.push(`UC-1b: expected deadlineSource relevance_weekday_corrected, got ${deadline.deadlineSource}`);
      }
    }

    // ── UC-1c: legacy string call still works (backward compat) ─────────────
    {
      const deadline = detectObligationDeadline('להגיש עד 25.9');
      if (!deadline) errors.push('UC-1c: detectObligationDeadline(string) returned null');
      else {
        if (deadline.deadlineDate !== '2026-09-25') errors.push(`UC-1c: expected 2026-09-25, got ${deadline.deadlineDate}`);
        if (deadline.deadlineSource !== 'content_explicit') errors.push(`UC-1c: expected source content_explicit, got ${deadline.deadlineSource}`);
      }
    }

    // ── UC-2: obligation_key dedup ──────────────────────────────────────────
    {
      // Same thread_key → same obligation_key
      const k1 = computeObligationKey({ threadKey: 'test-thread', childName: 'נטע', deadlineDate: '2026-09-18', obligationText: 'test' });
      const k2 = computeObligationKey({ threadKey: 'test-thread', childName: 'שגב', deadlineDate: '2026-09-20', obligationText: 'different' });
      if (k1 !== 'test-thread') errors.push(`UC-2a: threadKey should be used directly, got ${k1}`);
      if (k2 !== 'test-thread') errors.push(`UC-2b: threadKey should be used directly, got ${k2}`);

      // No thread_key → sha1 fingerprint of (child, deadline, text)
      const k3 = computeObligationKey({ threadKey: null, childName: 'נטע', deadlineDate: '2026-09-18', obligationText: 'סרטון משפט אישי' });
      const k4 = computeObligationKey({ threadKey: null, childName: 'נטע', deadlineDate: '2026-09-18', obligationText: 'סרטון משפט אישי' });
      if (k3 !== k4) errors.push(`UC-2c: same input should produce same key: ${k3} vs ${k4}`);
      if (k3.length !== 16) errors.push(`UC-2d: expected 16-char sha1 prefix, got length ${k3.length}`);

      // Different child or different date → different key
      const k5 = computeObligationKey({ threadKey: null, childName: 'שגב', deadlineDate: '2026-09-18', obligationText: 'סרטון משפט אישי' });
      if (k3 === k5) errors.push('UC-2e: different child should produce different key');
    }

    // ── UC-2b: recordObligationNudge collapses duplicates ───────────────────
    {
      initDB();
      const db = getDB();
      // Clean slate
      db.prepare('DELETE FROM obligation_nudges WHERE obligation_text LIKE ?').run('%UC2TEST%');

      // Insert three notices with the same thread_key
      const nIds = [];
      for (let i = 0; i < 3; i++) {
        const r = db.prepare(
          `INSERT INTO notices (content, group_name, source_timestamp, created_at, thread_key, primary_child,
                               relevance_date, relevance_date_source, weekday_mismatch)
           VALUES (?, 'test', ?, ?, 'uc2-thread-test', 'נטע', '2026-09-18', 'weekday_corrected', 1)`
        ).run(`UC2TEST notice ${i} — שלחו סרטון עד יום שישי 20.9`, Date.now(), Date.now());
        nIds.push(Number(r.lastInsertRowid));
      }

      // Record nudges for all three — should produce exactly one row
      for (const nid of nIds) {
        recordObligationNudge(nid, {
          deadlineDate: '2026-09-18',
          obligationText: 'UC2TEST — שלחו סרטון',
          childName: 'נטע',
          deadlineSource: 'relevance_weekday_corrected',
        });
      }

      const nudges = db.prepare(
        "SELECT * FROM obligation_nudges WHERE obligation_text LIKE '%UC2TEST%'"
      ).all();
      if (nudges.length !== 1) {
        errors.push(`UC-2f: expected 1 nudge row, got ${nudges.length}`);
      } else {
        const ids = JSON.parse(nudges[0].notice_ids || '[]');
        if (ids.length !== 3) errors.push(`UC-2g: expected 3 notice_ids, got ${ids.length}: ${JSON.stringify(ids)}`);
        if (ids[0] !== nIds[0]) errors.push(`UC-2h: first notice_id should be ${nIds[0]}, got ${ids[0]}`);
      }

      // Cleanup
      db.prepare("DELETE FROM obligation_nudges WHERE obligation_text LIKE '%UC2TEST%'").run();
      for (const nid of nIds) db.prepare('DELETE FROM notices WHERE id = ?').run(nid);
    }

    // ── UC-5: past-deadline nudges → 'missed' ───────────────────────────────
    {
      initDB();
      const db = getDB();

      // Insert a test notice
      const nr = db.prepare(
        `INSERT INTO notices (content, group_name, source_timestamp, created_at, thread_key, primary_child,
                             relevance_date, relevance_date_source, weekday_mismatch)
         VALUES ('UC5TEST להגיש עד 1.1', 'test', ?, ?, 'uc5-test', 'נטע', '2026-01-01', 'explicit', 0)`
      ).run(Date.now(), Date.now());
      const testNoticeId = Number(nr.lastInsertRowid);

      // Insert a nudge with a deadline in the past
      db.prepare(
        `INSERT INTO obligation_nudges (notice_id, notice_ids, obligation_key, deadline_date, deadline_source, child_name, obligation_text, status)
         VALUES (?, ?, 'uc5-key-test', '2025-01-01', 'content_explicit', 'נטע', 'UC5TEST — past deadline', 'pending')`
      ).run(testNoticeId, JSON.stringify([testNoticeId]));

      // Stub guardedSendProactive so we don't actually send
      const guardedSend = require('../../src/delivery/guardedSend');
      const origSend = guardedSend.guardedSendProactive;
      guardedSend.guardedSendProactive = async () => ({ sent: false, reason: 'stubbed' });

      try {
        const result = await checkObligationNudges();
        const row = db.prepare(
          "SELECT status FROM obligation_nudges WHERE obligation_key = 'uc5-key-test'"
        ).get();
        if (!row || row.status !== 'missed') {
          errors.push(`UC-5: expected status='missed' for past deadline, got ${row ? row.status : 'no row'}`);
        }
      } finally {
        guardedSend.guardedSendProactive = origSend;
      }

      // Cleanup
      db.prepare("DELETE FROM obligation_nudges WHERE obligation_key = 'uc5-key-test'").run();
      db.prepare('DELETE FROM notices WHERE id = ?').run(testNoticeId);
    }

    // ── UC-3: Q4 — a deadline that is TODAY still SENDS (missed-day resilience) ─
    {
      initDB();
      const db = getDB();
      const today = israelDateIso();

      // Notice carries a weekday correction pointing at today, with a deadline
      // phrasing in the content so the re-resolve step re-confirms it.
      const nr = db.prepare(
        `INSERT INTO notices (content, group_name, source_timestamp, created_at, thread_key, primary_child,
                             relevance_date, relevance_date_source, weekday_mismatch)
         VALUES ('UC3TEST להגיש עד יום חמישי', 'test', ?, ?, 'uc3-test', 'נטע', ?, 'weekday_corrected', 1)`
      ).run(Date.now(), Date.now(), today);
      const nid = Number(nr.lastInsertRowid);

      db.prepare(
        `INSERT INTO obligation_nudges (notice_id, notice_ids, obligation_key, deadline_date, deadline_source, child_name, obligation_text, status)
         VALUES (?, ?, 'uc3-key-test', ?, 'relevance_weekday_corrected', 'נטע', 'UC3TEST — הגשה', 'pending')`
      ).run(nid, JSON.stringify([nid]), today);

      const guardedSend = require('../../src/delivery/guardedSend');
      const origSend = guardedSend.guardedSendProactive;
      const sent = [];
      guardedSend.guardedSendProactive = async ({ noticeId }) => { sent.push(noticeId); return { sent: true, text: 'stub' }; };
      try {
        await checkObligationNudges();
        const row = db.prepare("SELECT * FROM obligation_nudges WHERE obligation_key = 'uc3-key-test'").get();
        if (!row || row.status !== 'sent') errors.push(`UC-3: today-deadline nudge should be 'sent', got ${row ? row.status : 'no row'}`);
        if (!sent.includes(nid)) errors.push('UC-3: expected a send for the today-deadline notice');
      } finally {
        guardedSend.guardedSendProactive = origSend;
      }

      db.prepare("DELETE FROM obligation_nudges WHERE obligation_key = 'uc3-key-test'").run();
      db.prepare('DELETE FROM notices WHERE id = ?').run(nid);
    }

    // ── UC-4: Q3 — correction after recording → fires on the corrected day ─────
    {
      initDB();
      const db = getDB();
      const today = israelDateIso();
      const tomorrow = addDaysIso(today, 1);

      // Notice now points at today (weekday-corrected), but the nudge was
      // recorded earlier with a stale deadline of tomorrow.
      const nr = db.prepare(
        `INSERT INTO notices (content, group_name, source_timestamp, created_at, thread_key, primary_child,
                             relevance_date, relevance_date_source, weekday_mismatch)
         VALUES ('UC4TEST לשלם עד יום חמישי', 'test', ?, ?, 'uc4-test', 'נטע', ?, 'weekday_corrected', 1)`
      ).run(Date.now(), Date.now(), today);
      const nid = Number(nr.lastInsertRowid);

      db.prepare(
        `INSERT INTO obligation_nudges (notice_id, notice_ids, obligation_key, deadline_date, deadline_source, child_name, obligation_text, status)
         VALUES (?, ?, 'uc4-key-test', ?, 'content_explicit', 'נטע', 'UC4TEST — תשלום', 'pending')`
      ).run(nid, JSON.stringify([nid]), tomorrow);

      const guardedSend = require('../../src/delivery/guardedSend');
      const origSend = guardedSend.guardedSendProactive;
      const sent = [];
      guardedSend.guardedSendProactive = async ({ noticeId }) => { sent.push(noticeId); return { sent: true, text: 'stub' }; };
      try {
        await checkObligationNudges();
        const row = db.prepare("SELECT * FROM obligation_nudges WHERE obligation_key = 'uc4-key-test'").get();
        if (!row) {
          errors.push('UC-4: nudge row vanished');
        } else {
          if (row.deadline_date !== today) errors.push(`UC-4: deadline should be corrected to ${today}, got ${row.deadline_date}`);
          if (row.deadline_source !== 'relevance_weekday_corrected') errors.push(`UC-4: deadline_source should update to relevance_weekday_corrected, got ${row.deadline_source}`);
          if (row.status !== 'sent') errors.push(`UC-4: corrected nudge should be 'sent', got ${row.status}`);
        }
        if (!sent.includes(nid)) errors.push('UC-4: expected a send after correction');
      } finally {
        guardedSend.guardedSendProactive = origSend;
      }

      db.prepare("DELETE FROM obligation_nudges WHERE obligation_key = 'uc4-key-test'").run();
      db.prepare('DELETE FROM notices WHERE id = ?').run(nid);
    }

    return {
      pass: errors.length === 0,
      message: errors.length === 0 ? 'All obligation nudge cases passed' : errors.join('\n'),
    };
  },
};
