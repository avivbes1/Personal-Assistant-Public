#!/usr/bin/env node
/**
 * export-eval-set.js — Build a labeled eval dataset from the message pipeline.
 *
 * Exports the last 60 days of WhatsApp messages, joins in any notice the
 * pipeline produced, takes a balanced sample across pipeline states, and
 * bootstraps a classification label for each message with Claude Sonnet.
 *
 * Output:
 *   tests/eval/dataset.jsonl      — one JSON record per line
 *   tests/eval/dataset-stats.json — counts by category / priority / action
 *
 * Idempotent: message IDs already present in dataset.jsonl are skipped, so the
 * script can be re-run to top up the sample or resume after an interruption.
 * Records are appended as they are labeled, so partial progress is never lost.
 *
 * NOTE: the rest of this codebase talks to Claude through the raw-HTTPS client
 * in src/llm/anthropic.js (there is no @anthropic-ai/sdk dependency), so this
 * script reuses that same client. dotenv is loaded BEFORE requiring it because
 * that module captures ANTHROPIC_API_KEY at load time.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Load .env before anything reads process.env.ANTHROPIC_API_KEY.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { initDB, getDB } = require('../src/db');
const anthropic = require('../src/llm/anthropic');

// ── Config ──────────────────────────────────────────────────────────────────

const MODEL = process.env.EVAL_MODEL || 'claude-haiku-4-5';
const WINDOW_DAYS = 60;
const SAMPLE_NOT_ACTIONABLE = 100;
const SAMPLE_RECEIVED = 50;
const MIN_REQUEST_INTERVAL_MS = 120; // ≤ ~8 req/s, safely under the 10 req/s cap

const OUT_DIR = path.join(__dirname, '..', 'tests', 'eval');
const DATASET_PATH = path.join(OUT_DIR, 'dataset.jsonl');
const STATS_PATH = path.join(OUT_DIR, 'dataset-stats.json');

const LABEL_SYSTEM =
  'You are labeling WhatsApp group messages for a family notification system. ' +
  'Given this message from a family/school WhatsApp group, classify it. ' +
  'Respond in JSON only: {"priority": "real_time|batch|archive|noise", ' +
  '"category": "event|reminder|request|announcement|logistics|chatter|media_only", ' +
  '"expected_action": "add_event|add_notice|send_now|defer|skip|none", ' +
  '"confidence": 0.0-1.0, "reasoning": "brief"}';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Sampling ────────────────────────────────────────────────────────────────

/**
 * Pull the balanced sample from SQLite, excluding message IDs already exported.
 * The two large negative buckets are randomly sampled up to their targets
 * (accounting for how many were exported in previous runs).
 */
function selectSample(existingIds, existingByState) {
  const db = getDB();
  const cutoff = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const base = `
    SELECT m.id, m.group_id, m.sender, m.body, m.timestamp, m.pipeline_state,
           n.content        AS notice_content,
           n.triage_decision AS notice_triage_decision,
           n.tier           AS notice_tier,
           n.delivery_status AS notice_delivery_status
    FROM messages m
    LEFT JOIN notices n ON m.notice_id = n.id
    WHERE m.timestamp > ?`;

  const notExported = (rows) => rows.filter((r) => !existingIds.has(r.id));

  // Interesting buckets: take everything not already exported.
  const noticeCreated = notExported(
    db.prepare(`${base} AND m.pipeline_state = 'NOTICE_CREATED'`).all(cutoff)
  );
  const failed = notExported(
    db.prepare(`${base} AND m.pipeline_state = 'FAILED'`).all(cutoff)
  );

  // Negative buckets: random sample up to target, minus what we already have.
  const notActionableNeed = Math.max(0, SAMPLE_NOT_ACTIONABLE - (existingByState.NOT_ACTIONABLE || 0));
  const notActionable = notExported(
    db.prepare(`${base} AND m.pipeline_state = 'NOT_ACTIONABLE' ORDER BY RANDOM()`).all(cutoff)
  ).slice(0, notActionableNeed);

  const receivedNeed = Math.max(0, SAMPLE_RECEIVED - (existingByState.RECEIVED || 0));
  const received = notExported(
    db.prepare(`${base} AND (m.pipeline_state = 'RECEIVED' OR m.pipeline_state IS NULL) ORDER BY RANDOM()`).all(cutoff)
  ).slice(0, receivedNeed);

  return { noticeCreated, failed, notActionable, received };
}

// ── Labeling ────────────────────────────────────────────────────────────────

