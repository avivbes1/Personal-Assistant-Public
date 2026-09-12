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
// Resolve the write target at call time so tests can isolate it via
// FAMILYBOT_METRICS_PATH (same convention as FAMILYBOT_DB_PATH) and never append
// to the live trend file.
function metricsWritePath() {
  return process.env.FAMILYBOT_METRICS_PATH || METRICS_PATH;
}

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
  const p = metricsWritePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(row) + '\n');
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
  // Join to groups so the alert names the group and tells the user what to do,
  // instead of surfacing a bare count with no actionable target.
  const stalePendingRows = db.prepare(
    `SELECT pgq.group_id AS group_id, g.name AS name
       FROM pending_group_questions pgq
       LEFT JOIN groups g ON g.id = pgq.group_id
      WHERE pgq.created_at < ?`
  ).all(staleBefore);
  const stalePending = stalePendingRows.length;
  for (const row of stalePendingRows) {
    const label = row.name || row.group_id;
    failures.push(`קבוצה ${label} ממתינה לסיווג — שלח "לעקוב" או "להתעלם"`);
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
    // lastTs === 0 means the group never received any messages — that's a
    // setup issue (bot added but never got traffic), not a "went silent"
    // problem. Skip it; only alert for groups that WERE active but stopped.
    if (lastTs === 0) continue;
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
    // Hebrew alert with a recommended action — the bot may simply not be in
    // these groups anymore, so tell the user how to stop monitoring them.
    const bullets = silent.map(g => `• ${g.name}`).join('\n');
    return `${silent.length} קבוצות מנוטרות ללא הודעות 7+ ימים — ייתכן שהבוט לא נמצא בהן:\n${bullets}\n` +
      `להסיר מניטור? שלח "הפסק לעקוב אחרי [שם]"`;
  }
  return null;
}

/**
 * Run all throughput/integrity checks. Returns an array of failure strings
 * (empty = all healthy). Each check emits its own metric line regardless.
 * @param {number} [nowMs] injectable clock for tests
 */
// ── K1: Job heartbeat dead-man's-switch ──────────────────────────────────
// P-021: Absence of a heartbeat is an alert. "Nothing to do" ≠ "ran successfully."

const JOB_EXPECTED_INTERVALS = {
  runTriage:    { maxMs: 30 * 60 * 1000, maxEmpty: 48 },  // every 15min, alert at 30min; 48 empty = 12h
  runImmediate: { maxMs: 15 * 60 * 1000, maxEmpty: 96 },  // every 5min, alert at 15min; 96 empty = 8h
  runDigest:    { maxMs: 8 * HOUR_MS,    maxEmpty: 20 },   // 4x/day, alert at 8h; 20 empty = 5 days
};

/**
 * K1: Check that all registered jobs have recent heartbeats.
 * Alerts on: (a) no heartbeat ever, (b) last heartbeat too old, (c) too many
 * consecutive empty runs.
 */
function checkJobHeartbeats(db, nowMs) {
  const hour = getIsraelHour(nowMs);
  if (hour < 7 || hour >= 23) return null; // quiet hours

  let heartbeats;
  try {
    heartbeats = db.prepare('SELECT * FROM job_runs').all();
  } catch (_) {
    // Table doesn't exist yet — first run after migration
    return null;
  }
  const byName = new Map(heartbeats.map(h => [h.job_name, h]));
  const issues = [];

  for (const [job, { maxMs, maxEmpty }] of Object.entries(JOB_EXPECTED_INTERVALS)) {
    const hb = byName.get(job);
    if (!hb) {
      issues.push(`${job}: no heartbeat ever recorded`);
      continue;
    }
    const age = nowMs - hb.last_success_ms;
    if (age > maxMs) {
      issues.push(`${job}: last heartbeat ${Math.round(age / 60000)}min ago (max ${Math.round(maxMs / 60000)}min)`);
    }
    if (hb.consecutive_empty >= maxEmpty) {
      issues.push(`${job}: ${hb.consecutive_empty} consecutive empty runs (max ${maxEmpty})`);
    }
  }

  const ok = issues.length === 0;
  emitMetric('job_heartbeats', ok, { issues });
  return ok ? null : `job_heartbeats: ${issues.join('; ')}`;
}

