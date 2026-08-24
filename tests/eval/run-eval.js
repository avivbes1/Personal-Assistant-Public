#!/usr/bin/env node
/**
 * run-eval.js — Lightweight eval runner for the classification pipeline.
 *
 * Runs labeled messages through the same LLM+tools pipeline as agent.js
 * and compares results to bootstrap labels.
 *
 * Usage:
 *   node tests/eval/run-eval.js              # full eval (costs tokens)
 *   node tests/eval/run-eval.js --dry-run    # validate dataset only
 *   node tests/eval/run-eval.js --limit 20   # eval 20 messages
 *   node tests/eval/run-eval.js --model claude-haiku-4-5  # specific model
 */

const path = require('path');
const fs = require('fs');

// Load env before any src/ imports
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const DATASET_PATH = path.join(__dirname, 'dataset.jsonl');
const RESULTS_PATH = path.join(__dirname, 'eval-results.json');

// Parse args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : Infinity;
const modelIdx = args.indexOf('--model');
const model = modelIdx >= 0 ? args[modelIdx + 1] : 'claude-haiku-4-5';
const threshold = 0.70;

function loadDataset() {
  const lines = fs.readFileSync(DATASET_PATH, 'utf8').split('\n').filter(Boolean);
  return lines.map(l => JSON.parse(l));
}

// Map label.expected_action to what tool the model should call
function labelToTool(label) {
  if (!label) return 'unknown';
  const action = label.expected_action;
  if (['add_notice', 'add_event', 'send_now', 'defer'].includes(action)) return 'add_notice';
  if (['skip', 'none'].includes(action)) return 'no_action';
  return 'unknown';
}

// Map pipeline_state to expected tool
function pipelineToTool(state) {
  if (state === 'NOTICE_CREATED') return 'add_notice';
  if (state === 'NOT_ACTIONABLE' || state === 'RECEIVED') return 'no_action';
  return 'unknown';
}

