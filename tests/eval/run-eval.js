#!/usr/bin/env node
/**
 * run-eval.js — Lightweight eval runner for the message-classification pipeline.
 *
 * For each labeled message in tests/eval/dataset.jsonl this runner reproduces
 * EXACTLY what production does for a monitored group: it calls
 * agent.classifyGroupMessage(), which uses the same system prompt
 * (buildGroupSystemPrompt), the same tools (GROUP_TOOLS), the same model
 * (GROUP_MODEL), and the same tool_choice:'any' as handleGroupEvent — but
 * WITHOUT executing any of the resulting actions (no DB writes, no calendar,
 * no WhatsApp). The predicted tool call is then mapped into the bootstrap
 * label's taxonomy and compared against the label.
 *
 * Metrics reported:
 *   - Overall accuracy: predicted pipeline_state vs the label's expectation
 *     (actionable → NOTICE_CREATED, otherwise NOT_ACTIONABLE)
 *   - Precision / recall per priority level  (real_time, batch, archive, noise)
 *   - Precision / recall per expected_action (add_event, add_notice, send_now,
 *     defer, skip, none)
 *   - Confusion matrices for both axes
 *   - Cost: total input/output tokens + an approximate USD estimate
 *
 * Results are written to tests/eval/eval-results.json.
 *
 * Flags:
 *   --dry-run          Validate dataset integrity only. No LLM calls, no src/
 *                      modules required, no DB. Used by CI.
 *   --gold-only        Restrict the run to human-labeled gold rows
 *                      (label_source === 'human'). Prints a gold-set summary
 *                      (total unique messages + per-action counts). Combine with
 *                      --dry-run to inspect the gold set without any LLM calls.
 *   --limit N          Classify only the first N labeled messages (quick checks).
 *   --model MODEL      Override the classification model (model-matrix runs).
 *   --threshold F      Accuracy threshold for exit code (default 0.70).
 *   --strict           Promote duplicate-ID detection to a fatal integrity error
 *                      (default: duplicates warn, and the full eval auto-dedups
 *                      by keeping the last occurrence of each ID).
 *   --out PATH         Override the results output path.
 *
 * Exit codes:
 *   0  dry-run: dataset valid  |  full run: overall accuracy ≥ threshold
 *   1  dry-run: integrity errors  |  full run: accuracy below threshold
 *   2  usage / fatal error
 *
 * NOTE ON FIDELITY: the dataset stores group_id (not the display name) and no
 * recent-message context, so the reconstructed prompt's family-context slice
 * and recent-chat section will be empty where production had them. The prompt
 * TEMPLATE, tools, and model are identical to production; the surrounding
 * runtime context is as complete as the dataset allows.
 *
 * IMPORTANT: .env is loaded BEFORE any src/ module is required, because
 * src/llm/anthropic.js captures ANTHROPIC_API_KEY at load time. src/ modules
 * are lazy-required only on the full-eval path, so --dry-run works in CI with
 * no secrets, no DB, and no network.
 */

'use strict';

const path = require('path');

// Load .env before ANY src/ require, because src/llm/anthropic.js captures
// ANTHROPIC_API_KEY at load time. Tolerant of a missing dotenv/.env so the
// dry-run path stays runnable in bare environments.
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
} catch (_) { /* dotenv not installed — fine for --dry-run */ }

const fs = require('fs');
const readline = require('readline');

// ── Paths ─────────────────────────────────────────────────────────────────────

const DATASET_PATH = path.join(__dirname, 'dataset.jsonl');
const DEFAULT_RESULTS_PATH = path.join(__dirname, 'eval-results.json');

// ── Taxonomy (must match the bootstrap labeler in scripts/export-eval-set.js) ──

const PRIORITIES = ['real_time', 'batch', 'archive', 'noise'];
const ACTIONS = ['add_event', 'add_notice', 'send_now', 'defer', 'skip', 'none'];
const PIPELINE_STATES = ['NOTICE_CREATED', 'NOT_ACTIONABLE'];

// ── Rate limiting / RAM constraints ─────────────────────────────────────────────
// This box has ~4GB shared with the bot + OpenClaw, so we run STRICTLY
// sequentially (one in-flight request → flat memory) and cap throughput well
// under the 5 req/s limit. After each batch we pause to stay gentle.

