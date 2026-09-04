#!/usr/bin/env node
/**
 * feedback-to-gold.js — Generate gold-set candidates from user feedback.
 *
 * Reads 'bad' feedback from notice_feedback, traces back to the original
 * message, and outputs candidate JSONL rows for manual review.
 *
 * Usage:
 *   node scripts/feedback-to-gold.js              # all bad feedback
 *   node scripts/feedback-to-gold.js --since 7    # last 7 days only
 *
 * Output goes to stdout as JSONL. Review, label, then import:
 *   node scripts/feedback-to-gold.js > candidates.jsonl
 *   # Manually add expected_action to each row
 *   # Then append to tests/eval/dataset.jsonl
 */

'use strict';

const { initDB, getDB } = require('../src/db');

initDB();
const db = getDB();

const sinceDays = process.argv.includes('--since')
  ? parseInt(process.argv[process.argv.indexOf('--since') + 1], 10) || 30
  : 30;

const cutoff = Date.now() - sinceDays * 86400000;

const feedbacks = db.prepare(`
  SELECT nf.*, n.group_name, n.content, n.source_message_ids, n.relevance_date
  FROM notice_feedback nf
  LEFT JOIN notices n ON n.id = nf.notice_id
  WHERE nf.feedback = 'bad'
    AND nf.created_at > ?
  ORDER BY nf.created_at DESC
`).all(cutoff);

if (feedbacks.length === 0) {
  console.error(`[feedback-to-gold] No 'bad' feedback in the last ${sinceDays} days.`);
  process.exit(0);
}

console.error(`[feedback-to-gold] Found ${feedbacks.length} 'bad' feedback entries`);

for (const fb of feedbacks) {
  // Try to find the original message
  let originalMsg = null;
  if (fb.source_message_ids) {
    try {
      const ids = JSON.parse(fb.source_message_ids);
      if (Array.isArray(ids) && ids.length > 0) {
        originalMsg = db.prepare('SELECT id, group_id, sender, body, timestamp FROM messages WHERE id = ?').get(ids[0]);
      }
    } catch (_) {}
  }

  const candidate = {
    // For dataset.jsonl format
    id: originalMsg?.id || fb.notice_id,
    group_id: originalMsg?.group_id || null,
    sender: originalMsg?.sender || null,
    body: originalMsg?.body || fb.content || '',
    timestamp: originalMsg?.timestamp || fb.created_at,
    pipeline_state: 'NOTICE_CREATED',
    notice: {
      content: fb.content,
      group_name: fb.group_name,
      relevance_date: fb.relevance_date,
    },
    label: {
      expected_action: '???', // MUST BE FILLED BY HUMAN
      priority: 'unknown',
      category: 'unknown',
      confidence: 1.0,
      reasoning: `Bad feedback (${fb.comment || 'no comment'}) — needs human label`,
    },
    label_source: 'human_feedback',
    labeled_by: 'feedback_candidate',
    feedback: {
      notice_id: fb.notice_id,
      comment: fb.comment,
      created_at: fb.created_at,
    },
    exported_at: new Date().toISOString(),
  };

  // Output as JSONL to stdout
  console.log(JSON.stringify(candidate));
}

console.error(`[feedback-to-gold] Output ${feedbacks.length} candidates. Review and set expected_action before importing.`);
