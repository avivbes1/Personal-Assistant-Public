#!/usr/bin/env node
'use strict';
/**
 * lipa-audit-usage.js — DB-side cost/usage reconciliation for the Lipa Bridge.
 *
 * READ-ONLY: opens SQLite in readonly mode, runs zero migrations, never writes.
 *
 * Reads bridge_lipa_costs + bridge_lipa_attempts from the production DB and
 * produces a human-readable + machine-readable report.
 *
 * IMPORTANT: This reports DB-side accounting ONLY. Provider-side reconciliation
 * requires manual check at console.anthropic.com. Any gap between DB totals and
 * provider billing is UNKNOWN and must be investigated manually.
 *
 * Usage:
 *   node scripts/lipa-audit-usage.js              # human-readable report
 *   node scripts/lipa-audit-usage.js --json        # machine-readable JSON
 *   node scripts/lipa-audit-usage.js --json --pretty  # pretty-printed JSON
 */

const path = require('path');
const fs = require('fs');

// Load .env for FAMILYBOT_DB_PATH only — no initDB, no migrations
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const dbPath = process.env.FAMILYBOT_DB_PATH || path.join(__dirname, '..', 'data', 'family.db');
if (!fs.existsSync(dbPath)) {
  console.error('DB not found:', dbPath);
  process.exit(1);
}

// Open read-only — no WAL, no migrations, no writes
const Database = require('better-sqlite3');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const jsonMode = process.argv.includes('--json');
const pretty = process.argv.includes('--pretty');

// ── Cost ledger ──────────────────────────────────────────────────────────────

let costs = [];
try {
  costs = db.prepare('SELECT * FROM bridge_lipa_costs ORDER BY inbox_id, recorded_at').all();
} catch (e) {
  // Table may not exist yet
  if (!e.message.includes('no such table')) throw e;
}

const costsByInbox = new Map();
for (const c of costs) {
  const key = c.inbox_id == null ? '__run_level__' : c.inbox_id;
  if (!costsByInbox.has(key)) costsByInbox.set(key, []);
  costsByInbox.get(key).push(c);
}

let totalKnownSpend = 0;
let totalUnknownRows = 0;
let totalPartialRows = 0;
let totalRows = costs.length;
const inboxReports = [];

for (const [inboxId, rows] of costsByInbox) {
  let knownCost = 0;
  let unknownCount = 0;
  let partialCount = 0;
  const details = [];

  for (const r of rows) {
    const hasModel = !!r.model;
    const hasCost = r.cost_usd_lower_bound != null;
    const isUnknown = r.cost_unknown === 1;
    // A row with a cost but cost_unknown=1 is partial (has tokens but missing some)
    const isPartial = hasCost && isUnknown;

    if (!hasCost) {
      unknownCount++;
      totalUnknownRows++;
    } else if (isPartial) {
      // Partial: has SOME tokens priced, but flagged as incomplete
      partialCount++;
      totalPartialRows++;
      knownCost += r.cost_usd_lower_bound; // lower bound only
      totalKnownSpend += r.cost_usd_lower_bound;
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
      cost_usd: hasCost ? r.cost_usd_lower_bound : 'UNKNOWN',
      cost_unknown: isUnknown,
      partial: isPartial,
      source_key: r.source_key || null,
      date_jerusalem: r.date_jerusalem,
    });
  }

  inboxReports.push({
    inbox_id: inboxId === '__run_level__' ? null : inboxId,
    label: inboxId === '__run_level__' ? 'run-level (no inbox_id)' : `inbox ${inboxId}`,
    known_cost_usd: knownCost,
    unknown_rows: unknownCount,
    partial_rows: partialCount,
    total_rows: rows.length,
    details,
  });
}

// ── Attempt history ──────────────────────────────────────────────────────────

let attempts = [];
try {
  attempts = db.prepare(
    'SELECT event, outcome, COUNT(*) as count FROM bridge_lipa_attempts GROUP BY event, outcome ORDER BY event, outcome'
  ).all();
} catch (_) {}

// ── Session inventory from filesystem ────────────────────────────────────────
// Compute actual costs from OpenClaw session transcripts (the ground truth for
// what was billed to the provider, since sessions report usage directly).

const sessionsDir = '/home/ubuntu/.openclaw/agents/personal/sessions';
const testSessionReport = [];
let totalSessionCost = 0;
let totalSessionTokens = 0;
let sessionCount = 0;

try {
  const sessionFiles = fs.readdirSync(sessionsDir)
    .filter(f => (f.startsWith('preflight-') || f.startsWith('e2e-proof')) && f.endsWith('.jsonl') && !f.includes('trajectory'));

  for (const f of sessionFiles) {
    const lines = fs.readFileSync(path.join(sessionsDir, f), 'utf8').trim().split('\n');
    let model = null, totalTokens = 0, cost = 0, timestamp = null;
    let pollCount = 0, respondCount = 0;

    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        if (e.type === 'session') timestamp = e.timestamp;
        if (e.type === 'model_change') model = e.modelId;
        if (e.message?.role === 'assistant' && e.message?.usage) {
          totalTokens += e.message.usage.totalTokens || 0;
          cost += e.message.usage.cost?.total || 0;
        }
        // Count tool effects
        const content = e.message?.role === 'toolResult' ? JSON.stringify(e.message?.content || '') : '';
        if (content.includes('lipa-bridge-poll')) pollCount++;
        if (content.includes('lipa-bridge-respond')) respondCount++;
      } catch (_) {}
    }

    sessionCount++;
    totalSessionCost += cost;
    totalSessionTokens += totalTokens;
    testSessionReport.push({
      session_id: f.replace('.jsonl', ''),
      timestamp,
      model,
      total_tokens: totalTokens,
      cost_usd: cost,
      tool_effects: { poll_calls: pollCount, respond_calls: respondCount },
    });
  }
  testSessionReport.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
} catch (_) {}

