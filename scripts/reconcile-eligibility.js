#!/usr/bin/env node
'use strict';
/**
 * reconcile-eligibility.js — Read-only eligibility diff tool.
 *
 * Given a "proposed set" of notice IDs (from a write predicate like a SQL query
 * or a plain ID list), this script computes the ACTUAL eligible set using the
 * real getPendingNotices / getDeferredNotices / getImmediatePending functions
 * (with their JS-side staleness filtering via computeDeadline), then prints the
 * diff between the two sets.
 *
 * This catches the class of bugs where SQL COUNT says X rows match but the
 * JS eligibility filter (staleness, thread dismissal, send_attempted_at guard)
 * produces a different set.
 *
 * Usage:
 *   # Diff a SQL query against getPendingNotices:
 *   node scripts/reconcile-eligibility.js --queue pending \
 *     --sql "SELECT id FROM notices WHERE delivery_status='pending' AND dismissed=0"
 *
 *   # Diff against getDeferredNotices:
 *   node scripts/reconcile-eligibility.js --queue deferred \
 *     --sql "SELECT id FROM notices WHERE triage_decision='defer' AND dismissed=0"
 *
 *   # Diff against getImmediatePending:
 *   node scripts/reconcile-eligibility.js --queue immediate \
 *     --sql "SELECT id FROM notices WHERE urgency_hint='immediate' AND dismissed=0"
 *
 *   # Use an explicit ID list instead of SQL:
 *   node scripts/reconcile-eligibility.js --queue pending --ids 101,102,105
 *
 *   # Programmatic usage (require):
 *   const { reconcile } = require('./scripts/reconcile-eligibility');
 *   const diff = reconcile({ queue: 'pending', proposedIds: [101,102,105] });
 *   // diff = { match, onlyProposed, onlyEligible, proposed, eligible }
 *
 * Always read-only. Never modifies the DB.
 */

const { initDB, getDB } = require('../src/db');
const {
  getPendingNotices,
  getDeferredNotices,
  getImmediatePending,
  computeDeadline,
} = (() => {
  // We use the triage-engine versions — they are the authoritative eligibility filters.
  // getPendingNotices(db), getDeferredNotices(db), getImmediatePending(db) all take db.
  const te = require('../src/triage-engine');
  return {
    getPendingNotices: te.getPendingNotices,
    getDeferredNotices: te.getDeferredNotices,
    getImmediatePending: te.getImmediatePending,
    computeDeadline: te.computeDeadline,
  };
})();

// ── Core reconcile function (importable) ─────────────────────────────────────

/**
 * @param {Object} opts
 * @param {'pending'|'deferred'|'immediate'} opts.queue - Which eligibility function to use
 * @param {number[]} [opts.proposedIds] - Explicit ID list (mutually exclusive with sql)
 * @param {string} [opts.sql] - SQL query that returns rows with an `id` column
 * @returns {{ match: number[], onlyProposed: number[], onlyEligible: number[],
 *             proposed: Set<number>, eligible: Set<number>, details: Object[] }}
 */