const BATCH_SIZE = 10;
const REQUEST_INTERVAL_MS = 250; // ≤ 4 req/s, safely under the 5 req/s cap
const BATCH_DELAY_MS = 1000;     // breather between batches of 10

const DEFAULT_THRESHOLD = 0.70;

// Approximate USD per 1M tokens. Rough — edit to match current pricing.
const PRICING = {
  'claude-haiku-4-5':  { input: 1.0,  output: 5.0 },
  'claude-sonnet-4-6': { input: 3.0,  output: 15.0 },
  'claude-opus-4-8':   { input: 15.0, output: 75.0 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { dryRun: false, goldOnly: false, limit: null, model: null, threshold: DEFAULT_THRESHOLD, strict: false, out: DEFAULT_RESULTS_PATH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--gold-only') args.goldOnly = true;
    else if (a === '--strict') args.strict = true;
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a.startsWith('--limit=')) args.limit = parseInt(a.split('=')[1], 10);
    else if (a === '--model') args.model = argv[++i];
    else if (a.startsWith('--model=')) args.model = a.split('=')[1];
    else if (a === '--threshold') args.threshold = parseFloat(argv[++i]);
    else if (a.startsWith('--threshold=')) args.threshold = parseFloat(a.split('=')[1]);
    else if (a === '--out') args.out = argv[++i];
    else if (a.startsWith('--out=')) args.out = a.split('=')[1];
    else if (a === '--help' || a === '-h') { printUsage(); process.exit(0); }
    else { console.error(`[eval] Unknown argument: ${a}`); printUsage(); process.exit(2); }
  }
  if (args.limit != null && (!Number.isFinite(args.limit) || args.limit <= 0)) {
    console.error('[eval] --limit must be a positive integer'); process.exit(2);
  }
  if (!Number.isFinite(args.threshold) || args.threshold < 0 || args.threshold > 1) {
    console.error('[eval] --threshold must be between 0 and 1'); process.exit(2);
  }
  return args;
}

function printUsage() {
  console.log(`Usage: node tests/eval/run-eval.js [options]

  --dry-run          Validate dataset integrity only (no LLM, no DB) — used by CI
  --gold-only        Restrict to human-labeled gold rows (label_source==='human')
  --limit N          Classify only the first N labeled messages
  --model MODEL      Override the classification model
  --threshold F      Accuracy threshold for exit code (default ${DEFAULT_THRESHOLD})
  --strict           Treat duplicate IDs as a fatal integrity error
  --out PATH         Results output path (default tests/eval/eval-results.json)
  -h, --help         Show this help`);
}

// ── Dataset loading & validation ────────────────────────────────────────────

/**
 * Read dataset.jsonl into memory, validating every line.
 * Returns { records, fatal[], warnings[] }.
 *   - fatal   : integrity errors that should fail CI (bad JSON, missing/invalid fields)
 *   - warnings: non-fatal notes (e.g. an intentionally unlabeled record)
 */
async function loadDataset() {
  if (!fs.existsSync(DATASET_PATH)) {
    return { records: [], fatal: [`dataset not found: ${DATASET_PATH}`], warnings: [] };
  }

  const records = [];
  const fatal = [];
  const warnings = [];

  const rl = readline.createInterface({
    input: fs.createReadStream(DATASET_PATH),
    crlfDelay: Infinity,
  });

  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch (e) {
      fatal.push(`line ${lineNo}: invalid JSON (${e.message})`);
      continue;
    }

    // Required top-level fields (body may legitimately be empty for media-only,
    // so it is checked for presence, not emptiness).
    for (const f of ['id', 'group_id', 'sender', 'timestamp']) {
      if (rec[f] === undefined || rec[f] === null || rec[f] === '') {
        fatal.push(`line ${lineNo} (id=${rec.id ?? '?'}): missing/empty field "${f}"`);
      }
    }
    if (rec.body === undefined || rec.body === null) {
      fatal.push(`line ${lineNo} (id=${rec.id ?? '?'}): missing field "body"`);
    }
    if (rec.timestamp != null && !Number.isFinite(Number(rec.timestamp))) {
      fatal.push(`line ${lineNo} (id=${rec.id}): timestamp is not numeric`);
    }

    // Label validation
    if (!rec.label) {
      warnings.push(`line ${lineNo} (id=${rec.id}): unlabeled${rec.label_error ? ` (${String(rec.label_error).slice(0, 80)})` : ''}`);
    } else {
      const L = rec.label;
      if (!PRIORITIES.includes(L.priority)) {
        fatal.push(`line ${lineNo} (id=${rec.id}): invalid priority "${L.priority}"`);
      }
      if (!ACTIONS.includes(L.expected_action)) {
        fatal.push(`line ${lineNo} (id=${rec.id}): invalid expected_action "${L.expected_action}"`);
      }
      if (typeof L.category !== 'string' || !L.category) {
        fatal.push(`line ${lineNo} (id=${rec.id}): missing category`);
      }
      const conf = Number(L.confidence);
      if (!Number.isFinite(conf) || conf < 0 || conf > 1) {
        fatal.push(`line ${lineNo} (id=${rec.id}): confidence out of range (${L.confidence})`);
      }
    }

    records.push(rec);
  }

  return { records, fatal, warnings, duplicates: analyzeDuplicates(records) };
}