async function callClassifier(msg, modelId) {
  const anthropic = require('../../src/llm/anthropic');

  const systemPrompt = `אתה עוזר משפחתי אוטומטי שמנטר קבוצות WhatsApp.
קבוצה: "${msg.group_id}"
שולח: ${msg.sender}

עליך לקרוא לאחד מהכלים הבאים - תמיד:
- add_notice: אם ההודעה מכילה מידע רלוונטי למשפחה
- no_action: אם ההודעה אינה רלוונטית למשפחה כלל`;

  // Use raw HTTPS to match agent.js behavior with tool calling
  const https = require('https');
  const body = JSON.stringify({
    model: modelId,
    max_tokens: 1024,
    system: systemPrompt,
    tools: [
      {
        name: 'add_notice',
        description: 'ההודעה מכילה מידע רלוונטי למשפחה.',
        input_schema: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            urgency_hint: { type: 'string', enum: ['immediate', 'time_sensitive', 'routine'] }
          },
          required: ['content']
        }
      },
      {
        name: 'no_action',
        description: 'ההודעה לא רלוונטית למשפחה.',
        input_schema: {
          type: 'object',
          properties: { reason: { type: 'string' } },
          required: ['reason']
        }
      }
    ],
    tool_choice: { type: 'any' },
    messages: [{ role: 'user', content: msg.body || '[media message without text]' }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
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
          if (r.error) return reject(new Error(r.error.message));
          const toolUse = r.content?.find(c => c.type === 'tool_use');
          resolve({
            tool: toolUse?.name || 'none',
            input: toolUse?.input || {},
            inputTokens: r.usage?.input_tokens || 0,
            outputTokens: r.usage?.output_tokens || 0,
          });
        } catch (e) {
          reject(new Error('Parse error: ' + data.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const records = loadDataset();
  console.log(`[eval] Dataset: ${records.length} messages`);

  if (dryRun) {
    // Validate dataset
    let valid = 0, invalid = 0;
    const issues = [];
    records.forEach((r, i) => {
      if (!r.id || !r.body === undefined || !r.pipeline_state) {
        issues.push(`Line ${i + 1}: missing required fields`);
        invalid++;
      } else if (!r.label) {
        issues.push(`Line ${i + 1}: missing label`);
        invalid++;
      } else {
        valid++;
      }
    });
    console.log(`[eval] Valid: ${valid}, Invalid: ${invalid}`);
    if (issues.length > 0) console.log('[eval] Issues:', issues.slice(0, 10).join('\n  '));

    // Distribution check
    const dist = {};
    records.forEach(r => {
      if (r.label) {
        dist[r.label.expected_action] = (dist[r.label.expected_action] || 0) + 1;
      }
    });
    console.log('[eval] Label distribution:', JSON.stringify(dist));
    process.exit(invalid > 0 ? 1 : 0);
  }

  // Full eval
  const sample = records.slice(0, Math.min(limit, records.length));
  console.log(`[eval] Running ${sample.length} messages against model: ${model}`);

  const results = [];
  let correct = 0, total = 0, errors = 0;
  let totalInputTokens = 0, totalOutputTokens = 0;

  // Confusion matrix: expected → predicted
  const confusion = {};

  for (let i = 0; i < sample.length; i++) {
    const msg = sample[i];
    const expectedTool = labelToTool(msg.label);

    if (!msg.body || msg.body.trim() === '') {
      // Skip empty/media-only messages
      results.push({ id: msg.id, skipped: true, reason: 'empty_body' });
      continue;
    }

    try {
      const result = await callClassifier(msg, model);
      const predictedTool = result.tool;
      const match = predictedTool === expectedTool;

      if (match) correct++;
      total++;

      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;

      // Confusion matrix
      if (!confusion[expectedTool]) confusion[expectedTool] = {};
      confusion[expectedTool][predictedTool] = (confusion[expectedTool][predictedTool] || 0) + 1;

      results.push({
        id: msg.id,
        expected: expectedTool,
        predicted: predictedTool,
        match,
        urgency: result.input.urgency_hint,
        tokens: { input: result.inputTokens, output: result.outputTokens }
      });

      if ((i + 1) % 25 === 0) {
        const acc = total > 0 ? (correct / total * 100).toFixed(1) : 0;
        console.log(`[eval] ${i + 1}/${sample.length} — accuracy: ${acc}% (${errors} errors)`);
      }

      await sleep(200); // rate limit
    } catch (e) {
      errors++;
      results.push({ id: msg.id, error: e.message });
    }
  }

  const accuracy = total > 0 ? correct / total : 0;
  const skipped = results.filter(r => r.skipped).length;

  // Per-class precision/recall
  const classes = ['add_notice', 'no_action'];
  const metrics = {};
  for (const cls of classes) {
    const tp = confusion[cls]?.[cls] || 0;
    const fp = Object.entries(confusion).reduce((s, [exp, preds]) =>
      exp !== cls ? s + (preds[cls] || 0) : s, 0);
    const fn = Object.entries(confusion[cls] || {}).reduce((s, [pred, cnt]) =>
      pred !== cls ? s + cnt : s, 0);
    metrics[cls] = {
      precision: tp + fp > 0 ? (tp / (tp + fp)).toFixed(3) : 'N/A',
      recall: tp + fn > 0 ? (tp / (tp + fn)).toFixed(3) : 'N/A',
      f1: tp + fp > 0 && tp + fn > 0
        ? (2 * tp / (2 * tp + fp + fn)).toFixed(3)
        : 'N/A',
      tp, fp, fn
    };
  }

  const costInput = totalInputTokens / 1e6 * 1; // Haiku: $1/M input
  const costOutput = totalOutputTokens / 1e6 * 5; // Haiku: $5/M output
  const totalCost = costInput + costOutput;

  const report = {
    model,
    timestamp: new Date().toISOString(),
    total: sample.length,
    evaluated: total,
    skipped,
    errors,
    correct,
    accuracy: parseFloat(accuracy.toFixed(4)),
    accuracyPct: parseFloat((accuracy * 100).toFixed(1)),
    threshold: threshold * 100,
    pass: accuracy >= threshold,
    confusion,
    metrics,
    tokens: { input: totalInputTokens, output: totalOutputTokens },
    costUsd: parseFloat(totalCost.toFixed(4))
  };

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(report, null, 2));
  console.log('\n[eval] === RESULTS ===');
  console.log(`Model: ${model}`);
  console.log(`Evaluated: ${total} (skipped: ${skipped}, errors: ${errors})`);
  console.log(`Accuracy: ${report.accuracyPct}% (threshold: ${threshold * 100}%)`);
  console.log(`Pass: ${report.pass ? '✅' : '❌'}`);
  console.log('\nPer-class metrics:');
  for (const [cls, m] of Object.entries(metrics)) {
    console.log(`  ${cls}: P=${m.precision} R=${m.recall} F1=${m.f1} (TP=${m.tp} FP=${m.fp} FN=${m.fn})`);
  }
  console.log(`\nCost: $${totalCost.toFixed(4)} (${totalInputTokens} in / ${totalOutputTokens} out)`);
  console.log(`\nResults saved to ${RESULTS_PATH}`);

  process.exit(report.pass ? 0 : 1);
}

main().catch(e => {
  console.error('[eval] Fatal:', e.message);
  process.exit(1);
});
