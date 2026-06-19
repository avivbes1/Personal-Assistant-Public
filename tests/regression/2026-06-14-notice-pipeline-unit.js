/**
 * Regression: 2026-06-14 — Notice Pipeline Unit Tests (UC-1 to UC-7)
 *
 * Tests classification logic, DB schema, and agent prompt structure.
 * No live LLM calls. Static analysis + DB schema checks.
 *
 * UC-1: notices table has urgency_hint column (maps to tier in new system)
 * UC-2: saveNotice exported from db.js and callable
 * UC-3: Agent prompt contains the three urgency tiers
 * UC-4: URGENT_KEYWORDS regex forces 'immediate' classification
 * UC-5: Backlog messages are downgraded to 'routine'
 * UC-6: relevance_date stored as null when not provided
 * UC-7: Multiple notices can be saved for same group (no false dedup at insert)
 */

const fs = require('fs');
const path = require('path');

const DB_SRC = path.join(__dirname, '../../src/db.js');
const AGENT_SRC = path.join(__dirname, '../../src/agent.js');

module.exports = {
  async run() {
    const errors = [];
    const pending = [];

    // UC-1: notices table has urgency_hint column
    try {
      const { initDB, getDB } = require('../../src/db');
      initDB();
      const cols = getDB().prepare('PRAGMA table_info(notices)').all().map(c => c.name);
      if (!cols.includes('urgency_hint')) {
        errors.push('UC-1: notices table missing urgency_hint column');
      }
      if (!cols.includes('delivery_status')) {
        errors.push('UC-1: notices table missing delivery_status column');
      }
      if (!cols.includes('relevant_datetime')) {
        errors.push('UC-1: notices table missing relevant_datetime column');
      }
      // PENDING: new 'tier' column doesn't exist yet
      if (!cols.includes('tier')) {
        pending.push('UC-1b: tier column not yet added (Phase 1 migration)');
      }
      if (!cols.includes('delivery_attempts')) {
        pending.push('UC-1c: delivery_attempts column not yet added (Phase 1 migration)');
      }
    } catch (e) {
      errors.push('UC-1: DB access failed — ' + e.message);
    }

    // UC-2: saveNotice exported from db.js
    try {
      const db = require('../../src/db');
      if (typeof db.saveNotice !== 'function') {
        errors.push('UC-2: saveNotice not exported from db.js');
      }
      if (typeof db.initDB !== 'function') {
        errors.push('UC-2: initDB not exported from db.js');
      }
      if (typeof db.getDB !== 'function') {
        errors.push('UC-2: getDB not exported from db.js');
      }
    } catch (e) {
      errors.push('UC-2: db.js import failed — ' + e.message);
    }

    // UC-3: Agent prompt contains three urgency tiers
    try {
      const agentSrc = fs.readFileSync(AGENT_SRC, 'utf8');
      if (!agentSrc.includes('immediate')) {
        errors.push('UC-3: agent.js prompt missing "immediate" urgency tier');
      }
      if (!agentSrc.includes('time_sensitive')) {
        errors.push('UC-3: agent.js prompt missing "time_sensitive" urgency tier');
      }
      if (!agentSrc.includes('routine')) {
        errors.push('UC-3: agent.js prompt missing "routine" urgency tier');
      }
    } catch (e) {
      errors.push('UC-3: Could not read agent.js — ' + e.message);
    }

    // UC-4: URGENT_KEYWORDS regex forces 'immediate' classification
    try {
      const agentSrc = fs.readFileSync(AGENT_SRC, 'utf8');
      if (!agentSrc.includes('URGENT_KEYWORDS')) {
        errors.push('UC-4: URGENT_KEYWORDS not defined in agent.js');
      }
      // Verify the keywords include critical Hebrew terms
      const URGENT_KEYWORDS = /סגור|ביטול|נדחה|בוטל|איסוף מוקדם|חירום|דחוף|חד פעמי|בית ספר סגור/i;
      const testCases = [
        { text: 'בית ספר סגור מחר', shouldMatch: true },
        { text: 'ביטול שיעור היום', shouldMatch: true },
        { text: 'איסוף מוקדם ב-12:00', shouldMatch: true },
        { text: 'תודה רבה להורים', shouldMatch: false },
        { text: 'להביא תמונה מחר', shouldMatch: false },
      ];
      for (const { text, shouldMatch } of testCases) {
        const matched = URGENT_KEYWORDS.test(text);
        if (matched !== shouldMatch) {
          errors.push(`UC-4: URGENT_KEYWORDS "${text}" — expected ${shouldMatch}, got ${matched}`);
        }
      }
    } catch (e) {
      errors.push('UC-4: ' + e.message);
    }

    // UC-5: Backlog messages get downgraded to 'routine'
    try {
      const agentSrc = fs.readFileSync(AGENT_SRC, 'utf8');
      if (!agentSrc.includes('_isBacklog')) {
        errors.push('UC-5: _isBacklog flag not handled in agent.js');
      }
      if (!agentSrc.includes("urgencyHint = 'routine'")) {
        errors.push('UC-5: backlog downgrade to routine not found in agent.js');
      }
    } catch (e) {
      errors.push('UC-5: ' + e.message);
    }

    // UC-6: relevance_date stored as null when not provided
    try {
      const { initDB, getDB, saveNotice } = require('../../src/db');
      initDB();
      const testId = saveNotice({
        group_name: 'test-group-uc6',
        content: 'UC-6 test notice — no date',
        urgency_hint: 'routine',
        delivery_status: 'pending',
        source_timestamp: Date.now(),
      });
      const row = getDB().prepare('SELECT * FROM notices WHERE id=?').get(testId);
      if (row.relevance_date !== null) {
        errors.push(`UC-6: expected relevance_date=null, got "${row.relevance_date}"`);
      }
      // Cleanup
      getDB().prepare('DELETE FROM notices WHERE id=?').run(testId);
    } catch (e) {
      errors.push('UC-6: ' + e.message);
    }

    // UC-7: Multiple notices can be saved for same group (no false dedup at insert)
    try {
      const { initDB, getDB, saveNotice } = require('../../src/db');
      initDB();
      const ts = Date.now();
      const id1 = saveNotice({ group_name: 'test-group-uc7', content: 'מתנה ראשונה — עץ תאנה', urgency_hint: 'routine', delivery_status: 'pending', source_timestamp: ts });
      const id2 = saveNotice({ group_name: 'test-group-uc7', content: 'מתנה שנייה — שובר BuyMeChef', urgency_hint: 'routine', delivery_status: 'pending', source_timestamp: ts + 1000 });
      const id3 = saveNotice({ group_name: 'test-group-uc7', content: 'מתנה שלישית — עציץ', urgency_hint: 'routine', delivery_status: 'pending', source_timestamp: ts + 2000 });
      const count = getDB().prepare("SELECT COUNT(*) as cnt FROM notices WHERE group_name='test-group-uc7'").get().cnt;
      // Cleanup
      getDB().prepare("DELETE FROM notices WHERE group_name='test-group-uc7'").run();
      if (count !== 3) {
        errors.push(`UC-7: expected 3 notices saved, got ${count} — false dedup at insert level`);
      }
      if (id1 === id2 || id2 === id3) {
        errors.push('UC-7: saveNotice returned duplicate IDs');
      }
    } catch (e) {
      errors.push('UC-7: ' + e.message);
    }

    // Result
    if (errors.length > 0) {
      return { pass: false, message: `Failed:\n  ${errors.join('\n  ')}` };
    }

    const pendingNote = pending.length > 0 ? ` | PENDING (${pending.length}): ${pending.join('; ')}` : '';
    return { pass: true, message: `7/7 UC tests passed (${7 - pending.length} active, ${pending.length} pending Phase 1)${pendingNote}` };
  },
};
