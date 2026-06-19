'use strict';
/**
 * send-unposted-notices.js
 *
 * Queries unposted notices from the DB, classifies them in a single batched
 * model call, and sends actionable ones to the master WhatsApp group.
 *
 * Design principles (per architecture review 2026-06-02):
 *  - Script orchestrates; model only classifies
 *  - All notices batched into ONE model call (not per-notice)
 *  - On model failure: retry with backoff, never fall back to keyword guessing
 *  - Rate limit: max 5 messages to group per hour
 *  - mark send_attempted_at BEFORE sending, sent_to_master=1 only after confirmation
 */

process.chdir(__dirname);
require('dotenv').config();

const { initDB, getDB } = require('./src/db');
const https = require('https');
const fs = require('fs');
const path = require('path');

const GROUP_JID = '120363426994367917@g.us';
const RATE_FILE = path.join(__dirname, 'data', 'send-rate.json');
const MAX_PER_HOUR = 5;
const MODEL_TIMEOUT_MS = 25000;
const MAX_RETRIES = 2;

// ─── Rate limiting ────────────────────────────────────────────────────────────

function loadRateState() {
  try {
    return JSON.parse(fs.readFileSync(RATE_FILE, 'utf8'));
  } catch {
    return { sends: [] };
  }
}

function saveRateState(state) {
  fs.writeFileSync(RATE_FILE, JSON.stringify(state), 'utf8');
}

function checkRateLimit() {
  const state = loadRateState();
  const oneHourAgo = Date.now() - 3600000;
  state.sends = (state.sends || []).filter(ts => ts > oneHourAgo);
  const remaining = MAX_PER_HOUR - state.sends.length;
  return { remaining, state };
}

function recordSend(state) {
  state.sends.push(Date.now());
  saveRateState(state);
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

function queryUnpostedNotices(db) {
  const tzOffset = 3; // Israel GMT+3
  const israelNow = new Date(Date.now() + tzOffset * 3600000);
  const todayStr = israelNow.toISOString().slice(0, 10);
  // Look 14 days ahead to catch sign-up sheets for future events
  const cutoff = new Date(israelNow);
  cutoff.setDate(cutoff.getDate() + 14);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  return db.prepare(`
    SELECT id, group_name, content, relevance_date, relevance_time, created_at
    FROM notices
    WHERE dismissed = 0
      AND posted_to_master = 0
      AND relevance_date >= ?
      AND relevance_date <= ?
    ORDER BY relevance_date ASC, relevance_time ASC
  `).all(todayStr, cutoffStr);
}

function markAttempted(db, id) {
  db.prepare(`UPDATE notices SET send_attempted_at = datetime('now') WHERE id = ?`).run(id);
}

function markSent(db, id) {
  db.prepare(`UPDATE notices SET posted_to_master = 1, sent_to_master = 1 WHERE id = ?`).run(id);
}

function markSkipped(db, id) {
  db.prepare(`UPDATE notices SET posted_to_master = 1 WHERE id = ?`).run(id);
}

// ─── Send via WhatsApp ────────────────────────────────────────────────────────

const { sendMessage: _voiceSend } = require('./lib/voice-client');
function sendToGroup(text) {
  return _voiceSend(GROUP_JID, text).then(() => true);
}

// ─── Anthropic API call ───────────────────────────────────────────────────────

function callAnthropic(prompt, retries = MAX_RETRIES) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return reject(new Error('ANTHROPIC_API_KEY not set'));

    const body = JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.[0]?.text;
          if (!text) return reject(new Error('Empty model response: ' + data));
          resolve(text);
        } catch (e) {
          reject(new Error('Parse error: ' + e.message));
        }
      });
    });

    req.setTimeout(MODEL_TIMEOUT_MS, () => {
      req.destroy();
      if (retries > 0) {
        console.error(`[Classifier] Model timeout, retrying (${retries} left)...`);
        setTimeout(() => callAnthropic(prompt, retries - 1).then(resolve).catch(reject), 3000);
      } else {
        reject(new Error('Model timed out after retries'));
      }
    });

    req.on('error', err => {
      if (retries > 0) {
        console.error(`[Classifier] API error (${err.message}), retrying...`);
        setTimeout(() => callAnthropic(prompt, retries - 1).then(resolve).catch(reject), 3000);
      } else {
        reject(err);
      }
    });

    req.write(body);
    req.end();
  });
}

// ─── Classify notices in one batch ───────────────────────────────────────────

