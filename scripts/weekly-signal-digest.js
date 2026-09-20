#!/usr/bin/env node
/**
 * R7: Weekly signal digest — surfaces collected-but-unread queues.
 * Designed to run as a cron agentTurn job, posting to the master group.
 *
 * Reads: grounding_misses, query_misses, blocked_actions, notice_feedback,
 *        weekday-corrected notices, obligation nudges (missed), and
 *        self-improving maintenance liveness.
 */

'use strict';

const { initDB, getDB } = require('../src/db');

function safeCount(db, sql, params = []) {
  try {
    const row = db.prepare(sql).get(...params);
    return row ? (row.cnt || 0) : 0;
  } catch (_) { return 'N/A'; }
}

function run() {
  initDB();
  const db = getDB();

  const weekAgo = Date.now() - 7 * 86400000;

  const groundingMisses = safeCount(db,
    'SELECT COUNT(*) as cnt FROM grounding_misses WHERE created_at > ?', [weekAgo]);

  const queryMisses = safeCount(db,
    'SELECT COUNT(*) as cnt FROM query_misses WHERE created_at > ?', [weekAgo]);

  const blockedActions = safeCount(db,
    'SELECT COUNT(*) as cnt FROM blocked_actions WHERE created_at > ?', [weekAgo]);

  const negativeFeedback = safeCount(db,
    "SELECT COUNT(*) as cnt FROM notice_feedback WHERE feedback='negative' AND created_at > ?", [weekAgo]);

  const weekdayCorrected = safeCount(db,
    "SELECT COUNT(*) as cnt FROM notices WHERE relevance_date_source='weekday_corrected' AND created_at > ?", [weekAgo]);

  const nudgesMissed = safeCount(db,
    "SELECT COUNT(*) as cnt FROM obligation_nudges WHERE status='missed'");

  const nudgesSent = safeCount(db,
    "SELECT COUNT(*) as cnt FROM obligation_nudges WHERE status='sent' AND sent_at > ?", [weekAgo]);

  const totalNotices = safeCount(db,
    'SELECT COUNT(*) as cnt FROM notices WHERE created_at > ?', [weekAgo]);

  const deliveredNotices = safeCount(db,
    "SELECT COUNT(*) as cnt FROM notices WHERE delivery_status='delivered' AND created_at > ?", [weekAgo]);

  // Self-improving maintenance liveness
  let maintenanceAge = 'unknown';
  try {
    const fs = require('fs');
    const content = fs.readFileSync('/home/ubuntu/self-improving/heartbeat-state.md', 'utf8');
    const m = content.match(/last_maintenance:\s*(\d{4}-\d{2}-\d{2})/);
    if (m) {
      const days = Math.round((Date.now() - new Date(m[1] + 'T12:00:00+03:00').getTime()) / 86400000);
      maintenanceAge = `${days}d ago (${m[1]})`;
    }
  } catch (_) {}

  const lines = [
    '📊 *דוח שבועי — אותות איכות*',
    '',
    `📥 notices השבוע: ${totalNotices} (${deliveredNotices} delivered)`,
    `📅 weekday corrections: ${weekdayCorrected}`,
    `⏰ nudges sent: ${nudgesSent} | missed: ${nudgesMissed}`,
    `🚫 blocked actions: ${blockedActions}`,
    `❌ grounding misses: ${groundingMisses}`,
    `🔍 query misses: ${queryMisses}`,
    `👎 negative feedback: ${negativeFeedback}`,
    `🧠 self-improving maintenance: ${maintenanceAge}`,
  ];

  // Flag anything that needs attention
  const flags = [];
  if (groundingMisses > 0) flags.push(`${groundingMisses} grounding miss(es) — review source claims`);
  if (nudgesMissed > 0) flags.push(`${nudgesMissed} nudge(s) missed — sweep may not be running reliably`);
  if (negativeFeedback > 0) flags.push(`${negativeFeedback} negative reaction(s) — review delivery quality`);

  if (flags.length) {
    lines.push('', '⚠️ *דורש תשומת לב:*');
    flags.forEach(f => lines.push(`• ${f}`));
  }

  console.log(lines.join('\n'));
}

run();
