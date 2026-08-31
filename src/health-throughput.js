/**
 * health-throughput.js — Throughput & integrity health checks (WORKPLAN-V4 A4).
 *
 * These catch *silent* failure: the message router is up and connected, but
 * messages stop flowing, get stuck mid-pipeline, media stops parsing, duplicates
 * ship, or config state drifts. The existing health.js checks are all *connection*
 * checks; these are the throughput/integrity complement.
 *
 * Every check emits a line to data/health-metrics.jsonl (ok or not) so B-phase
 * work has a trend line, logs via the shared logger, and returns a failure string
 * (or null) so the caller can fold it into the normal health alert path.
 */

const fs = require('fs');
const path = require('path');
const { getDB } = require('./db');
const { textSimilarity } = require('./notice-dedup');
const { getIsraelHour } = require('./timeUtils');
const logger = require('./logger');

const METRICS_PATH = path.join(__dirname, '../data/health-metrics.jsonl');

// The master group is the bot's own output channel, not an ingestion source —
// exclude it from ingestion/silence math (same JID the outage check excludes).
const MASTER_GROUP_ID = '120363426994367917@g.us';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Append one metric row to data/health-metrics.jsonl. Never throws — a metrics
 * write failure must not take down the health cycle.
 * @param {string} check  check name
 * @param {boolean} ok    true = healthy, false = alert-worthy
 * @param {object} data   arbitrary numbers/details for the trend line
 */
function emitMetric(check, ok, data = {}) {
  const row = { ts: Date.now(), check, ok, ...data };
  try {
    fs.mkdirSync(path.dirname(METRICS_PATH), { recursive: true });
    fs.appendFileSync(METRICS_PATH, JSON.stringify(row) + '\n');
  } catch (e) {
    logger.warn({ component: 'HealthThroughput', err: e.message }, 'Could not write health metric');
  }
}

/**
 * 1. Ingestion volume — zero inbound (non-master) messages in the last 3 hours,
 *    evaluated only during Israel daytime so a quiet night never alerts. We wait
 *    until 11:00 so the full 3h window (08:00→) sits inside daytime.
 */
function checkIngestionVolume(db, nowMs) {
  const hour = getIsraelHour(nowMs);
  if (hour < 11 || hour >= 23) {
    emitMetric('ingestion_volume', true, { skipped: 'outside_daytime_window', israelHour: hour });
    return null;
  }
  const since = nowMs - 3 * HOUR_MS;
  const row = db.prepare(
    'SELECT COUNT(*) AS c FROM messages WHERE timestamp > ? AND group_id != ?'
  ).get(since, MASTER_GROUP_ID);
  const count = row ? row.c : 0;
  const ok = count > 0;
  emitMetric('ingestion_volume', ok, { count, windowHours: 3, israelHour: hour });
  if (!ok) return 'Ingestion stalled: 0 inbound messages in the last 3 daytime hours';
  return null;
}

/**
 * 2. Terminal-state rate — messages stuck at FAILED or RECEIVED for >30 min as a
 *    share of the last 24h. RECEIVED means the pipeline never picked it up;
 *    FAILED means it errored out. Both are terminal-bad. Report top 3 fail codes.
 */
