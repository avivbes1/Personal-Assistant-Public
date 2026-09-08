#!/usr/bin/env node
'use strict';

/**
 * check-principles.js — Static checks that architectural principles hold.
 *
 * P-015 / H1: Calendar writes occur only via calendarGate or POST /api/calendar/propose.
 *   No file outside the sanctioned set may import addSharedEvent.
 *   updateCalendarEvent is allowed in a broader set (updates/corrections).
 *
 * Run: node scripts/check-principles.js
 * CI: exits 1 on any violation.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

// Files allowed to import addSharedEvent (creates events) from calendar.js
const SANCTIONED_CREATE_IMPORTERS = new Set([
  'calendar.js',         // defines it
  'calendarGate.js',     // stage-4 executor
  'calendar-bridge.js',  // afterDeliveryHook
  'voice-server.js',     // /api/calendar/propose endpoint
  'whatsapp.js',         // user-confirmed add in master group
]);

// Files additionally allowed to use updateCalendarEvent (patches, not creates)
const SANCTIONED_UPDATE_IMPORTERS = new Set([
  ...SANCTIONED_CREATE_IMPORTERS,
  'agent.js',       // update_event action from group messages
  'proactive.js',   // resolveMissingTime correction path
]);

const CALENDAR_IMPORT_RE = /require\(['"]\.\/calendar['"]\)|from\s+['"]\.\/calendar['"]/;
// Match actual code usage, not just mentions in comments
// Look for: destructuring import, function call, or assignment
const ADD_EVENT_RE = /\baddSharedEvent\s*[(:,}]|\{[^}]*addSharedEvent/;
const UPDATE_EVENT_RE = /\bupdateCalendarEvent\s*[(:,}]|\{[^}]*updateCalendarEvent/;

let violations = 0;

function walkDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'test' || entry.name === 'tests') continue;
      walkDir(full);
    } else if (entry.name.endsWith('.js')) {
      const basename = entry.name;
      const content = fs.readFileSync(full, 'utf8');

      if (!CALENDAR_IMPORT_RE.test(content)) continue;

      // Strict: addSharedEvent — only sanctioned create importers
      if (ADD_EVENT_RE.test(content) && !SANCTIONED_CREATE_IMPORTERS.has(basename)) {
        console.error(`P-015 VIOLATION: ${path.relative(SRC, full)} imports addSharedEvent — route through calendarGate`);
        violations++;
      }

      // Soft: updateCalendarEvent — broader set allowed
      if (UPDATE_EVENT_RE.test(content) && !SANCTIONED_UPDATE_IMPORTERS.has(basename)) {
        console.error(`P-015 VIOLATION: ${path.relative(SRC, full)} imports updateCalendarEvent outside sanctioned set`);
        violations++;
      }
    }
  }
}

walkDir(SRC);

if (violations > 0) {
  console.error(`\n${violations} principle violation(s) found.`);
  process.exit(1);
} else {
  console.log('All principle checks passed.');
  process.exit(0);
}
