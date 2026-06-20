/**
 * Regression: 2026-06-14 — Notice Delivery Integration Tests (INT-1 to INT-7)
 *
 * INT-1: Notice can be inserted and read back from DB ✅ runs now
 * INT-2: Critical notice → immediate delivery routing PENDING (needs tier column)
 * INT-3: Actionable notice → batched, not individual PENDING (needs tier column)
 * INT-4: Informational notice → pending_digest only PENDING (needs tier column + new delivery job)
 * INT-5: Current dedup behaviour documented ✅ runs now
 * INT-6: Morning digest queries notices table ✅ runs now
 * INT-7: Delivery attempts tracking PENDING (needs delivery_attempts column)
 */

const fs = require('fs');
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

    // INT-1: Notice can be inserted and read back
    try {
      const { initDB, getDB, saveNotice } = require('../../src/db');
      initDB();
      const ts = Date.now();
      const id = saveNotice({
        group_name:       'int-test-group',
        content:          'INT-1: test notice content — payment due',
        urgency_hint:     'immediate',
        delivery_status:  'pending',
        relevance_date:   '2026-06-20',
        relevance_time:   '09:00',
        source_timestamp: ts,
      });
      if (!id || typeof id !== 'number') {
        errors.push('INT-1: saveNotice did not return a numeric ID');
      } else {
        const row = getDB().prepare('SELECT * FROM notices WHERE id=?').get(id);
        if (!row) errors.push('INT-1: saved notice not found in DB');
        else {
          if (row.group_name !== 'int-test-group') errors.push('INT-1: group_name mismatch');
          if (row.content !== 'INT-1: test notice content — payment due') errors.push('INT-1: content mismatch');
          if (row.delivery_status !== 'pending') errors.push('INT-1: delivery_status not pending');
          if (row.relevance_date !== '2026-06-20') errors.push('INT-1: relevance_date mismatch');
        }
        getDB().prepare('DELETE FROM notices WHERE id=?').run(id);
      }
    } catch (e) {
      errors.push('INT-1: ' + e.message);
    }

    // INT-2: Critical → immediate delivery routing (PENDING)
    pending.push('INT-2: tier=critical → immediate delivery — requires tier column + new deliver-notices.js (Phase 1+3)');

    // INT-3: Actionable → batched delivery (PENDING)
    pending.push('INT-3: tier=actionable → batch window only — requires tier column + new deliver-notices.js (Phase 1+3)');

    // INT-4: Informational → digest only (PENDING)
    pending.push('INT-4: tier=informational → pending_digest status — requires tier column + new deliver-notices.js (Phase 1+3)');

    // INT-5: Current dedup behaviour — document what exists
    try {
      const noticeDeliveryPath = path.join(__dirname, '../../src/noticeDelivery.js');
      const agentPath = path.join(__dirname, '../../src/agent.js');

      if (!fs.existsSync(noticeDeliveryPath)) {
        errors.push('INT-5: noticeDelivery.js not found');
      } else {
        const src = fs.readFileSync(noticeDeliveryPath, 'utf8');
        // Document: current system does dedup at delivery (clustering) not at insert
        // This is intentional — new system will move dedup to extraction layer
        const hasCluster = src.includes('clusterNotices') || src.includes('cluster');
        if (!hasCluster) {
          errors.push('INT-5: expected clustering/dedup logic in noticeDelivery.js, not found');
        }
        // Verify: no unique constraint on notices table (insert-level dedup not implemented)
        const { initDB, getDB } = require('../../src/db');
        initDB();
        const indexes = getDB().prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='notices'").all();
        const hasContentUniqueIdx = indexes.some(i => i.sql && i.sql.toLowerCase().includes('unique') && i.sql.toLowerCase().includes('content'));
        if (hasContentUniqueIdx) {
          // If there IS a unique index, document it — this affects migration
          pending.push('INT-5b: NOTICE — unique index on content found, migration must handle this');
        }
        // PASS: current system clusters at delivery — expected behaviour pre-migration
      }
    } catch (e) {
      errors.push('INT-5: ' + e.message);
    }

    // INT-6: Morning digest queries notices table
    try {
      const queryNoticesPath = path.join(__dirname, '../../query-notices.js');
      if (!fs.existsSync(queryNoticesPath)) {
        errors.push('INT-6: query-notices.js not found at root');
      } else {
        const src = fs.readFileSync(queryNoticesPath, 'utf8');
        if (!src.includes('notices')) {
          errors.push('INT-6: query-notices.js does not reference notices table');
        }
        // Digest filters via getActiveNotices (dismissed=0 + date filter) — not delivery_status
        if (!src.includes('getActiveNotices') && !src.includes('dismissed')) {
          errors.push('INT-6: query-notices.js does not use getActiveNotices or filter by dismissed');
        }
        // Verify getActiveNotices in db.js returns content field
        const dbSrc = fs.readFileSync(path.join(__dirname, '../../src/db.js'), 'utf8');
        const getActiveIdx = dbSrc.indexOf('getActiveNotices');
        const getActiveBody = dbSrc.slice(getActiveIdx, getActiveIdx + 500);
        if (!getActiveBody.includes('content')) {
          errors.push('INT-6: getActiveNotices in db.js does not return content field');
        }
      }
    } catch (e) {
      errors.push('INT-6: ' + e.message);
    }

    // INT-7: Delivery attempts tracking (PENDING)
    pending.push('INT-7: delivery_attempts column + retry logic — requires Phase 1 schema migration');

    // Result
    if (errors.length > 0) {
      return { pass: false, message: `Failed:\n  ${errors.join('\n  ')}` };
    }

    const activeCount = 7 - pending.length;
    return {
      pass: true,
      message: `${activeCount} INT tests pass now, ${pending.length} PENDING:\n  ${pending.map(p => '⏳ ' + p).join('\n  ')}`,
    };
  },
};
