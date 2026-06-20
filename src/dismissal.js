'use strict';
/**
 * dismissal.js — "Stop sending about X" command handler.
 *
 * Flow:
 *   1. DISMISSAL_REGEX matches message in master group
 *   2. parseDismssal() calls Haiku to extract scope (topic/group/all) + duration
 *   3. storeDismissal() writes to topic_dismissals table
 *   4. During triage: getActiveDismissals() + isTopicDismissed() suppress matching notices
 */

const https = require('https');
const { getDB } = require('./db');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── Regex gate (fast, no LLM cost on every message) ──────────────────────────

const DISMISSAL_REGEX = /תפסיק|תפסיקי|תפסיקו|הפסק|הפסיקי|stop\b|אל תשלח|אל תעדכן|אל תודיע|בלי עוד|מספיק|שתוק|רגע שקט|silence\b|ignore\b|dismiss\b/i;

// ── Haiku parser ───────────────────────────────────────────────────────────────

const DISMISSAL_SYSTEM = `You parse dismissal commands sent to a WhatsApp family assistant bot.
The bot sends updates about family group chats to a "master group".
Return JSON only — no explanation, no markdown:
{
  "is_dismissal": true|false,
  "scope_type": "topic_key"|"source_group"|"all",
  "scope_hint": "<short topic or group name, or null>",
  "duration_hours": <number, default 48>
}

Scope rules:
- "topic_key": user mentions a specific topic (movie, soccer, trip, gift, ...)
- "source_group": user mentions a specific class/group (כיתה ו, גן כוכב, ...)
- "all": user wants everything quiet (מספיק, שקט, stop everything)
- duration_hours: extract if mentioned ("for 24 hours" → 24, "tomorrow" → 24, "week" → 168), else 48`;

function callHaiku(system, user) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          resolve(r.content?.[0]?.text?.trim() || '');
        } catch (e) { reject(new Error('Haiku parse error: ' + e.message)); }
      });
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Haiku timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Parse a dismissal command message.
 * @param {string} messageBody — the raw WhatsApp message
 * @param {Array} sentRecent — recent sent_messages rows (for topic_key matching)
 * @returns {object} parsed result with is_dismissal, scope_type, scope_hint, duration_hours
 */
async function parseDismissal(messageBody, sentRecent) {
  const recentTopics = sentRecent.slice(-8).map(s =>
    `topic_key="${s.topic_key}" preview="${s.message_text.substring(0, 80)}"`
  ).join('\n');

  const userPrompt = `User message: "${messageBody}"

Recent topics sent by the bot:
${recentTopics || '(none)'}

Return JSON only:`;

  const raw = await callHaiku(DISMISSAL_SYSTEM, userPrompt);

  // Extract JSON block
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in dismissal response: ' + raw.substring(0, 100));

  const parsed = JSON.parse(match[0]);

  // Match scope_hint to an actual topic_key from recent sends (fuzzy)
  // SAFETY: only match if the scope_hint keywords also appear in the raw command
  // (prevents Haiku from matching an unrelated topic from recent sends)
  if (parsed.is_dismissal && parsed.scope_type === 'topic_key' && parsed.scope_hint && sentRecent.length > 0) {
    const hint = parsed.scope_hint.toLowerCase();
    const hintWords = hint.split(/[s-]+/).filter(w => w.length > 2);

    // Validate: scope_hint keywords must appear in the raw command
    const hintAppearsInCommand = hintWords.some(w =>
      messageBody.toLowerCase().includes(w) ||
      // Allow transliterated keywords: English 'movie' in Hebrew 'סרט' context
      (w === 'movie' && /סרט|קולנוע|cinema/.test(messageBody)) ||
      (w === 'soccer' && /כדורגל/.test(messageBody)) ||
      (w === 'trip' && /טיול|יציאה/.test(messageBody))
    );

    if (!hintAppearsInCommand) {
      console.warn('[Dismissal] MISMATCH: scope_hint= + parsed.scope_hint +  does not appear in raw command  + messageBody.substring(0, 80) +  — clearing topic_key match');
      // Fall back to storing as generic group dismissal or skip topic matching
      parsed.scope_type = 'all'; // safe fallback: suppress everything for 1h
      parsed.duration_hours = 1;
      parsed.scope_hint = null;
      console.warn('[Dismissal] Falling back to all-suppress for 1h due to mismatch');
    } else {
      const match = sentRecent.slice().reverse().find(s =>
        s.topic_key.toLowerCase().split('-').some(word => hint.includes(word) || word.includes(hint.split(' ')[0])) ||
        s.message_text.toLowerCase().includes(hint.split(' ')[0])
      );
      if (match) {
        parsed.matched_topic_key = match.topic_key;
      }
    }
  }

  console.log('[Dismissal] Final parse result:', JSON.stringify(parsed));
  return parsed;
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

/**
 * Store a dismissal. scope_value for topic_key = topic_key string,
 * for source_group = group name substring, for all = null.
 */
function storeDismissal(dismissedBy, scopeType, scopeValue, durationHours, rawCommand) {
  const db = getDB();
  const now = Date.now();
  db.prepare(`
    INSERT INTO topic_dismissals (dismissed_by, scope_type, scope_value, dismissed_at, expires_at, raw_command)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(dismissedBy, scopeType, scopeValue || null, now, now + durationHours * 3600000, rawCommand);
  console.log(`[Dismissal] Stored: type=${scopeType} value="${scopeValue}" for ${durationHours}h by ${dismissedBy}`);
}

/**
 * Fetch all non-expired dismissals.
 */
function getActiveDismissals() {
  try {
    return getDB().prepare('SELECT * FROM topic_dismissals WHERE expires_at > ?').all(Date.now());
  } catch (e) {
    // Table may not exist yet on first deploy — return empty
    console.warn('[Dismissal] getActiveDismissals error:', e.message);
    return [];
  }
}

/**
 * Check if a notice should be suppressed by an active dismissal.
 * @param {Array} dismissals — from getActiveDismissals()
 * @param {string|null} topicKey — the merged topic_key for this notice
 * @param {string|null} groupName — the source group name
 */
function isTopicDismissed(dismissals, topicKey, groupName) {
  for (const d of dismissals) {
    if (d.scope_type === 'all') return true;
    if (d.scope_type === 'topic_key' && topicKey && d.scope_value) {
      // Match on topic_key prefix/contains OR the matched_topic_key from parsing
      if (topicKey === d.scope_value || topicKey.includes(d.scope_value) || d.scope_value.includes(topicKey.split('-')[0])) return true;
    }
    if (d.scope_type === 'source_group' && groupName && d.scope_value) {
      if (groupName.includes(d.scope_value) || d.scope_value.includes(groupName.substring(0, 8))) return true;
    }
  }
  return false;
}

module.exports = { DISMISSAL_REGEX, parseDismissal, storeDismissal, getActiveDismissals, isTopicDismissed };