async function classifyNotices(notices) {
  const tzOffset = 3;
  const israelNow = new Date(Date.now() + tzOffset * 3600000);
  const todayStr = israelNow.toISOString().slice(0, 10);

  const noticesList = notices.map((n, i) =>
    `[${i + 1}] Group: ${n.group_name}\n    Date: ${n.relevance_date || 'unspecified'}  Time: ${n.relevance_time || 'unspecified'}\n    Content: ${n.content}`
  ).join('\n\n');

  const prompt = `You are a classifier for a family WhatsApp assistant. Today is ${todayStr} (Israel time).

Family context:
- Aviv (dad) + Liat (mom), 4 kids: Segev (6th grade), Nevo (3rd grade), Neta (gan kochav), Yarden (gan tzavar/צבר)
- You monitor school, kindergarten, sports, and after-school groups

For each notice below, decide: SEND or SKIP.

SEND if ANY of these are true:
- Requires action today or tomorrow (payment, bring something, RSVP, permission slip)
- Contains sign-up / registration language — even if the event is next week (slots fill fast)
- Has a link to sign up (Google Docs, Paybox, etc.)
- Limited slots or first-come-first-served signals
- Schedule change affecting today or tomorrow (cancelled, rescheduled, different time)
- Something the kids need to bring or do soon

SKIP if:
- Construction/house updates (בית בסינסקי-רשפים) — skip unless life/safety
- Past events (already happened)
- Low-stakes optional items (generic volunteering invitations with no urgency)
- Pure chit-chat or reactions
- Duplicate of something already obvious

Respond in this exact format (one line per notice, nothing else):
1: SEND | <one short reason in English>
2: SKIP | <one short reason in English>
...etc

Notices:
${noticesList}`;

  const response = await callAnthropic(prompt);

  // Parse response
  const results = {};
  for (const line of response.trim().split('\n')) {
    const match = line.match(/^(\d+):\s*(SEND|SKIP)\s*\|?\s*(.*)$/i);
    if (match) {
      const idx = parseInt(match[1]) - 1;
      if (idx >= 0 && idx < notices.length) {
        results[notices[idx].id] = {
          action: match[2].toUpperCase(),
          reason: match[3].trim(),
        };
      }
    }
  }

  // Any notice not in results defaults to SKIP (safe default)
  for (const n of notices) {
    if (!results[n.id]) {
      results[n.id] = { action: 'SKIP', reason: 'not classified by model' };
    }
  }

  return results;
}

// ─── Format message ───────────────────────────────────────────────────────────

function formatMessage(notice) {
  let msg = `‏💡 *${notice.group_name}:*\n${notice.content}`;
  if (notice.relevance_time) {
    msg += `\n⏰ ${notice.relevance_time}`;
  }
  return msg;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  initDB();
  const db = getDB();

  const notices = queryUnpostedNotices(db);

  if (notices.length === 0) {
    console.log('DONE (nothing to post)');
    return;
  }

  console.log(`Found ${notices.length} unposted notice(s). Classifying...`);

  // Classify all at once
  let classifications;
  try {
    classifications = await classifyNotices(notices);
  } catch (err) {
    console.error(`[Classifier] Failed after retries: ${err.message}`);
    console.log(`DONE (classifier failed — notices NOT skipped, will retry next run)`);
    // Do NOT mark anything — they'll be picked up next run
    process.exit(0);
  }

  // Log classification results
  for (const n of notices) {
    const c = classifications[n.id];
    console.log(`  [${c.action}] #${n.id} ${n.group_name}: ${c.reason}`);
  }

  const toSend = notices.filter(n => classifications[n.id]?.action === 'SEND');
  const toSkip = notices.filter(n => classifications[n.id]?.action === 'SKIP');

  // Check rate limit
  const { remaining, state } = checkRateLimit();
  if (toSend.length > 0 && remaining <= 0) {
    console.log(`Rate limit reached (${MAX_PER_HOUR}/hr). Will retry next run.`);
    // Don't mark anything, they'll be picked up next poll
    console.log(`DONE (rate limited)`);
    return;
  }

  // Mark skipped
  for (const n of toSkip) {
    markSkipped(db, n.id);
  }

  // Send approved notices (up to rate limit)
  let sent = 0;
  let failed = 0;
  for (const n of toSend) {
    if (sent >= remaining) {
      console.log(`Rate limit reached mid-batch. Stopping at ${sent} sent.`);
      break;
    }
    const msg = formatMessage(n);
    markAttempted(db, n.id);
    try {
      await sendToGroup(msg);
      markSent(db, n.id);
      recordSend(state);
      sent++;
      console.log(`  ✅ Sent #${n.id}`);
    } catch (err) {
      failed++;
      console.error(`  ❌ Failed to send #${n.id}: ${err.message}`);
      // send_attempted_at is set but sent_to_master stays 0 — audit job will catch it
    }
  }

  console.log(`DONE — sent: ${sent}, skipped: ${toSkip.length}, failed: ${failed}`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