function checkTerminalStateRate(db, nowMs) {
  const dayAgo = nowMs - DAY_MS;
  const total = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE timestamp > ?').get(dayAgo).c;
  if (total === 0) {
    emitMetric('terminal_state_rate', true, { total: 0, stuck: 0, rate: 0 });
    return null;
  }
  const staleBefore = nowMs - 30 * 60 * 1000;
  const stuck = db.prepare(
    `SELECT COUNT(*) AS c FROM messages
      WHERE timestamp > ? AND timestamp < ?
        AND pipeline_state IN ('FAILED','RECEIVED')`
  ).get(dayAgo, staleBefore).c;

  const rate = stuck / total;
  const THRESHOLD = 0.05;

  // Top 3 failure codes among FAILED messages in the window (parsed from the
  // pipeline_error JSON blob; falls back to RAW/unknown for unparseable rows).
  const failedRows = db.prepare(
    `SELECT pipeline_error FROM messages
      WHERE timestamp > ? AND pipeline_state = 'FAILED' AND pipeline_error IS NOT NULL`
  ).all(dayAgo);
  const codeCounts = {};
  for (const r of failedRows) {
    let code = 'UNKNOWN';
    try {
      const parsed = JSON.parse(r.pipeline_error);
      if (parsed && parsed.code) code = parsed.code;
    } catch (_) {
      code = 'RAW';
    }
    codeCounts[code] = (codeCounts[code] || 0) + 1;
  }
  const topCodes = Object.entries(codeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([code, n]) => `${code}×${n}`);

  const ok = rate <= THRESHOLD;
  emitMetric('terminal_state_rate', ok, {
    total, stuck, rate: Number(rate.toFixed(4)), threshold: THRESHOLD, topCodes,
  });
  if (!ok) {
    const pct = (rate * 100).toFixed(1);
    const codes = topCodes.length ? ` — top: ${topCodes.join(', ')}` : '';
    return `Terminal-state rate ${pct}% (${stuck}/${total}) over 24h exceeds 5%${codes}`;
  }
  return null;
}

/**
 * 3. Media parse rate — share of media messages (last 24h) that failed to parse.
 *    media_status='failed' is the null-parse signal. Guard against tiny samples.
 */
function checkMediaParseRate(db, nowMs) {
  const dayAgo = nowMs - DAY_MS;
  const total = db.prepare(
    'SELECT COUNT(*) AS c FROM messages WHERE timestamp > ? AND media_type IS NOT NULL'
  ).get(dayAgo).c;
  const MIN_SAMPLE = 5;
  if (total < MIN_SAMPLE) {
    emitMetric('media_parse_rate', true, { total, failed: 0, rate: 0, note: 'below_min_sample' });
    return null;
  }
  const failed = db.prepare(
    `SELECT COUNT(*) AS c FROM messages
      WHERE timestamp > ? AND media_type IS NOT NULL AND media_status = 'failed'`
  ).get(dayAgo).c;
  const rate = failed / total;
  const THRESHOLD = 0.20;
  const ok = rate <= THRESHOLD;
  emitMetric('media_parse_rate', ok, { total, failed, rate: Number(rate.toFixed(4)), threshold: THRESHOLD });
  if (!ok) {
    const pct = (rate * 100).toFixed(1);
    return `Media parse-failure rate ${pct}% (${failed}/${total}) over 24h exceeds 20%`;
  }
  return null;
}

/**
 * 4. Delivery duplicate canary — any two sent_messages within 24h at ≥0.9 Jaccard.
 *    Works regardless of which sender produced them (both delivery paths write here).
 *    Compares the most recent 200 rows to bound the O(n²) pass.
 */
function checkDeliveryDuplicates(db, nowMs) {
  const dayAgo = nowMs - DAY_MS;
  const rows = db.prepare(
    'SELECT id, message_text FROM sent_messages WHERE sent_at > ? ORDER BY sent_at DESC LIMIT 200'
  ).all(dayAgo);
  const THRESHOLD = 0.9;
  let worst = null; // { a, b, sim }
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const sim = textSimilarity(rows[i].message_text || '', rows[j].message_text || '');
      if (sim >= THRESHOLD && (!worst || sim > worst.sim)) {
        worst = { a: rows[i].id, b: rows[j].id, sim };
      }
    }
  }
  const ok = !worst;
  emitMetric('delivery_duplicate', ok, {
    compared: rows.length, threshold: THRESHOLD,
    ...(worst ? { pair: [worst.a, worst.b], similarity: Number(worst.sim.toFixed(3)) } : {}),
  });
  if (!ok) {
    return `Duplicate delivery: sent_messages ${worst.a} & ${worst.b} are ${(worst.sim * 100).toFixed(0)}% similar within 24h`;
  }
  return null;
}

// Sanctioned relationship values for a configured group. Anything else in
// related_to on a configured group is schema drift (the ISSUE-023 signature).
const SANCTIONED_RELATED_TO = ['monitored', 'master', 'ignored', 'unmonitored'];

/**
 * 5. Config-state integrity (ISSUE-023) — stale open group questions, or a
 *    configured group whose related_to holds an out-of-vocabulary value.
 */
