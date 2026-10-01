#!/usr/bin/env node
'use strict';
/**
 * lipa-audit-usage.js — DB-side cost/usage reconciliation for the Lipa Bridge.
 *
 * Reads bridge_lipa_costs + bridge_lipa_attempts from the production DB and
 * produces a human-readable + machine-readable report of:
 *   - Known spend vs unknown spend per inbox_id
 *   - Total known lower-bound spend
 *   - Count of rows with unknown cost (model=null, cost_unknown=1)
 *   - Attempt history summary
 *
 * IMPORTANT: This reports DB-side accounting ONLY. Provider-side reconciliation
 * requires manual check at console.anthropic.com. Any gap between DB totals and
 * provider billing is UNKNOWN and must be investigated manually.
 *
 * The launch/outcome state records were wiped during the 2026-09-30 incident.
 * That usage is permanently UNKNOWN from the DB's perspective.
 *
 * Usage:
 *   node scripts/lipa-audit-usage.js              # human-readable report
 *   node scripts/lipa-audit-usage.js --json        # machine-readable JSON
 *   node scripts/lipa-audit-usage.js --json --pretty  # pretty-printed JSON
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// READ-ONLY by design: the audit must never write to — or migrate — the
// production DB. initDB() would open read-write and run CREATE/ALTER/backfill
// statements, so we open the file directly in readonly mode instead. Honors
// FAMILYBOT_DB_PATH (as everywhere else) but defaults to the production DB.
const DB_PATH = process.env.FAMILYBOT_DB_PATH || path.join(__dirname, '..', 'data', 'family.db');
if (!fs.existsSync(DB_PATH)) {
  console.error('[lipa-audit] DB not found at ' + DB_PATH);
  process.exit(1);
}
let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (e) {
  console.error('[lipa-audit] cannot open DB read-only: ' + e.message);
  process.exit(1);
}

const jsonMode = process.argv.includes('--json');
const pretty = process.argv.includes('--pretty');

// ── Cost ledger ──────────────────────────────────────────────────────────────

const costs = db.prepare('SELECT * FROM bridge_lipa_costs ORDER BY inbox_id, recorded_at').all();
const costsByInbox = new Map();

for (const c of costs) {
  const key = c.inbox_id == null ? '__run_level__' : c.inbox_id;
  if (!costsByInbox.has(key)) costsByInbox.set(key, []);
  costsByInbox.get(key).push(c);
}

let totalKnownSpend = 0;
let totalUnknownRows = 0;
let totalRows = costs.length;
const inboxReports = [];

for (const [inboxId, rows] of costsByInbox) {
  let knownCost = 0;
  let unknownCount = 0;
  const details = [];

  for (const r of rows) {
    const isUnknown = r.cost_unknown === 1 || r.cost_usd_lower_bound == null;
    if (isUnknown) {
      unknownCount++;
      totalUnknownRows++;
    } else {
      knownCost += r.cost_usd_lower_bound;
      totalKnownSpend += r.cost_usd_lower_bound;
    }
    details.push({
      id: r.id,
      model: r.model || 'UNKNOWN',
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_read_tokens: r.cache_read_tokens,
      cache_write_tokens: r.cache_write_tokens,
      cost_usd: isUnknown ? 'UNKNOWN' : r.cost_usd_lower_bound,
      cost_unknown: isUnknown,
      source_key: r.source_key || null,
      date_jerusalem: r.date_jerusalem,
    });
  }

  inboxReports.push({
    inbox_id: inboxId === '__run_level__' ? null : inboxId,
    label: inboxId === '__run_level__' ? 'run-level (no inbox_id)' : `inbox ${inboxId}`,
    known_cost_usd: knownCost,
    unknown_rows: unknownCount,
    total_rows: rows.length,
    details,
  });
}

// ── Attempt history ──────────────────────────────────────────────────────────

const attempts = db.prepare(
  'SELECT event, outcome, COUNT(*) as count FROM bridge_lipa_attempts GROUP BY event, outcome ORDER BY event, outcome'
).all();

const attemptsByInbox = db.prepare(
  `SELECT inbox_id, event, outcome, COUNT(*) as count
   FROM bridge_lipa_attempts GROUP BY inbox_id, event, outcome ORDER BY inbox_id, event`
).all();

// Sessions with token data
const sessionsWithTokens = db.prepare(
  `SELECT DISTINCT session_id, inbox_id,
          SUM(input_tokens) as total_input, SUM(output_tokens) as total_output,
          SUM(cache_read_tokens) as total_cache_read, SUM(cache_write_tokens) as total_cache_write
   FROM bridge_lipa_attempts
   WHERE input_tokens IS NOT NULL OR output_tokens IS NOT NULL
   GROUP BY session_id, inbox_id`
).all();

// ── Wiped state assessment ───────────────────────────────────────────────────

const launchOutcome = db.prepare(
  "SELECT COUNT(*) as c FROM bridge_lipa_state WHERE key LIKE 'launch_%' OR key LIKE 'outcome_%'"
).get();

// ── Build report ─────────────────────────────────────────────────────────────

const report = {
  generated_at: new Date().toISOString(),
  summary: {
    total_cost_rows: totalRows,
    known_spend_usd: Math.round(totalKnownSpend * 10000) / 10000,
    unknown_rows: totalUnknownRows,
    known_rows: totalRows - totalUnknownRows,
    launch_outcome_records: launchOutcome.c,
    launch_outcome_note: launchOutcome.c === 0
      ? 'WIPED during 2026-09-30 incident. Pre-wipe usage is permanently UNKNOWN from DB perspective.'
      : `${launchOutcome.c} records present`,
    provider_reconciliation: 'REQUIRED — check console.anthropic.com for actual spend. DB totals are lower-bound estimates only.',
  },
  cost_by_inbox: inboxReports,
  attempt_summary: attempts,
  sessions_with_tokens: sessionsWithTokens,
  incident_note: 'The 2026-09-30 test-pollution incident wiped launch/outcome records and control-plane state. '
    + 'Any spend from the 15 real CLI sessions (~$0.77 estimated in v9 audit) is NOT in the cost ledger '
    + 'because those sessions predated the cost-recording code. That usage is UNKNOWN in the DB; '
    + 'provider billing is the only source of truth for pre-v5 sessions.',
};

if (jsonMode) {
  console.log(pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report));
} else {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' LIPA BRIDGE — DB-Side Usage Audit');
  console.log(' Generated:', report.generated_at);
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('SUMMARY:');
  console.log('  Cost ledger rows:      ', report.summary.total_cost_rows);
  console.log('  Known spend (lower $):  $' + report.summary.known_spend_usd.toFixed(4));
  console.log('  Unknown-cost rows:     ', report.summary.unknown_rows);
  console.log('  Known-cost rows:       ', report.summary.known_rows);
  console.log('  Launch/outcome records:', report.summary.launch_outcome_records, launchOutcome.c === 0 ? '(WIPED)' : '');
  console.log('');

  console.log('⚠️  PROVIDER RECONCILIATION REQUIRED');
  console.log('   DB totals are lower-bound estimates. Check console.anthropic.com');
  console.log('   for actual spend. Any gap is UNKNOWN.\n');

  console.log('COST BY INBOX:');
  for (const ir of inboxReports) {
    console.log(`  ${ir.label}: $${ir.known_cost_usd.toFixed(4)} known, ${ir.unknown_rows} unknown rows (${ir.total_rows} total)`);
  }
  console.log('');

  console.log('ATTEMPT SUMMARY:');
  for (const a of attempts) {
    console.log(`  ${a.event} / ${a.outcome}: ${a.count}`);
  }
  console.log('');

  if (sessionsWithTokens.length > 0) {
    console.log('SESSIONS WITH TOKEN DATA:');
    for (const s of sessionsWithTokens) {
      console.log(`  session=${s.session_id || 'n/a'} inbox=${s.inbox_id || 'n/a'}: in=${s.total_input || '?'} out=${s.total_output || '?'} cr=${s.total_cache_read || '?'} cw=${s.total_cache_write || '?'}`);
    }
    console.log('');
  }

  console.log('INCIDENT NOTE:');
  console.log('  ' + report.incident_note);
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
}