function reconcile(opts) {
  const { queue, proposedIds, sql } = opts;

  initDB();
  const db = getDB();

  // 1. Get the real eligible set
  const queueFn = {
    pending: getPendingNotices,
    deferred: getDeferredNotices,
    immediate: getImmediatePending,
  }[queue];

  if (!queueFn) {
    throw new Error(`Unknown queue "${queue}". Use: pending, deferred, immediate`);
  }

  const eligibleRows = queueFn(db);
  const eligibleSet = new Set(eligibleRows.map(r => r.id));

  // 2. Get the proposed set
  let proposedSet;
  if (proposedIds) {
    proposedSet = new Set(proposedIds);
  } else if (sql) {
    const rows = db.prepare(sql).all();
    proposedSet = new Set(rows.map(r => r.id));
  } else {
    throw new Error('Provide either proposedIds or sql');
  }

  // 3. Compute diff
  const match = [];
  const onlyProposed = [];
  const onlyEligible = [];

  for (const id of proposedSet) {
    if (eligibleSet.has(id)) {
      match.push(id);
    } else {
      onlyProposed.push(id);
    }
  }
  for (const id of eligibleSet) {
    if (!proposedSet.has(id)) {
      onlyEligible.push(id);
    }
  }

  // 4. Build details for IDs only in the proposed set (why were they filtered out?)
  const details = [];
  if (onlyProposed.length > 0) {
    const now = new Date();
    const ph = onlyProposed.map(() => '?').join(',');
    const infoRows = db.prepare(`
      SELECT id, group_name, delivery_status, dismissed, posted_to_master,
             triage_decision, urgency_hint, relevance_date, relevance_time,
             relevant_datetime, send_attempted_at, created_at,
             thread_key
      FROM notices WHERE id IN (${ph})
    `).all(...onlyProposed);

    for (const r of infoRows) {
      const reasons = [];

      // Check each filter condition from the queue functions
      if (r.dismissed) reasons.push('dismissed=1');
      if (r.posted_to_master) reasons.push('posted_to_master=1');
      if (queue === 'pending' && r.triage_decision) reasons.push(`triage_decision=${r.triage_decision}`);
      if (queue === 'pending' && r.delivery_status !== 'pending') reasons.push(`delivery_status=${r.delivery_status}`);
      if (queue === 'deferred' && r.triage_decision !== 'defer') reasons.push(`triage_decision=${r.triage_decision} (need defer)`);
      if (queue === 'immediate' && !['immediate', 'time_sensitive'].includes(r.urgency_hint)) {
        reasons.push(`urgency_hint=${r.urgency_hint} (need immediate|time_sensitive)`);
      }

      // send_attempted_at guard
      if (r.send_attempted_at) {
        const claimed = new Date(r.send_attempted_at + 'Z');
        const fiveMinAgo = new Date(Date.now() - 5 * 60000);
        if (claimed > fiveMinAgo) reasons.push(`send_attempted_at=${r.send_attempted_at} (in-flight <5min)`);
      }

      // Thread dismissal
      if (r.thread_key) {
        const threadDismissed = db.prepare(
          'SELECT 1 FROM notice_threads WHERE thread_key=? AND dismissed=1'
        ).get(r.thread_key);
        if (threadDismissed) reasons.push(`thread_key=${r.thread_key} dismissed`);
      }

      // Staleness (computeDeadline)
      if (r.relevance_date) {
        const deadline = computeDeadline(r, now);
        if (deadline <= now) reasons.push(`stale: deadline=${deadline.toISOString()} < now`);
      }

      if (reasons.length === 0) reasons.push('unknown (not in LIMIT 50?)');

      details.push({ id: r.id, group: r.group_name, reasons });
    }
  }

  return {
    match: match.sort((a, b) => a - b),
    onlyProposed: onlyProposed.sort((a, b) => a - b),
    onlyEligible: onlyEligible.sort((a, b) => a - b),
    proposed: proposedSet,
    eligible: eligibleSet,
    details,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
  };

  const queue = getArg('--queue') || 'pending';
  const sql = getArg('--sql');
  const idsStr = getArg('--ids');

  if (!sql && !idsStr) {
    console.error('Usage: node scripts/reconcile-eligibility.js --queue <pending|deferred|immediate> --sql "..." | --ids 1,2,3');
    process.exit(1);
  }

  const proposedIds = idsStr ? idsStr.split(',').map(Number) : undefined;
  const result = reconcile({ queue, proposedIds, sql });

  console.log(`\n═══ Eligibility Reconciliation (queue: ${queue}) ═══`);
  console.log(`  Proposed: ${result.proposed.size} IDs`);
  console.log(`  Eligible: ${result.eligible.size} IDs`);
  console.log(`  Match:    ${result.match.length}`);

  if (result.onlyProposed.length === 0 && result.onlyEligible.length === 0) {
    console.log('\n  ✅ Sets are identical — no diff.\n');
    return;
  }

  if (result.onlyProposed.length > 0) {
    console.log(`\n  ⚠️  In proposed but NOT eligible (${result.onlyProposed.length}):`);
    for (const d of result.details) {
      console.log(`    #${d.id} [${d.group}] → ${d.reasons.join('; ')}`);
    }
  }

  if (result.onlyEligible.length > 0) {
    console.log(`\n  ⚠️  Eligible but NOT in proposed (${result.onlyEligible.length}):`);
    console.log(`    IDs: ${result.onlyEligible.join(', ')}`);
  }

  console.log('');
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = { reconcile, computeDeadline };

if (require.main === module) {
  main();
}
