/**
 * noticeDelivery.js — PURE FORMATTERS for master-group notice delivery.
 *
 * B1 / P-012: This module NO LONGER reads the notices queue and NO LONGER sends.
 * It exposes formatters that turn an explicit list of notices into WhatsApp text:
 *
 *   deliverBatch(notices, opts)  → { body, ids, clusterCount } | null   (digest)
 *   deliverImmediate(notice)     → string                               (one urgent notice)
 *   selectImmediate(notices)     → notices that qualify for immediate send
 *
 * triage-engine.js is the SINGLE process that reads the queue, applies the
 * guardrails (claim / 72h context / daily cap / dismissals / quiet hours), and
 * is the only sender. It invokes these formatters via TRIAGE_MODE=digest (07/12/16/20)
 * and TRIAGE_MODE=immediate (every 5 min). See PRINCIPLES.md P-012.
 *
 * Retained for reference / P-009: getPendingNotices (with its triage_decision
 * filter), the cluster gate inside deliverBatch, clusterNotices, getStuckNotices,
 * and the delivery-bookkeeping helpers.
 */

const { getDB } = require('./db');
const { normalizeNoticeContent } = require('./normalizer');
const { callLLM } = require('./llm');

function getDeliveryContent(notice) {
  // Belt-and-suspenders: normalize relative date words at delivery time
  // using source_timestamp as anchor. Catches notices saved before the
  // ingestion-time normalizer was deployed.
  if (!notice.content) return '';
  const anchorDate = notice.source_timestamp
    ? new Date(notice.source_timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' })
    : null;
  const { normalized } = normalizeNoticeContent(notice.content, anchorDate);
  // Day/date mismatch: prepend a warning, never mutate the source content.
  if (notice.weekday_mismatch === 1 && notice.validation_notes) {
    return `⚠️ ${notice.validation_notes}\n\n${normalized}`;
  }
  return normalized;
}

const ISRAEL_TZ = 'Asia/Jerusalem';

// ── DB helpers ─────────────────────────────────────────────────────────────

const MAX_DELIVERY_ATTEMPTS = 5;

function getPendingNotices(urgencyFilter = null) {
  // P-009: Exclude notices that triage already decided to skip or defer.
  // triage_decision IS NULL means not yet triaged — still eligible for batch delivery.
  // NOTE (P-012): this reader is retained for reference and for the P-009 check;
  // the live delivery path no longer calls it — triage-engine.js owns the queue read.
  let q = `SELECT * FROM notices WHERE delivery_status = 'pending' AND dismissed = 0
    AND (delivery_attempts IS NULL OR delivery_attempts < ${MAX_DELIVERY_ATTEMPTS})
    AND (triage_decision IS NULL OR triage_decision NOT IN ('skip', 'defer'))`;
  if (urgencyFilter) q += ` AND urgency_hint = ?`;
  q += ` ORDER BY created_at ASC`;
  return urgencyFilter
    ? getDB().prepare(q).all(urgencyFilter)
    : getDB().prepare(q).all();
}

function incrementAttempts(id) {
  const now = Date.now();
  getDB().prepare(
    `UPDATE notices SET delivery_attempts = COALESCE(delivery_attempts, 0) + 1, last_attempt_at = ? WHERE id = ?`
  ).run(now, id);
  const row = getDB().prepare('SELECT delivery_attempts FROM notices WHERE id = ?').get(id);
  if (row && row.delivery_attempts >= MAX_DELIVERY_ATTEMPTS) {
    getDB().prepare(`UPDATE notices SET delivery_status = 'dead_letter' WHERE id = ?`).run(id);
    console.warn(`[NoticeDelivery] Notice ${id} marked dead_letter after ${MAX_DELIVERY_ATTEMPTS} failed attempts`);
  }
}

function markDelivered(ids, status, batchId = null) {
  const now = Date.now();
  const placeholders = ids.map(() => '?').join(',');
  getDB().prepare(
    `UPDATE notices SET delivery_status = ?, delivered_at = ?, batch_id = ? WHERE id IN (${placeholders})`
  ).run(status, now, batchId, ...ids);
}

function saveBatch(sentAt, noticeCount, summaryText) {
  const result = getDB().prepare(
    'INSERT INTO notice_batches (sent_at, notice_count, summary_text) VALUES (?, ?, ?)'
  ).run(sentAt, noticeCount, summaryText);
  return result.lastInsertRowid;
}

// ── Time helpers ───────────────────────────────────────────────────────────

function israelHour() {
  return require('./timeUtils').getIsraelHour();
}

function isQuietHours() {
  const h = israelHour();
  return h >= 22 || h < 6;
}

// ── LLM summarization ──────────────────────────────────────────────────────

async function summarizeCluster(notices) {
  const lines = notices.map((n, i) =>
    `${i + 1}. [${n.group_name}] ${getDeliveryContent(n)}${n.relevance_time ? ' בשעה ' + n.relevance_time : ''}`
  ).join('\n');

  const prompt = `אתה מסכם הודעות לאסיסטנט משפחתי. הנה ${notices.length} הודעות קשורות מקבוצת "${notices[0].group_name}":

${lines}

כתוב סיכום תמציתי בעברית, משפט אחד עד שלושה. חובה: כלול את כל פרטי הפעולה — תשלומים, קישורים, אנשי קשר, מועדים, שעות. אסור להשמיט פרט שדורש פעולה. פלוט רק את הסיכום, ללא כותרות.`;

  // TASK 1.1: route through the provider-abstracted LLM (Anthropic → Gemini
  // fallback). Preserve the original resilience: on any failure, fall back to
  // the raw lines. Same 12s timeout / 200-token budget as before.
  try {
    const summary = await callLLM(prompt, { maxTokens: 200, timeout: 12000 });
    return summary && summary.trim() ? summary.trim() : lines;
  } catch (err) {
    console.warn('[NoticeDelivery] summarizeCluster LLM failed, using raw lines:', err.message);
    return lines;
  }
}

// ── Immediate delivery (formatter) ───────────────────────────────────────────

/**
 * deliverImmediate(notice) — PURE FORMATTER (B1 / P-012).
 *
 * Builds the single-notice immediate text for the master group. Reads nothing
 * and sends nothing: triage-engine.js (TRIAGE_MODE=immediate) owns the queue
 * read, the guardrails (dismissal / dedup / claim), and the actual send.
 *
 * Returns the WhatsApp-formatted message string.
 */
function deliverImmediate(notice) {
  const timeStr = notice.relevance_time ? ` (${notice.relevance_time})` : '';
  return `‏⚡ *${notice.group_name}:*\n${getDeliveryContent(notice)}${timeStr}`;
}

/**
 * selectImmediate(notices) — pure selector shared with triage's immediate drain.
 * Given a list of pending notices, returns those that qualify for immediate send:
 *   - urgency_hint='immediate', or
 *   - urgency_hint='time_sensitive' with relevant_datetime within 3h.
 * Reads nothing (the caller passes the notices).
 */
function selectImmediate(notices, now = Date.now()) {
  const THREE_HOURS = 3 * 3600000;
  return (notices || []).filter(n => {
    if (n.urgency_hint === 'immediate') return true;
    if (n.urgency_hint === 'time_sensitive' && n.relevant_datetime) {
      const diff = n.relevant_datetime - now;
      return diff > 0 && diff <= THREE_HOURS;
    }
    return false;
  });
}

// ── Batch delivery (formatter) ───────────────────────────────────────────────

/**
 * deliverBatch(notices, opts) — PURE FORMATTER (B1 / P-012).
 *
 * Builds the batched digest text from an EXPLICIT list of notices. Reads nothing
 * and sends nothing — triage-engine.js owns the queue read and the actual send.
 * Returns { body, ids, clusterCount } or null when there is nothing to send.
 *
 * opts.requireActionable (default false): apply the P-009 cluster gate that
 * rejects an all-FYI/undated batch. triage's digest drains already-triaged
 * 'defer' notices (noise was filtered upstream), so the gate is OFF by default;
 * it remains available to any caller that formats the raw untriaged queue.
 */
async function deliverBatch(notices, opts = {}) {
  const { requireActionable = false } = opts;
  if (!Array.isArray(notices) || notices.length === 0) return null;

  // Exclude anything that qualifies as immediate (handled by the immediate path).
  const now = Date.now();
  const THREE_HOURS = 3 * 3600000;
  const batchable = notices.filter(n => {
    if (n.urgency_hint === 'immediate') return false;
    if (n.urgency_hint === 'time_sensitive' && n.relevant_datetime) {
      const diff = n.relevant_datetime - now;
      if (diff > 0 && diff <= THREE_HOURS) return false; // leave for immediate
    }
    return true;
  });
  if (batchable.length === 0) return null;

  // P-009 Cluster gate (opt-in): require at least one actionable notice before
  // sending. A notice is actionable if it has a known urgency or a relevance date.
  // Pure FYI chatter (no dates, no urgency) is not worth a batch send.
  if (requireActionable) {
    const hasActionable = batchable.some(n =>
      n.urgency_hint === 'immediate' ||
      n.urgency_hint === 'time_sensitive' ||
      n.relevance_date != null
    );
    if (!hasActionable) {
      console.log('[NoticeDelivery] Cluster gate: 0 actionable notices — skipping batch (all FYI/undated)');
      return null;
    }
  }

  // Cluster by group_name + notices within 2h of each other.
  const clusters = clusterNotices(batchable);

  const lines = [];
  for (const cluster of clusters) {
    if (cluster.length === 1) {
      const n = cluster[0];
      const timeStr = n.relevance_time ? ` (${n.relevance_time})` : '';
      lines.push(`• *${n.group_name}:* ${getDeliveryContent(n)}${timeStr}`);
    } else {
      // LLM summarize
      const summary = await summarizeCluster(cluster);
      const count = cluster.length;
      lines.push(`• *${cluster[0].group_name}* (${count} הודעות): ${summary}`);
    }
  }

  if (lines.length === 0) return null;

  const header = `‏💡 *עדכונים — ${new Date().toLocaleDateString('he-IL', { timeZone: ISRAEL_TZ, weekday: 'short', day: 'numeric', month: 'numeric' })}*`;
  const body = header + '\n\n' + lines.join('\n');

  return { body, ids: batchable.map(n => n.id), clusterCount: clusters.length };
}

// ── Clustering ─────────────────────────────────────────────────────────────

function clusterNotices(notices) {
  const TWO_HOURS = 2 * 3600 * 1000;
  const byGroup = {};
  for (const n of notices) {
    if (!byGroup[n.group_name]) byGroup[n.group_name] = [];
    byGroup[n.group_name].push(n);
  }

  const clusters = [];
  for (const group of Object.values(byGroup)) {
    // Sort by source_timestamp
    group.sort((a, b) => (a.source_timestamp || 0) - (b.source_timestamp || 0));
    // Split into time-window sub-clusters
    let current = [group[0]];
    for (let i = 1; i < group.length; i++) {
      const prev = group[i - 1].source_timestamp || 0;
      const curr = group[i].source_timestamp || 0;
      if (curr - prev <= TWO_HOURS) {
        current.push(group[i]);
      } else {
        clusters.push(current);
        current = [group[i]];
      }
    }
    clusters.push(current);
  }
  return clusters;
}

// ── Watchdog ───────────────────────────────────────────────────────────────

/**
 * Returns notices stuck in pending for more than maxAgeMs.
 * Call from heartbeat to detect silent delivery failures.
 */
function getStuckNotices(maxAgeMs = 8 * 3600000) {
  const cutoff = Date.now() - maxAgeMs;
  return getDB().prepare(
    `SELECT * FROM notices WHERE delivery_status = 'pending' AND dismissed = 0 AND created_at < ?`
  ).all(cutoff);
}

// ── After-delivery calendar hook ─────────────────────────────────────────────
// Runs asynchronously after each delivery pass to create calendar entries
// for any dated event notices. Fire-and-forget: failures are logged and
// will be retried by the heartbeat sweeper. Invoked by triage after a send.
async function afterDeliveryHook(noticeIds) {
  if (!noticeIds || noticeIds.length === 0) return;
  try {
    const { createCalendarForNotice } = require('./calendar-bridge');
    const db = getDB();
    const placeholders = noticeIds.map(() => '?').join(',');
    const notices = db.prepare(
      `SELECT * FROM notices WHERE id IN (${placeholders})`
    ).all(...noticeIds);
    for (const notice of notices) {
      try {
        const r = await createCalendarForNotice(notice);
        if (r.status !== 'skipped') {
          console.log(`[NoticeDelivery] Calendar hook: notice #${notice.id} → ${r.status}`);
        }
      } catch (err) {
        console.error(`[NoticeDelivery] Calendar hook error for notice #${notice.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[NoticeDelivery] afterDeliveryHook load error:', err.message);
  }
}

module.exports = {
  // Formatters (B1 / P-012) — triage invokes these; they never read or send.
  deliverImmediate,
  deliverBatch,
  selectImmediate,
  // Helpers retained for triage bookkeeping / watchdog / P-009 reference.
  getPendingNotices,
  markDelivered,
  incrementAttempts,
  saveBatch,
  clusterNotices,
  getStuckNotices,
  afterDeliveryHook,
  isQuietHours,
};