function checkConfigStateIntegrity(db, nowMs) {
  const failures = [];

  const staleBefore = nowMs - 48 * HOUR_MS;
  const stalePending = db.prepare(
    'SELECT COUNT(*) AS c FROM pending_group_questions WHERE created_at < ?'
  ).get(staleBefore).c;
  if (stalePending > 0) {
    failures.push(`${stalePending} pending group question(s) unanswered >48h`);
  }

  const placeholders = SANCTIONED_RELATED_TO.map(() => '?').join(',');
  const junkGroups = db.prepare(
    `SELECT id, name, related_to FROM groups
      WHERE configured = 1 AND related_to IS NOT NULL
        AND related_to NOT IN (${placeholders})`
  ).all(...SANCTIONED_RELATED_TO);
  if (junkGroups.length > 0) {
    const list = junkGroups.map(g => `"${g.name}"→'${g.related_to}'`).join(', ');
    failures.push(`${junkGroups.length} configured group(s) with invalid related_to: ${list}`);
  }

  const ok = failures.length === 0;
  emitMetric('config_state_integrity', ok, {
    stalePending, junkGroups: junkGroups.length,
    ...(junkGroups.length ? { junk: junkGroups.map(g => ({ id: g.id, related_to: g.related_to })) } : {}),
  });
  return ok ? null : failures.join('; ');
}

/**
 * 6. Monitored-group silence (ISSUE-023) — a group configured as monitored with
 *    zero messages rows in 7+ days. Catches "configured but not actually flowing."
 */
function checkMonitoredGroupSilence(db, nowMs) {
  const sevenDaysAgo = nowMs - 7 * DAY_MS;
  const monitored = db.prepare(
    "SELECT id, name FROM groups WHERE monitored = 1"
  ).all();
  const silent = [];
  for (const g of monitored) {
    const last = db.prepare('SELECT MAX(timestamp) AS ts FROM messages WHERE group_id = ?').get(g.id);
    const lastTs = last && last.ts ? last.ts : 0;
    if (lastTs < sevenDaysAgo) {
      silent.push({ id: g.id, name: g.name, lastTs });
    }
  }
  const ok = silent.length === 0;
  emitMetric('monitored_group_silence', ok, {
    monitored: monitored.length, silent: silent.length,
    ...(silent.length ? { groups: silent.map(g => ({ name: g.name, lastTs: g.lastTs })) } : {}),
  });
  if (!ok) {
    const names = silent.map(g => `"${g.name}"`).join(', ');
    return `${silent.length} monitored group(s) silent 7+ days: ${names}`;
  }
  return null;
}

/**
 * Run all throughput/integrity checks. Returns an array of failure strings
 * (empty = all healthy). Each check emits its own metric line regardless.
 * @param {number} [nowMs] injectable clock for tests
 */
function runThroughputChecks(nowMs = Date.now()) {
  const db = getDB();
  const checks = [
    checkIngestionVolume,
    checkTerminalStateRate,
    checkMediaParseRate,
    checkDeliveryDuplicates,
    checkConfigStateIntegrity,
    checkMonitoredGroupSilence,
  ];
  const failures = [];
  for (const check of checks) {
    try {
      const failure = check(db, nowMs);
      if (failure) failures.push(failure);
    } catch (e) {
      logger.error({ component: 'HealthThroughput', check: check.name, err: e.message }, 'Throughput check errored');
      emitMetric(check.name, false, { error: e.message });
      failures.push(`${check.name} error: ${e.message}`);
    }
  }
  if (failures.length > 0) {
    logger.warn({ component: 'HealthThroughput', failures }, 'Throughput checks found issues');
  } else {
    logger.info({ component: 'HealthThroughput' }, 'All throughput checks passed');
  }
  return failures;
}

module.exports = {
  runThroughputChecks,
  emitMetric,
  METRICS_PATH,
  // exported for unit tests
  checkIngestionVolume,
  checkTerminalStateRate,
  checkMediaParseRate,
  checkDeliveryDuplicates,
  checkConfigStateIntegrity,
  checkMonitoredGroupSilence,
};
