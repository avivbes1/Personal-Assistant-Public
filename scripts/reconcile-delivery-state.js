#!/usr/bin/env node
'use strict';
/**
 * reconcile-delivery-state.js — K6: find and fix delivery state inconsistencies.
 *
 * Two classes of stuck rows:
 *   1. Notices with delivery_status IN ('delivered_batch','delivered_immediate')
 *      but posted_to_master=0. These clog the triage queue (LIMIT 50 starvation).
 *   2. Notices with delivery_status='pending' past their relevance_date with no
 *      triage_decision. These are dead-letter candidates.
 *
 * Default: report only. Pass --apply to fix.
 */

const { initDB, getDB } = require('../src/db');
const { israelDateIso } = require('../src/timeUtils');

const apply = process.argv.includes('--apply');

initDB();
const db = getDB();
const today = israelDateIso();

// Class 1: delivered but posted_to_master=0
const delivered = db.prepare(`
  SELECT id, delivery_status, group_name FROM notices
  WHERE delivery_status IN ('delivered_batch','delivered_immediate')
    AND posted_to_master = 0
`).all();
console.log(`[reconcile] Delivered but posted_to_master=0: ${delivered.length}`);
if (delivered.length > 0 && apply) {
  const ids = delivered.map(r => r.id);
  const ph = ids.map(() => '?').join(',');
  db.prepare(`UPDATE notices SET posted_to_master = 1 WHERE id IN (${ph})`).run(...ids);
  console.log(`[reconcile] Fixed ${ids.length} rows → posted_to_master=1`);
}

// Class 2: stale pending with no triage
const stale = db.prepare(`
  SELECT id, relevance_date, group_name FROM notices
  WHERE delivery_status = 'pending' AND dismissed = 0
    AND triage_decision IS NULL
    AND relevance_date IS NOT NULL AND relevance_date < ?
`).all(today);
console.log(`[reconcile] Stale pending (past relevance_date, no triage): ${stale.length}`);
if (stale.length > 0 && apply) {
  const ids = stale.map(r => r.id);
  const ph = ids.map(() => '?').join(',');
  db.prepare(`UPDATE notices SET delivery_status = 'dead_letter', triage_decision = 'skip',
    triage_reason = 'stale — reconcile-delivery-state.js' WHERE id IN (${ph})`).run(...ids);
  console.log(`[reconcile] Marked ${ids.length} rows → dead_letter`);
}

// Summary
const totalPending = db.prepare("SELECT COUNT(*) as cnt FROM notices WHERE delivery_status='pending' AND dismissed=0").get();
console.log(`[reconcile] Remaining pending: ${totalPending.cnt}`);

if (!apply && (delivered.length > 0 || stale.length > 0)) {
  console.log('[reconcile] Dry run — pass --apply to fix');
}