/** Parse the model's reply into a label object, tolerating markdown fences. */
function parseLabel(text) {
  if (!text) return null;
  let s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

async function labelMessage(row) {
  const userContent =
    `Group: ${row.group_id}\n` +
    `Sender: ${row.sender}\n` +
    `Message:\n${row.body}`;

  const { text } = await anthropic.complete({
    model: MODEL,
    maxTokens: 512,
    system: LABEL_SYSTEM,
    messages: [{ role: 'user', content: userContent }],
  });

  return { label: parseLabel(text), raw: text };
}

/** Shape a DB row + label into the exported record. */
function toRecord(row, label, labelError) {
  const notice = row.notice_content
    ? {
        content: row.notice_content,
        triage_decision: row.notice_triage_decision,
        tier: row.notice_tier,
        delivery_status: row.notice_delivery_status,
      }
    : null;

  const rec = {
    id: row.id,
    group_id: row.group_id,
    sender: row.sender,
    body: row.body,
    timestamp: row.timestamp,
    pipeline_state: row.pipeline_state || null,
    notice,
    label: label || null,
    labeled_by: MODEL,
    exported_at: Date.now(),
  };
  if (labelError) rec.label_error = labelError;
  return rec;
}

// ── Existing dataset (idempotency) ────────────────────────────────────────────

/** Read dataset.jsonl → set of exported IDs + per-pipeline-state counts. */
async function readExisting() {
  const existingIds = new Set();
  const existingByState = {};
  if (!fs.existsSync(DATASET_PATH)) return { existingIds, existingByState };

  const rl = readline.createInterface({
    input: fs.createReadStream(DATASET_PATH),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch (_) {
      continue; // skip corrupt lines rather than abort
    }
    if (rec.id != null) {
      existingIds.add(rec.id);
      const st = rec.pipeline_state || 'UNKNOWN';
      existingByState[st] = (existingByState[st] || 0) + 1;
    }
  }
  return { existingIds, existingByState };
}

// ── Stats ─────────────────────────────────────────────────────────────────────

async function writeStats() {
  const counts = {
    total: 0,
    by_pipeline_state: {},
    by_category: {},
    by_priority: {},
    by_expected_action: {},
    unlabeled: 0,
  };

  const rl = readline.createInterface({
    input: fs.createReadStream(DATASET_PATH),
    crlfDelay: Infinity,
  });
  const bump = (bucket, key) => {
    const k = key == null ? 'null' : String(key);
    bucket[k] = (bucket[k] || 0) + 1;
  };
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch (_) {
      continue;
    }
    counts.total += 1;
    bump(counts.by_pipeline_state, rec.pipeline_state);
    if (rec.label) {
      bump(counts.by_category, rec.label.category);
      bump(counts.by_priority, rec.label.priority);
      bump(counts.by_expected_action, rec.label.expected_action);
    } else {
      counts.unlabeled += 1;
    }
  }

  counts.generated_at = new Date().toISOString();
  fs.writeFileSync(STATS_PATH, JSON.stringify(counts, null, 2) + '\n');
  return counts;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  initDB();

  const { existingIds, existingByState } = await readExisting();
  console.log(`[eval-export] ${existingIds.size} message(s) already exported.`);

  const sample = selectSample(existingIds, existingByState);
  const queue = [
    ...sample.noticeCreated,
    ...sample.failed,
    ...sample.notActionable,
    ...sample.received,
  ];

  console.log(
    `[eval-export] To label: ${queue.length} ` +
      `(NOTICE_CREATED=${sample.noticeCreated.length}, FAILED=${sample.failed.length}, ` +
      `NOT_ACTIONABLE=${sample.notActionable.length}, RECEIVED=${sample.received.length})`
  );

  if (queue.length === 0) {
    console.log('[eval-export] Nothing new to label.');
    const stats = await writeStats();
    console.log(`[eval-export] Stats written (${stats.total} total records).`);
    return;
  }

  let done = 0;
  let failures = 0;
  for (const row of queue) {
    const startedAt = Date.now();
    let label = null;
    let labelError;
    try {
      const res = await labelMessage(row);
      label = res.label;
      if (!label) labelError = `unparseable response: ${(res.raw || '').slice(0, 200)}`;
    } catch (e) {
      labelError = e.message;
      failures += 1;
    }

    const record = toRecord(row, label, labelError);
    fs.appendFileSync(DATASET_PATH, JSON.stringify(record) + '\n');

    done += 1;
    if (done % 25 === 0 || done === queue.length) {
      console.log(`[eval-export] Labeled ${done}/${queue.length} (${failures} failures).`);
    }

    // Rate limit: keep at least MIN_REQUEST_INTERVAL_MS between calls.
    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) await sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
  }

  const stats = await writeStats();
  console.log(
    `[eval-export] Done. ${done} newly labeled, ${failures} failures. ` +
      `Dataset now has ${stats.total} records.`
  );
}

main().catch((e) => {
  console.error('[eval-export] Fatal:', e);
  process.exit(1);
});
