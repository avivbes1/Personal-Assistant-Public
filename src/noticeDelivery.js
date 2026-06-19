/**
 * noticeDelivery.js
 * Two-tier notice delivery system:
 *
 * IMMEDIATE: every 5 min — picks up urgent/time_sensitive notices that are
 *   genuinely actionable now. Sends one per message, immediately.
 *
 * BATCH: 07:00, 12:30, 16:00, 20:00 Israel time (via cron) — collects all
 *   pending routine notices, clusters by group+time, LLM-summarizes clusters
 *   with 2+ items, sends as ONE message. Never sends between 22:00-06:30.
 *
 * Safeguards:
 *   - delivery_status flips to delivered_* ONLY after WhatsApp send confirmed
 *   - LLM summary preserves all action items (payment links, contacts, deadlines)
 *   - time_sensitive notices re-evaluated at delivery: if relevant_datetime
 *     is within 3h → treat as immediate
 */

const https = require('https');
const { getDB } = require('./db');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ISRAEL_TZ = 'Asia/Jerusalem';

// ── DB helpers ─────────────────────────────────────────────────────────────

const MAX_DELIVERY_ATTEMPTS = 5;

function getPendingNotices(urgencyFilter = null) {
  let q = `SELECT * FROM notices WHERE delivery_status = 'pending' AND dismissed = 0 AND (delivery_attempts IS NULL OR delivery_attempts < ${MAX_DELIVERY_ATTEMPTS})`;
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
  return parseInt(new Date().toLocaleString('en-US', { timeZone: ISRAEL_TZ, hour: 'numeric', hour12: false }), 10);
}

function isQuietHours() {
  const h = israelHour();
  return h >= 22 || h < 6;
}

// ── LLM summarization ──────────────────────────────────────────────────────

async function summarizeCluster(notices) {
  const lines = notices.map((n, i) =>
    `${i + 1}. [${n.group_name}] ${n.content}${n.relevance_time ? ' בשעה ' + n.relevance_time : ''}`
  ).join('\n');

  const prompt = `אתה מסכם הודעות לאסיסטנט משפחתי. הנה ${notices.length} הודעות קשורות מקבוצת "${notices[0].group_name}":

${lines}

כתוב סיכום תמציתי בעברית, משפט אחד עד שלושה. חובה: כלול את כל פרטי הפעולה — תשלומים, קישורים, אנשי קשר, מועדים, שעות. אסור להשמיט פרט שדורש פעולה. פלוט רק את הסיכום, ללא כותרות.`;

  return new Promise((resolve) => {
    const bodyStr = JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          resolve(r.content?.[0]?.text?.trim() || lines);
        } catch {
          resolve(lines); // fallback: raw lines
        }
      });
    });
    req.on('error', () => resolve(lines));
    req.write(bodyStr);
    req.end();
  });
}

// ── Immediate delivery ─────────────────────────────────────────────────────

/**
 * Called every 5 minutes by the cron job.
 * Picks up: urgency_hint='immediate' notices
 *           + time_sensitive notices where relevant_datetime is within 3h
 */
async function deliverImmediate(sendFn) {
  const all = getPendingNotices();
  const now = Date.now();
  const THREE_HOURS = 3 * 3600000;

  const urgent = all.filter(n => {
    if (n.urgency_hint === 'immediate') return true;
    if (n.urgency_hint === 'time_sensitive' && n.relevant_datetime) {
      const diff = n.relevant_datetime - now;
      return diff > 0 && diff <= THREE_HOURS;
    }
    return false;
  });

  if (urgent.length === 0) return;

  console.log(`[NoticeDelivery] ${urgent.length} urgent notice(s) to send immediately`);

  for (const notice of urgent) {
    const timeStr = notice.relevance_time ? ` (${notice.relevance_time})` : '';
    const text = `\u200f⚡ *${notice.group_name}:*\n${notice.content}${timeStr}`;
    try {
      await sendFn(text);
      markDelivered([notice.id], 'delivered_immediate');
      console.log(`[NoticeDelivery] Immediate: "${notice.content.substring(0, 50)}"`);
    } catch (err) {
      console.error(`[NoticeDelivery] Failed to send immediate notice ${notice.id}:`, err.message);
      incrementAttempts(notice.id);
    }
  }
}

// ── Batch delivery ─────────────────────────────────────────────────────────

/**
 * Called at batch windows: 07:00, 12:30, 16:00, 20:00 Israel time.
 * Collects all pending routine + time_sensitive (not yet urgent) notices,
 * clusters by group, LLM-summarizes clusters, sends as one message.
 */
async function deliverBatch(sendFn) {
  if (isQuietHours()) {
    console.log('[NoticeDelivery] Quiet hours — skipping batch');
    return;
  }

  const all = getPendingNotices();
  // Exclude anything that qualifies as immediate (handled by the other cron)
  const now = Date.now();
  const THREE_HOURS = 3 * 3600000;
  const batchable = all.filter(n => {
    if (n.urgency_hint === 'immediate') return false;
    if (n.urgency_hint === 'time_sensitive' && n.relevant_datetime) {
      const diff = n.relevant_datetime - now;
      if (diff > 0 && diff <= THREE_HOURS) return false; // leave for immediate
    }
    return true;
  });

  if (batchable.length === 0) {
    console.log('[NoticeDelivery] No pending notices for batch');
    return;
  }

  console.log(`[NoticeDelivery] Batch: ${batchable.length} notices to process`);

  // Cluster by group_name + notices within 2h of each other
  const clusters = clusterNotices(batchable);

  const lines = [];
  for (const cluster of clusters) {
    if (cluster.length === 1) {
      const n = cluster[0];
      const timeStr = n.relevance_time ? ` (${n.relevance_time})` : '';
      lines.push(`• *${n.group_name}:* ${n.content}${timeStr}`);
    } else {
      // LLM summarize
      const summary = await summarizeCluster(cluster);
      const count = cluster.length;
      lines.push(`• *${cluster[0].group_name}* (${count} הודעות): ${summary}`);
    }
  }

  if (lines.length === 0) return;

  const header = `\u200f💡 *עדכונים — ${new Date().toLocaleDateString('he-IL', { timeZone: ISRAEL_TZ, weekday: 'short', day: 'numeric', month: 'numeric' })}*`;
  const body = header + '\n\n' + lines.join('\n');

  try {
    await sendFn(body);
    const batchId = saveBatch(now, batchable.length, body);
    markDelivered(batchable.map(n => n.id), 'delivered_batch', batchId);
    console.log(`[NoticeDelivery] Batch delivered: ${batchable.length} notices, ${clusters.length} clusters`);
  } catch (err) {
    console.error('[NoticeDelivery] Batch send failed:', err.message);
    for (const n of batchable) incrementAttempts(n.id);
  }
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

module.exports = { deliverImmediate, deliverBatch, getStuckNotices };