/**
 * Group records by id and summarize duplication. A duplicate is "conflicting"
 * when its copies disagree on (expected_action, priority) — i.e. contradictory
 * ground truth, which genuinely corrupts metrics.
 */
function analyzeDuplicates(records) {
  const byId = new Map();
  for (const r of records) {
    if (r.id == null) continue;
    if (!byId.has(r.id)) byId.set(r.id, []);
    byId.get(r.id).push(r);
  }
  let dupIds = 0;
  let dupLines = 0;
  const conflictingIds = [];
  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    dupIds++;
    dupLines += group.length - 1; // extra copies beyond the first
    const labelKeys = new Set(
      group.map((r) => (r.label ? `${r.label.expected_action}|${r.label.priority}` : 'null'))
    );
    if (labelKeys.size > 1) conflictingIds.push(id);
  }
  return { uniqueIds: byId.size, dupIds, dupLines, conflictingIds };
}

/** Keep only human-labeled gold rows (label_source === 'human'). */
function filterGold(records) {
  return records.filter((r) => r.label_source === 'human');
}

/**
 * Summarize the gold set: unique labeled messages (deduped by id, since the
 * dataset stores the same message id on multiple lines) and per-action counts
 * over the label's primary expected_action.
 */
function goldStats(records) {
  const unique = dedupById(records.filter((r) => r.label));
  const byAction = {};
  for (const c of ACTIONS) byAction[c] = 0;
  for (const r of unique) {
    const a = r.label.expected_action;
    byAction[a] = (byAction[a] || 0) + 1;
  }
  return { totalRows: records.length, uniqueMessages: unique.length, byAction };
}

function printGoldSummary(records) {
  const { totalRows, uniqueMessages, byAction } = goldStats(records);
  console.log('\n[eval] Gold set (human-labeled) summary:');
  console.log(`[eval]   gold dataset rows:      ${totalRows}`);
  console.log(`[eval]   unique gold messages:   ${uniqueMessages}`);
  console.log('[eval]   per-action (primary expected_action, deduped by id):');
  for (const c of ACTIONS) console.log(`[eval]     ${c.padEnd(12)} ${byAction[c]}`);
}

/** Collapse to one record per id, keeping the LAST occurrence. */
function dedupById(records) {
  const byId = new Map();
  const noId = [];
  for (const r of records) {
    if (r.id == null) noId.push(r);
    else byId.set(r.id, r); // last write wins
  }
  return [...byId.values(), ...noId];
}

// ── Prediction mapping ──────────────────────────────────────────────────────
// Production emits tool calls (add_notice/add_event/add_task/add_homework/
// no_action/download_image/log_profile_contradiction). The bootstrap label
// uses a different, coarser taxonomy. These functions define the (necessarily
// approximate) bridge between the two. They are the main knobs to tune if the
// two taxonomies are re-aligned.

function toolNames(toolCalls) {
  return toolCalls.map((t) => t.name);
}

function firstNotice(toolCalls) {
  return toolCalls.find((t) => t.name === 'add_notice') || null;
}

function isActionable(toolCalls) {
  return toolCalls.some((t) => ['add_notice', 'add_event', 'add_task', 'add_homework'].includes(t.name));
}

