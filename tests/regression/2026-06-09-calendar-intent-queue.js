const path = require('path');
/**
 * Regression: 2026-06-09
 * Incident: Three calendar failures:
 *   1. "Instead of" intent not recognized → addEvent instead of updateEvent → duplicate events
 *   2. Cron scanner created event with wrong time (16:00 instead of 17:30) due to no time-slot dedup
 *   3. Agent confirmed "נוסף ✅" before verifying API result
 *
 * Fixes:
 *   - calendar_intents table added for cross-source dedup (Step 6)
 *   - addSharedEvent now logs intents and warns on cross-source conflicts (Steps 3, 6)
 *   - agent.js system prompt: "במקום" → update_event, not add_event (Step 4)
 *   - handleMessage: overrides LLM confirmation if action failed (Step 5)
 *   - handleGroupEvent: "שינוי לאירוע קיים" → add_notice only, not add_event (Step 4)
 *
 * This test verifies:
 * 1. calendar_intents table exists in DB
 * 2. logCalendarIntent / findPendingIntentsForDate / updateCalendarIntentStatus are exported from db.js
 * 3. agent.js system prompt contains "במקום" → update_event instruction
 * 4. agent.js system prompt contains confirmation-after-result warning
 * 5. handleGroupEvent prompt contains "שינוי לאירוע קיים" guard
 */

const { initDB, getDB, logCalendarIntent, findPendingIntentsForDate, updateCalendarIntentStatus } = require('../../src/db');
const fs = require('fs');

module.exports = {
  async run() {
    const errors = [];

    // Test 1: DB functions exported and table exists
    try {
      initDB();
      if (typeof logCalendarIntent !== 'function') errors.push('logCalendarIntent not exported from db.js');
      if (typeof findPendingIntentsForDate !== 'function') errors.push('findPendingIntentsForDate not exported from db.js');
      if (typeof updateCalendarIntentStatus !== 'function') errors.push('updateCalendarIntentStatus not exported from db.js');

      // Verify table was created
      const tableExists = getDB().prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='calendar_intents'"
      ).get();
      if (!tableExists) errors.push('calendar_intents table not found in DB');
    } catch (e) {
      errors.push('DB init / function check failed: ' + e.message);
    }

    // Test 2: Round-trip intent logging
    try {
      initDB();
      const id = logCalendarIntent({
        source: 'test',
        event_title: 'טסט אירוע',
        event_date: '2026-06-09',
        event_start: '2026-06-09T17:30:00+03:00',
        event_end:   '2026-06-09T19:00:00+03:00',
        raw_message: 'unit test',
      });
      if (!id) errors.push('logCalendarIntent returned falsy id');

      const intents = findPendingIntentsForDate('2026-06-09');
      const found = intents.find(i => i.id === id);
      if (!found) errors.push('findPendingIntentsForDate did not return the newly logged intent');

      updateCalendarIntentStatus(id, 'applied', 'fake-gcal-id-123');
      const afterUpdate = findPendingIntentsForDate('2026-06-09');
      const stillPending = afterUpdate.find(i => i.id === id);
      if (stillPending) errors.push('updateCalendarIntentStatus did not change status from pending');
    } catch (e) {
      errors.push('Intent queue round-trip failed: ' + e.message);
    }

    // Test 3: agent.js system prompt has "במקום" → update_event instruction
    try {
      const agentContent = fs.readFileSync(path.join(__dirname, '../../src/agent.js'), 'utf8');
      if (!agentContent.includes('במקום') || !agentContent.includes('update_event')) {
        errors.push('agent.js buildSystemPrompt missing "במקום" → update_event instruction');
      }
    } catch (e) {
      errors.push('Could not read agent.js: ' + e.message);
    }

    // Test 4: agent.js handleMessage overrides confirmation on failure
    try {
      const agentContent = fs.readFileSync(path.join(__dirname, '../../src/agent.js'), 'utf8');
      if (!agentContent.includes('failedActions')) {
        errors.push('agent.js handleMessage missing failedActions override (Step 5)');
      }
    } catch (e) {
      errors.push('Could not read agent.js for Step 5 check: ' + e.message);
    }

    // Test 5: handleGroupEvent has guard for "שינוי לאירוע קיים"
    try {
      const agentContent = fs.readFileSync(path.join(__dirname, '../../src/agent.js'), 'utf8');
      if (!agentContent.includes('שינוי לאירוע קיים')) {
        errors.push('handleGroupEvent missing "שינוי לאירוע קיים" guard (Step 4)');
      }
    } catch (e) {
      errors.push('Could not check handleGroupEvent guard: ' + e.message);
    }

    if (errors.length > 0) return { pass: false, message: errors.join('; ') };
    return { pass: true, message: 'Calendar intent queue + agent prompt guards all verified' };
  },
};
