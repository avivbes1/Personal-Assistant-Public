/**
 * Regression: 2026-06-14 — Notice Pipeline Regression Tests (REG-1 to REG-4)
 *
 * REG-1: Full lifecycle structural check ✅ runs now
 * REG-2: Memory under load PENDING (can't test without disrupting live bot)
 * REG-3: Delivery job doesn't import whatsapp-web.js (timeout compliance) ✅ runs now
 * REG-4: Morning digest format unchanged ✅ runs now
 */

const fs   = require('fs');
const path = require('path');

module.exports = {
  async run() {
    // Skip in CI if root-level operational scripts don't exist (public repo excludes them)
    const fs2 = require('fs'), path2 = require('path');
    if (!fs2.existsSync(path2.join(__dirname, '../../deliver-immediate.js'))) {
      return { pass: true, message: 'Skipped — operational scripts not present (public repo build)' };
    }
    const errors = [];
    const pending = [];

    // REG-1: Full lifecycle structural check
    // Verifies: handleGroupEvent → saveNotice → noticeDelivery pipeline all exist and are wired
    try {
      // handleGroupEvent exported from agent.js
      const agent = require('../../src/agent');
      if (typeof agent.handleGroupEvent !== 'function') {
        errors.push('REG-1: handleGroupEvent not exported from agent.js');
      }

      // saveNotice exported from db.js
      const db = require('../../src/db');
      if (typeof db.saveNotice !== 'function') {
        errors.push('REG-1: saveNotice not exported from db.js');
      }

      // noticeDelivery.js exports deliverImmediate + deliverBatch
      const nd = require('../../src/noticeDelivery');
      if (typeof nd.deliverImmediate !== 'function') {
        errors.push('REG-1: deliverImmediate not exported from noticeDelivery.js');
      }
      if (typeof nd.deliverBatch !== 'function') {
        errors.push('REG-1: deliverBatch not exported from noticeDelivery.js');
      }

      // deliver-immediate.js entry point exists
      if (!fs.existsSync(path.join(__dirname, '../../deliver-immediate.js'))) {
        errors.push('REG-1: deliver-immediate.js entry point missing');
      }
      if (!fs.existsSync(path.join(__dirname, '../../deliver-batch.js'))) {
        errors.push('REG-1: deliver-batch.js entry point missing');
      }

      // handleGroupEvent calls saveNotice (agent.js references add_notice action)
      const agentSrc = fs.readFileSync(path.join(__dirname, '../../src/agent.js'), 'utf8');
      if (!agentSrc.includes('add_notice') || !agentSrc.includes('saveNotice')) {
        errors.push('REG-1: agent.js does not wire add_notice → saveNotice');
      }
    } catch (e) {
      errors.push('REG-1: ' + e.message);
    }

    // REG-2: Memory under load (PENDING — can't run without disrupting live bot)
    pending.push('REG-2: Memory baseline (50 messages < 1.5GB) — requires isolated test environment, not safe on live t4g.small');

    // REG-3: Delivery scripts don't import whatsapp-web.js
    // This ensures they can start fast and complete within cron timeout
    try {
      const deliverImmSrc = fs.readFileSync(path.join(__dirname, '../../deliver-immediate.js'), 'utf8');
      const deliverBatchSrc = fs.readFileSync(path.join(__dirname, '../../deliver-batch.js'), 'utf8');

      if (deliverImmSrc.includes("require('whatsapp-web.js')") || deliverImmSrc.includes('require("whatsapp-web.js")')) {
        errors.push('REG-3: deliver-immediate.js imports whatsapp-web.js — will cause timeout');
      }
      if (deliverBatchSrc.includes("require('whatsapp-web.js')") || deliverBatchSrc.includes('require("whatsapp-web.js")')) {
        errors.push('REG-3: deliver-batch.js imports whatsapp-web.js — will cause timeout');
      }

      // Also check they don't import whatsapp.js (which loads the WA client)
      if (deliverImmSrc.includes("require('./src/whatsapp')") || deliverImmSrc.includes("require('./whatsapp')")) {
        errors.push('REG-3: deliver-immediate.js imports whatsapp.js (heavy dep) — will cause timeout/OOM');
      }
      if (deliverBatchSrc.includes("require('./src/whatsapp')") || deliverBatchSrc.includes("require('./whatsapp')")) {
        errors.push('REG-3: deliver-batch.js imports whatsapp.js (heavy dep) — will cause timeout/OOM');
      }

      // New delivery job (Phase 3) — PENDING until created
      const newDeliveryPath = path.join(__dirname, '../../src/jobs/deliver-notices.js');
      if (!fs.existsSync(newDeliveryPath)) {
        pending.push('REG-3b: src/jobs/deliver-notices.js not yet created (Phase 3)');
      } else {
        const newSrc = fs.readFileSync(newDeliveryPath, 'utf8');
        if (newSrc.includes("require('whatsapp-web.js')")) {
          errors.push('REG-3b: src/jobs/deliver-notices.js imports whatsapp-web.js — violates timeout budget');
        }
      }
    } catch (e) {
      errors.push('REG-3: ' + e.message);
    }

    // REG-4: Morning digest format unchanged
    // Checks query-notices.js and morning digest cron still reference correct table + fields
    try {
      const queryPath = path.join(__dirname, '../../query-notices.js');
      if (!fs.existsSync(queryPath)) {
        errors.push('REG-4: query-notices.js missing — morning digest will break');
      } else {
        const src = fs.readFileSync(queryPath, 'utf8');
        // Must reference notices table
        if (!src.includes('notices')) {
          errors.push('REG-4: query-notices.js does not query notices table');
        }
        // Content field is returned via getActiveNotices in db.js — check there
        const dbSrc = fs.readFileSync(path.join(__dirname, '../../src/db.js'), 'utf8');
        const getActiveIdx = dbSrc.indexOf('getActiveNotices');
        const fnBody = dbSrc.slice(getActiveIdx, getActiveIdx + 500);
        if (!fnBody.includes('content')) {
          errors.push('REG-4: getActiveNotices in db.js does not return content field — morning digest will lose notice content');
        }
      }

      // New extraction job (Phase 2) — PENDING until created
      const extractPath = path.join(__dirname, '../../src/jobs/extract-notices.js');
      if (!fs.existsSync(extractPath)) {
        pending.push('REG-4b: src/jobs/extract-notices.js not yet created (Phase 2)');
      }

      // message_buffer table — PENDING until Phase 1
      const { initDB, getDB } = require('../../src/db');
      initDB();
      const bufferTable = getDB().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_buffer'").get();
      if (!bufferTable) {
        pending.push('REG-4c: message_buffer table not yet created (Phase 1)');
      }
    } catch (e) {
      errors.push('REG-4: ' + e.message);
    }

    // Result
    if (errors.length > 0) {
      return { pass: false, message: `Failed:\n  ${errors.join('\n  ')}` };
    }

    const activeCount = 4 - 1; // REG-2 always pending
    return {
      pass: true,
      message: `${activeCount} REG tests pass now, ${pending.length} PENDING:\n  ${pending.map(p => '⏳ ' + p).join('\n  ')}`,
    };
  },
};