/** Map production tool calls → the label's expected_action taxonomy. */
function predictAction(toolCalls) {
  const names = toolNames(toolCalls);
  if (names.includes('add_event')) return 'add_event';
  const notice = firstNotice(toolCalls);
  if (notice) {
    const u = notice.input && notice.input.urgency_hint;
    if (u === 'immediate') return 'send_now';        // deliver now
    if (u === 'time_sensitive') return 'add_notice'; // notice, soon
    return 'defer';                                  // routine / unspecified
  }
  if (names.includes('add_task') || names.includes('add_homework')) return 'add_notice';
  // no_action / download_image / log_profile_contradiction / nothing.
  // Both label buckets "skip" (majority) and "none" collapse here; we predict
  // "skip" since production has no signal to distinguish them.
  return 'skip';
}

/** Map production tool calls → the label's priority taxonomy. */
function predictPriority(toolCalls) {
  if (!isActionable(toolCalls)) return 'noise';
  const notice = firstNotice(toolCalls);
  if (notice && notice.input && notice.input.urgency_hint === 'immediate') return 'real_time';
  // "archive" is rarely reachable from production signals; batch is the
  // majority actionable bucket. Recall for archive will read ~0 (honest).
  return 'batch';
}

/** Predicted pipeline_state — any actionable tool call ⇒ NOTICE_CREATED. */
function predictPipeline(toolCalls) {
  return isActionable(toolCalls) ? 'NOTICE_CREATED' : 'NOT_ACTIONABLE';
}

/** What pipeline_state the label implies. */
function labelPipeline(expectedAction) {
  return ['add_event', 'add_notice', 'send_now', 'defer'].includes(expectedAction)
    ? 'NOTICE_CREATED'
    : 'NOT_ACTIONABLE';
}

// ── Metrics ─────────────────────────────────────────────────────────────────

function round(x, d = 4) {
  if (x == null || Number.isNaN(x)) return null;
  const m = Math.pow(10, d);
  return Math.round(x * m) / m;
}

