/**
 * Regression: 2026-08-31 — B1 collapse the two delivery paths (P-012).
 *
 * WORKPLAN-V4 B1: two independent readers of the notices queue (triage 15-min and
 * noticeDelivery via deliver-batch 07/12/16/20) both sent to the master group,
 * the batch path bypassing every guardrail. The fix: triage-engine.js is the
 * SINGLE queue reader/sender; noticeDelivery.js is a pure formatter; the
 * launchers delegate to triage via TRIAGE_MODE.
 *
 * These checks pin the collapse so a future change can't quietly re-open a
 * second sender. Pure in-memory / source checks — no live DB, no network, no
 * dependency on lib/voice-client (which ships only on the prod box).
 */

'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');

module.exports = {
  async run() {
    const errors = [];

    // ── 1. noticeDelivery.deliverBatch is a PURE FORMATTER ────────────────────
    let nd;
    try {
      nd = require('../../src/noticeDelivery');
    } catch (e) {
      return { pass: false, message: 'could not require noticeDelivery.js: ' + e.message };
    }

    const notices = [
      { id: 1, group_name: 'כיתה א', content: 'תשלום 50 שח', source_timestamp: 1000, relevance_time: '09:00', relevance_date: '2999-01-01' },
      { id: 2, group_name: 'כיתה ב', content: 'טיול', source_timestamp: 2000, relevance_date: '2999-01-01' },
    ];
    const digest = await nd.deliverBatch(notices);
    if (!digest || typeof digest.body !== 'string') {
      errors.push('deliverBatch(notices) must return { body, ids, clusterCount }');
    } else {
      if (!digest.body.includes('כיתה א')) errors.push('digest body missing group name');
      if (JSON.stringify(digest.ids) !== JSON.stringify([1, 2])) errors.push('digest ids wrong: ' + JSON.stringify(digest.ids));
    }
    // Passing a sendFn (old signature) must NOT send — a function is not an array,
    // so the formatter returns null. Proves deliverBatch can no longer deliver.
    let sendSpyCalled = false;
    const spy = () => { sendSpyCalled = true; };
    const bogus = await nd.deliverBatch(spy);
    if (bogus !== null || sendSpyCalled) {
      errors.push('deliverBatch(sendFn) must be a no-op formatter (null, never sends)');
    }

    // ── 2. deliverImmediate is a PURE FORMATTER (returns text) ─────────────────
    const immText = nd.deliverImmediate(notices[0]);
    if (typeof immText !== 'string' || !immText.includes('כיתה א')) {
      errors.push('deliverImmediate(notice) must return the formatted string');
    }

    // ── 3. selectImmediate picks urgent + near time_sensitive only ────────────
    const sel = nd.selectImmediate([
      { id: 1, urgency_hint: 'immediate' },
      { id: 2, urgency_hint: 'time_sensitive', relevant_datetime: Date.now() + 3600000 },     // within 3h
      { id: 3, urgency_hint: 'time_sensitive', relevant_datetime: Date.now() + 30 * 3600000 }, // far future
      { id: 4, urgency_hint: 'routine' },
    ]).map(n => n.id);
    if (JSON.stringify(sel) !== JSON.stringify([1, 2])) {
      errors.push('selectImmediate wrong selection: ' + JSON.stringify(sel));
    }

    // ── 4. P-009 cluster gate is opt-in and rejects all-FYI batches ───────────
    const undated = [{ id: 9, group_name: 'g', content: 'chit chat', source_timestamp: 1 }];
    if ((await nd.deliverBatch(undated)) === null) {
      errors.push('deliverBatch default (gate off) should format an undated batch');
    }
    if ((await nd.deliverBatch(undated, { requireActionable: true })) !== null) {
      errors.push('deliverBatch requireActionable:true should reject an all-FYI/undated batch (cluster gate)');
    }

    // ── 5. triage owns the queue read: getDeferredNotices / getImmediatePending ─
    let t;
    try {
      t = require('../../src/triage-engine');
    } catch (e) {
      errors.push('could not require triage-engine.js (resilient voiceSend should let it load): ' + e.message);
    }
    if (t && typeof t.getDeferredNotices === 'function' && typeof t.getImmediatePending === 'function') {
      const db = new Database(':memory:');
      db.exec(`CREATE TABLE notices (id INTEGER PRIMARY KEY, group_name TEXT, content TEXT,
        urgency_hint TEXT, triage_decision TEXT, dismissed INTEGER DEFAULT 0, posted_to_master INTEGER DEFAULT 0,
        delivery_status TEXT DEFAULT 'pending', relevance_date TEXT, relevance_time TEXT,
        relevant_datetime INTEGER, send_attempted_at TEXT, created_at INTEGER)`);
      const ins = db.prepare(`INSERT INTO notices
        (id,group_name,content,urgency_hint,triage_decision,dismissed,posted_to_master,delivery_status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      ins.run(1, 'g', 'defer-eligible', 'routine', 'defer', 0, 0, 'pending', 1);
      ins.run(2, 'g', 'already-delivered', 'routine', 'defer', 0, 1, 'delivered_batch', 2);
      ins.run(3, 'g', 'skipped', 'routine', 'skip', 0, 1, 'skipped', 3);
      ins.run(4, 'g', 'untriaged', 'routine', null, 0, 0, 'pending', 4);
      ins.run(5, 'g', 'dismissed', 'routine', 'defer', 1, 0, 'pending', 5);
      ins.run(10, 'g', 'urgent', 'immediate', null, 0, 0, 'pending', 10);
      ins.run(11, 'g', 'urgent-triaged', 'immediate', 'send_now', 0, 0, 'pending', 11);
      ins.run(12, 'g', 'urgent-posted', 'immediate', null, 0, 1, 'delivered_immediate', 12);

      const def = t.getDeferredNotices(db).map(n => n.id);
      if (JSON.stringify(def) !== JSON.stringify([1])) {
        errors.push('getDeferredNotices should drain only defer+undelivered+undismissed+unposted; got ' + JSON.stringify(def));
      }
      const imm = t.getImmediatePending(db).map(n => n.id);
      if (JSON.stringify(imm) !== JSON.stringify([10])) {
        errors.push('getImmediatePending should read only urgent+untriaged+unposted; got ' + JSON.stringify(imm));
      }
    }

    // ── 6. P-012 principle is documented ──────────────────────────────────────
    const principles = fs.readFileSync(path.join(ROOT, 'PRINCIPLES.md'), 'utf8');
    if (!/## P-012 — Exactly One Sender for the Master Group/.test(principles)) {
      errors.push('PRINCIPLES.md missing the P-012 section');
    }

    // ── 7. Launchers delegate to triage; never send directly ──────────────────
    for (const f of ['deliver-batch.js', 'deliver-immediate.js']) {
      const p = path.join(ROOT, f);
      if (!fs.existsSync(p)) { errors.push(`${f} missing`); continue; }
      const raw = fs.readFileSync(p, 'utf8');
      if (!raw.includes('TRIAGE_MODE')) errors.push(`${f} must set TRIAGE_MODE to delegate to triage`);
      // strip comments, then ensure no real voiceSend(...) call
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      if (/\bvoiceSend\s*\(/.test(code)) errors.push(`${f} must not call voiceSend (P-012)`);
      if (/require\(['"](?:\.\/)?(?:src\/)?whatsapp(?:-web\.js)?['"]\)/.test(code)) {
        errors.push(`${f} must not import the WhatsApp client (REG-3 timeout budget)`);
      }
    }

    // ── 8. Exactly one queue reader that sends (the workplan's B1 grep) ────────
    try {
      const out = execFileSync('bash', ['-c',
        `grep -rln "posted_to_master\\|delivery_status = 'pending'" --include=*.js src/ | xargs grep -ln "voiceSend\\|sendToMasterGroup" | sort`
      ], { cwd: ROOT }).toString().trim();
      // whatsapp.js legitimately marks dismissals + sends interactive replies but
      // does NOT SELECT the queue; the coarse grep still lists it, so accept the
      // set {triage-engine.js} ∪ {whatsapp.js interactive handler} but require
      // triage-engine.js to be the queue-delivery sender and no OTHER deliverer.
      const files = out.split('\n').filter(Boolean).map(s => s.replace(/^src\//, ''));
      const deliverers = files.filter(f => f !== 'whatsapp.js');
      if (JSON.stringify(deliverers) !== JSON.stringify(['triage-engine.js'])) {
        errors.push('expected triage-engine.js to be the only notices-queue sender; grep found: ' + JSON.stringify(files));
      }
    } catch (e) {
      errors.push('B1 grep failed: ' + e.message);
    }

    // Note: the P-012 checks in tests/check-principles.js are exercised by that
    // script directly; this regression intentionally does NOT run the whole
    // checker, so an unrelated in-flight principle (e.g. a concurrent B7 P-013
    // change) can't make the B1 regression flap.

    if (errors.length > 0) {
      return { pass: false, message: 'Failed:\n  ' + errors.join('\n  ') };
    }
    return {
      pass: true,
      message: 'B1: single sender (triage); noticeDelivery is a pure formatter; launchers delegate via TRIAGE_MODE; P-012 enforced',
    };
  },
};