// ── K2: Delivery throughput checks ──────────────────────────────────────────
// These catch the Sept 2–12 outage class: notices flow IN but nothing goes OUT.

/**
 * K2.1 Stale pending — notices stuck pending for > 2h during daytime.
 * A non-zero count means the delivery pipeline isn't draining.
 */
function checkStalePending(db, nowMs) {
  const hour = getIsraelHour(nowMs);
  if (hour < 8 || hour >= 23) return null; // quiet hours
  const cutoff = nowMs - 2 * HOUR_MS;
  const row = db.prepare(
    `SELECT COUNT(*) as cnt, MIN(created_at) as oldest FROM notices
     WHERE delivery_status = 'pending' AND dismissed = 0 AND created_at < ?`
  ).get(cutoff);
  const ok = row.cnt <= 3; // small threshold — a few stragglers are normal
  const oldestAge = row.oldest ? Math.round((nowMs - row.oldest) / HOUR_MS) : 0;
  emitMetric('stale_pending', ok, { count: row.cnt, oldest_age_h: oldestAge });
  if (!ok) {
    return `stale_pending: ${row.cnt} notice(s) pending for >${oldestAge}h (oldest created_at=${row.oldest})`;
  }
  return null;
}

/**
 * K2.2 Created-vs-delivered ratio — over 24h, notices created vs delivered.
 * A ratio near zero with non-zero creation is the exact outage signature.
 */
function checkDeliveryRatio(db, nowMs) {
  const hour = getIsraelHour(nowMs);
  if (hour < 10 || hour >= 23) return null; // need a full day window
  const cutoff = nowMs - DAY_MS;
  const created = db.prepare(
    'SELECT COUNT(*) as cnt FROM notices WHERE created_at > ?'
  ).get(cutoff).cnt;
  const delivered = db.prepare(
    `SELECT COUNT(*) as cnt FROM notices
     WHERE delivered_at > ? AND delivery_status IN ('delivered_batch','delivered_immediate')`
  ).get(cutoff).cnt;
  if (created < 3) {
    emitMetric('delivery_ratio', true, { created, delivered, ratio: null, note: 'too_few_to_judge' });
    return null; // not enough data
  }
  const ratio = delivered / created;
  const ok = ratio > 0.05; // at least 5% delivered
  emitMetric('delivery_ratio', ok, { created, delivered, ratio: Math.round(ratio * 100) / 100 });
  if (!ok) {
    return `delivery_ratio: ${delivered}/${created} notices delivered in 24h (ratio=${(ratio * 100).toFixed(1)}%)`;
  }
  return null;
}

/**
 * K2.3 Untriaged age — oldest notice with no triage_decision during daytime.
 * This is the single number that would have caught the runTriage gap on day 1.
 */
function checkUntriagedAge(db, nowMs) {
  const hour = getIsraelHour(nowMs);
  if (hour < 8 || hour >= 23) return null;
  const row = db.prepare(
    `SELECT MIN(created_at) as oldest, COUNT(*) as cnt FROM notices
     WHERE triage_decision IS NULL AND dismissed = 0 AND posted_to_master = 0
     AND delivery_status = 'pending'`
  ).get();
  if (!row.oldest || row.cnt === 0) {
    emitMetric('untriaged_age', true, { count: 0 });
    return null;
  }
  const ageH = Math.round((nowMs - row.oldest) / HOUR_MS);
  const ok = ageH < 4; // 4 hours max — runTriage should fire every 15 min
  emitMetric('untriaged_age', ok, { count: row.cnt, oldest_age_h: ageH });
  if (!ok) {
    return `untriaged_age: ${row.cnt} untriaged notice(s), oldest ${ageH}h ago`;
  }
  return null;
}

function runThroughputChecks(nowMs = Date.now()) {
  const db = getDB();
  const checks = [
    checkIngestionVolume,
    checkTerminalStateRate,
    checkMediaParseRate,
    checkDeliveryDuplicates,
    checkConfigStateIntegrity,
    checkMonitoredGroupSilence,
    checkJobHeartbeats,
    checkStalePending,
    checkDeliveryRatio,
    checkUntriagedAge,
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
  checkJobHeartbeats,
  checkStalePending,
  checkDeliveryRatio,
  checkUntriagedAge,
};