function mean(arr) {
  const vals = arr.filter((v) => v != null && !Number.isNaN(v));
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Precision/recall/F1 per class + accuracy + macro averages. */
function prf(pairs, classes) {
  const per = {};
  for (const c of classes) {
    let tp = 0, fp = 0, fn = 0, support = 0;
    for (const { actual, pred } of pairs) {
      if (actual === c) support++;
      if (pred === c && actual === c) tp++;
      else if (pred === c && actual !== c) fp++;
      else if (pred !== c && actual === c) fn++;
    }
    const precision = tp + fp ? tp / (tp + fp) : null;
    const recall = tp + fn ? tp / (tp + fn) : null;
    const f1 = precision != null && recall != null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;
    per[c] = { precision: round(precision), recall: round(recall), f1: round(f1), tp, fp, fn, support };
  }
  const accuracy = pairs.length ? pairs.filter((p) => p.actual === p.pred).length / pairs.length : 0;
  const supported = classes.filter((c) => per[c].support > 0);
  return {
    per_class: per,
    accuracy: round(accuracy),
    macro_precision: round(mean(supported.map((c) => per[c].precision))),
    macro_recall: round(mean(supported.map((c) => per[c].recall))),
    macro_f1: round(mean(supported.map((c) => per[c].f1))),
  };
}

/** Confusion matrix: matrix[actual][pred] = count. */
function confusion(pairs, classes) {
  const matrix = {};
  for (const a of classes) {
    matrix[a] = {};
    for (const p of classes) matrix[a][p] = 0;
  }
  for (const { actual, pred } of pairs) {
    if (!matrix[actual]) matrix[actual] = {};
    matrix[actual][pred] = (matrix[actual][pred] || 0) + 1;
  }
  return matrix;
}

// ── Pretty printing ─────────────────────────────────────────────────────────

function printConfusion(title, matrix, classes) {
  console.log(`\n${title} (rows = label, cols = predicted):`);
  const w = 15;
  const pad = (s) => String(s).padStart(w);
  console.log(pad('actual\\pred') + classes.map((c) => pad(c)).join(''));
  for (const a of classes) {
    const row = classes.map((p) => pad((matrix[a] && matrix[a][p]) || 0)).join('');
    console.log(pad(a) + row);
  }
}

function printPRF(title, result, classes) {
  console.log(`\n${title}:`);
  console.log(
    '  ' +
      'class'.padEnd(14) +
      'precision'.padStart(11) +
      'recall'.padStart(11) +
      'f1'.padStart(9) +
      'support'.padStart(9)
  );
  const fmt = (v) => (v == null ? '—' : v.toFixed(3));
  for (const c of classes) {
    const m = result.per_class[c];
    console.log(
      '  ' +
        c.padEnd(14) +
        fmt(m.precision).padStart(11) +
        fmt(m.recall).padStart(11) +
        fmt(m.f1).padStart(9) +
        String(m.support).padStart(9)
    );
  }
  console.log(
    `  ${'macro'.padEnd(14)}${fmt(result.macro_precision).padStart(11)}${fmt(result.macro_recall).padStart(11)}${fmt(result.macro_f1).padStart(9)}`
  );
  console.log(`  accuracy: ${(result.accuracy ?? 0).toFixed(4)}`);
}

// ── Cost ────────────────────────────────────────────────────────────────────

function estimateCost(model, inputTokens, outputTokens) {
  let rate = PRICING[model];
  if (!rate) {
    // fall back to family-prefix match (e.g. "claude-haiku-…")
    const key = Object.keys(PRICING).find((k) => model && model.startsWith(k.split('-').slice(0, 2).join('-')));
    rate = key ? PRICING[key] : null;
  }
  const usd = rate ? (inputTokens / 1e6) * rate.input + (outputTokens / 1e6) * rate.output : null;
  return { estimated_usd: usd != null ? round(usd, 6) : null, rate: rate || null };
}

// ── Dry-run ─────────────────────────────────────────────────────────────────

function runDryRun(loaded, args) {
  const { records, fatal, warnings, duplicates } = loaded;
  const labeled = records.filter((r) => r.label);
  console.log('[eval] Dry-run: validating dataset integrity');
  console.log(`[eval]   records:    ${records.length}`);
  console.log(`[eval]   unique ids: ${duplicates.uniqueIds}`);
  console.log(`[eval]   labeled:    ${labeled.length}`);
  console.log(`[eval]   unlabeled:  ${records.length - labeled.length}`);

  // Duplicate handling — fatal under --strict, otherwise a loud warning.
  const dupMsgs = [];
  if (duplicates.dupIds > 0) {
    dupMsgs.push(
      `${duplicates.dupIds} id(s) duplicated across ${duplicates.dupLines} extra line(s); ` +
        `${duplicates.conflictingIds.length} have CONFLICTING labels` +
        (duplicates.conflictingIds.length
          ? ` (e.g. ids ${duplicates.conflictingIds.slice(0, 5).join(', ')})`
          : '')
    );
  }

  if (warnings.length) {
    console.log(`[eval]   unlabeled records: ${warnings.length}`);
    for (const w of warnings.slice(0, 5)) console.log(`           • ${w}`);
    if (warnings.length > 5) console.log(`           … and ${warnings.length - 5} more`);
  }

  const fatalAll = args.strict ? [...fatal, ...dupMsgs] : fatal;

  if (!args.strict && dupMsgs.length) {
    console.warn(`\n[eval] ⚠ duplicate ids (non-fatal; use --strict to enforce, full eval auto-dedups):`);
    for (const m of dupMsgs) console.warn(`         • ${m}`);
  }

  if (fatalAll.length) {
    console.error(`\n[eval] ✗ ${fatalAll.length} integrity error(s):`);
    for (const f of fatalAll.slice(0, 25)) console.error(`         • ${f}`);
    if (fatalAll.length > 25) console.error(`         … and ${fatalAll.length - 25} more`);
    console.error('\n[eval] Dataset FAILED integrity check.');
    return 1;
  }

  console.log('\n[eval] ✓ Dataset integrity OK.');
  return 0;
}

// ── Full eval ────────────────────────────────────────────────────────────────

async function runEval(loaded, args) {
  const { records, fatal, duplicates } = loaded;
  if (fatal.length) {
    console.error(`[eval] Refusing to run: ${fatal.length} dataset integrity error(s). Run with --dry-run for details.`);
    return 2;
  }
  if (args.strict && duplicates.dupIds > 0) {
    console.error(`[eval] Refusing to run under --strict: ${duplicates.dupIds} duplicate id(s) in dataset.`);
    return 2;
  }

  // Lazy require — only now (after dotenv) do we touch src/ modules / the DB.
  const { initDB } = require('../../src/db');
  const agent = require('../../src/agent');
  const model = args.model || agent.GROUP_MODEL;

  try {
    initDB();
  } catch (e) {
    console.error('[eval] Failed to initialize DB (needed for family-context in the prompt):', e.message);
    return 2;
  }

  // Load the family profile so buildGroupSystemPrompt's <FAMILY_CONTEXT> slice
  // matches production (production calls this at startup). Non-fatal if absent.
  try {
    require('../../src/family-context').loadProfile();
  } catch (e) {
    console.warn('[eval] Family profile not loaded (prompt will omit the profile slice):', e.message);
  }

  // Auto-dedup so duplicated/conflicting records don't corrupt the metrics.
  let queue = records.filter((r) => r.label);
  if (duplicates.dupIds > 0) {
    const before = queue.length;
    queue = dedupById(queue);
    console.warn(`[eval] ⚠ Deduped ${before - queue.length} duplicate record(s) (kept last per id).`);
  }
  if (args.limit != null) queue = queue.slice(0, args.limit);

  console.log(`[eval] Classifying ${queue.length} labeled message(s) with model "${model}"`);
  console.log(`[eval] Rate: ≥${REQUEST_INTERVAL_MS}ms/request, pause ${BATCH_DELAY_MS}ms every ${BATCH_SIZE}.`);
  if (queue.length === 0) {
    console.error('[eval] Nothing to classify.');
    return 2;
  }

  const perRecord = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let errors = 0;
  let skippedEmpty = 0;

  for (let i = 0; i < queue.length; i++) {
    const rec = queue[i];
    const startedAt = Date.now();

    let toolCalls = [];
    let recError = null;

    if (!rec.body || !String(rec.body).trim()) {
      // Mirror production's empty-body guard: no LLM call, treated as no_action.
      skippedEmpty++;
    } else {
      try {
        const res = await agent.classifyGroupMessage({
          body: rec.body,
          groupName: rec.group_id, // dataset stores group_id, not the display name
          sender: rec.sender,
          ts: Number(rec.timestamp) || Date.now(),
          model,
        });
        toolCalls = res.toolCalls || [];
        inputTokens += res.inputTokens || 0;
        outputTokens += res.outputTokens || 0;
      } catch (e) {
        recError = e.message;
        errors++;
      }
    }

    const predAction = recError ? null : predictAction(toolCalls);
    const predPriority = recError ? null : predictPriority(toolCalls);
    const predPipeline = recError ? null : predictPipeline(toolCalls);

    perRecord.push({
      id: rec.id,
      group_id: rec.group_id,
      recorded_pipeline_state: rec.pipeline_state || null,
      // ground truth (label)
      label_action: rec.label.expected_action,
      label_priority: rec.label.priority,
      label_pipeline: labelPipeline(rec.label.expected_action),
      // prediction
      pred_action: predAction,
      pred_priority: predPriority,
      pred_pipeline: predPipeline,
      tools: toolCalls.map((t) => t.name),
      error: recError,
    });

    // Progress + rate limiting
    if ((i + 1) % BATCH_SIZE === 0 || i === queue.length - 1) {
      console.log(`[eval]   ${i + 1}/${queue.length} classified (${errors} error(s), ${skippedEmpty} empty)`);
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed < REQUEST_INTERVAL_MS) await sleep(REQUEST_INTERVAL_MS - elapsed);
    if ((i + 1) % BATCH_SIZE === 0 && i < queue.length - 1) await sleep(BATCH_DELAY_MS);
  }

  // ── Compute metrics over successfully-classified records ──
  const scored = perRecord.filter((r) => r.error == null);

  const actionPairs = scored.map((r) => ({ actual: r.label_action, pred: r.pred_action }));
  const priorityPairs = scored.map((r) => ({ actual: r.label_priority, pred: r.pred_priority }));
  const pipelinePairs = scored.map((r) => ({ actual: r.label_pipeline, pred: r.pred_pipeline }));

  const actionResult = prf(actionPairs, ACTIONS);
  const priorityResult = prf(priorityPairs, PRIORITIES);
  const pipelineResult = prf(pipelinePairs, PIPELINE_STATES);

  const overallAccuracy = pipelineResult.accuracy ?? 0;
  const passed = overallAccuracy >= args.threshold;

  const totalTokens = inputTokens + outputTokens;
  const cost = estimateCost(model, inputTokens, outputTokens);

  const results = {
    generated_at: new Date().toISOString(),
    model,
    dataset: path.relative(path.join(__dirname, '..', '..'), DATASET_PATH),
    threshold: args.threshold,
    overall_accuracy: overallAccuracy,
    passed,
    counts: {
      total_records: records.length,
      labeled: records.filter((r) => r.label).length,
      duplicate_ids: duplicates.dupIds,
      conflicting_ids: duplicates.conflictingIds.length,
      attempted: perRecord.length,
      scored: scored.length,
      errors,
      skipped_empty_body: skippedEmpty,
    },
    cost: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      estimated_usd: cost.estimated_usd,
      pricing_per_mtok: cost.rate,
    },
    pipeline_state: {
      accuracy: pipelineResult.accuracy,
      per_class: pipelineResult.per_class,
      confusion_matrix: confusion(pipelinePairs, PIPELINE_STATES),
    },
    priority: {
      accuracy: priorityResult.accuracy,
      macro_precision: priorityResult.macro_precision,
      macro_recall: priorityResult.macro_recall,
      macro_f1: priorityResult.macro_f1,
      per_class: priorityResult.per_class,
      confusion_matrix: confusion(priorityPairs, PRIORITIES),
    },
    expected_action: {
      accuracy: actionResult.accuracy,
      macro_precision: actionResult.macro_precision,
      macro_recall: actionResult.macro_recall,
      macro_f1: actionResult.macro_f1,
      per_class: actionResult.per_class,
      confusion_matrix: confusion(actionPairs, ACTIONS),
    },
    // Per-record predictions (message bodies deliberately excluded to keep the
    // results file free of PII).
    per_record: perRecord,
  };

  fs.writeFileSync(args.out, JSON.stringify(results, null, 2) + '\n');

  // ── Console report ──
  console.log('\n' + '='.repeat(64));
  console.log(`[eval] RESULTS — model: ${model}`);
  console.log('='.repeat(64));
  console.log(`Scored: ${scored.length}/${perRecord.length} (errors: ${errors}, empty: ${skippedEmpty})`);
  console.log(`\nOverall accuracy (pipeline_state vs label): ${overallAccuracy.toFixed(4)}  [threshold ${args.threshold}]`);

  printPRF('Priority', priorityResult, PRIORITIES);
  printConfusion('Priority confusion', results.priority.confusion_matrix, PRIORITIES);

  printPRF('Expected action', actionResult, ACTIONS);
  printConfusion('Expected-action confusion', results.expected_action.confusion_matrix, ACTIONS);

  printConfusion('Pipeline-state confusion', results.pipeline_state.confusion_matrix, PIPELINE_STATES);

  console.log(`\nCost: ${inputTokens} in + ${outputTokens} out = ${totalTokens} tokens` +
    (cost.estimated_usd != null ? `  (~$${cost.estimated_usd})` : '  (pricing unknown for this model)'));

  console.log(`\nResults written to ${path.relative(process.cwd(), args.out)}`);
  console.log(`\n[eval] ${passed ? '✓ PASS' : '✗ FAIL'} — accuracy ${overallAccuracy.toFixed(4)} ${passed ? '≥' : '<'} threshold ${args.threshold}`);

  return passed ? 0 : 1;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const loaded = await loadDataset();

  // --gold-only: narrow the working set to human-labeled gold rows. The full
  // dataset is still validated by loadDataset() (fatal/warnings are global), but
  // everything downstream operates on the gold subset.
  if (args.goldOnly) {
    const before = loaded.records.length;
    loaded.records = filterGold(loaded.records);
    loaded.duplicates = analyzeDuplicates(loaded.records);
    printGoldSummary(loaded.records);
    console.log(
      `[eval] --gold-only: ${loaded.records.length} human-labeled row(s) of ${before} total ` +
        `→ ${loaded.duplicates.uniqueIds} unique gold message(s).`
    );
    if (loaded.records.length === 0) {
      console.error('[eval] --gold-only: no rows with label_source === "human". Nothing to do.');
      process.exit(2);
    }
  }

  const code = args.dryRun ? runDryRun(loaded, args) : await runEval(loaded, args);
  process.exit(code);
}

// Only run when invoked directly, so the pure helpers can be unit-tested.
if (require.main === module) {
  main().catch((e) => {
    console.error('[eval] Fatal:', e);
    process.exit(2);
  });
}

module.exports = {
  predictAction,
  predictPriority,
  predictPipeline,
  labelPipeline,
  prf,
  confusion,
  analyzeDuplicates,
  dedupById,
  filterGold,
  goldStats,
  estimateCost,
  PRIORITIES,
  ACTIONS,
  PIPELINE_STATES,
};