// ── Wiped state assessment ───────────────────────────────────────────────────

let launchOutcomeCount = 0;
try {
  const row = db.prepare(
    "SELECT COUNT(*) as c FROM bridge_lipa_state WHERE key LIKE 'launch_%' OR key LIKE 'outcome_%'"
  ).get();
  launchOutcomeCount = row ? row.c : 0;
} catch (_) {}

// ── Build report ─────────────────────────────────────────────────────────────

const report = {
  generated_at: new Date().toISOString(),
  db_path: dbPath,
  read_only: true,
  summary: {
    cost_ledger_rows: totalRows,
    known_spend_usd: Math.round(totalKnownSpend * 10000) / 10000,
    unknown_cost_rows: totalUnknownRows,
    partial_cost_rows: totalPartialRows,
    known_cost_rows: totalRows - totalUnknownRows - totalPartialRows,
    launch_outcome_records: launchOutcomeCount,
    launch_outcome_note: launchOutcomeCount === 0
      ? 'WIPED during 2026-09-30 incident. Pre-wipe usage is permanently UNKNOWN from DB perspective.'
      : `${launchOutcomeCount} records present`,
    provider_reconciliation: 'REQUIRED — check console.anthropic.com for actual spend. DB totals are lower-bound estimates only.',
  },
  session_inventory: {
    total_sessions: sessionCount,
    computed_total_cost_usd: Math.round(totalSessionCost * 1000000) / 1000000,
    computed_total_tokens: totalSessionTokens,
    note: 'Computed from OpenClaw session transcript usage records. Includes cache write costs. This is the closest to provider billing truth available from the local system.',
    sessions: testSessionReport,
  },
  cost_by_inbox: inboxReports,
  attempt_summary: attempts,
  incident_note: 'The 2026-09-30 test-pollution incident wiped launch/outcome records and control-plane state. '
    + 'Pre-incident session costs are computed from session transcripts (see session_inventory). '
    + 'Provider billing at console.anthropic.com is the only definitive source; any gap is UNKNOWN.',
};

db.close();

if (jsonMode) {
  console.log(pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report));
} else {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' LIPA BRIDGE — DB-Side Usage Audit (READ-ONLY)');
  console.log(' Generated:', report.generated_at);
  console.log(' DB:', dbPath, '(readonly)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('COST LEDGER SUMMARY:');
  console.log('  Total rows:            ', report.summary.cost_ledger_rows);
  console.log('  Known spend (lower $):  $' + report.summary.known_spend_usd.toFixed(4));
  console.log('  Unknown-cost rows:     ', report.summary.unknown_cost_rows);
  console.log('  Partial-cost rows:     ', report.summary.partial_cost_rows);
  console.log('  Known-cost rows:       ', report.summary.known_cost_rows);
  console.log('  Launch/outcome records:', report.summary.launch_outcome_records, launchOutcomeCount === 0 ? '(WIPED)' : '');
  console.log('');

  console.log('SESSION INVENTORY (from transcript files):');
  console.log('  Total sessions:         ', sessionCount);
  console.log('  Computed cost:           $' + totalSessionCost.toFixed(6));
  console.log('  Computed tokens:         ', totalSessionTokens);
  for (const s of testSessionReport) {
    const effects = s.tool_effects.poll_calls > 0 ? ` poll=${s.tool_effects.poll_calls} respond=${s.tool_effects.respond_calls}` : ' (no bridge exec)';
    console.log(`  ${s.timestamp?.substring(0, 19)} ${s.session_id.substring(0, 40)} ${s.model} $${s.cost_usd.toFixed(4)}${effects}`);
  }
  console.log('');

  console.log('⚠️  PROVIDER RECONCILIATION REQUIRED');
  console.log('   DB totals are lower-bound estimates. Check console.anthropic.com');
  console.log('   for actual spend. Any gap is UNKNOWN.\n');

  console.log('COST BY INBOX:');
  for (const ir of inboxReports) {
    const partialNote = ir.partial_rows > 0 ? ` (${ir.partial_rows} partial)` : '';
    console.log(`  ${ir.label}: $${ir.known_cost_usd.toFixed(4)} known, ${ir.unknown_rows} unknown${partialNote} (${ir.total_rows} total)`);
  }
  console.log('');

  if (attempts.length > 0) {
    console.log('ATTEMPT SUMMARY:');
    for (const a of attempts) {
      console.log(`  ${a.event} / ${a.outcome}: ${a.count}`);
    }
    console.log('');
  }

  console.log('INCIDENT NOTE:');
  console.log('  ' + report.incident_note);
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
}
