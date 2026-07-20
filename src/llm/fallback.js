/**
 * fallback.js — Thin LLM wrapper with Gemini fallback when Anthropic fails.
 *
 * Used by noticeDelivery.js (and any other bot code needing a simple
 * prompt → text call) that must keep working when Anthropic credits run out.
 *
 * This is intentionally independent of index.js's router/budget path: it's the
 * resilient "just get me a summary" helper. It tries Anthropic first, and on
 * ANY failure falls back to Gemini. When the Anthropic failure looks like credit
 * exhaustion, it writes /tmp/anthropic-credit-alert.json so the heartbeat (Lipa)
 * can DM Aviv — see TASK 1.2 and HEARTBEAT.md (Check B1c).
 *
 * Reached via `require('./llm').callLLM` (re-exported from index.js).
 */

const https = require('https');
const fs = require('fs');
const gemini = require('./gemini');

const ANTHROPIC_MODEL = 'claude-haiku-4-5';
const CREDIT_ALERT_FILE = '/tmp/anthropic-credit-alert.json';

/**
 * Complete a prompt, preferring Anthropic and falling back to Gemini.
 * @param {string} prompt
 * @param {object} [opts]
 * @param {number} [opts.maxTokens=300]
 * @param {number} [opts.timeout=12000]
 * @returns {Promise<string>} generated text
 */
async function callLLM(prompt, { maxTokens = 300, timeout = 12000 } = {}) {
  try {
    return await callAnthropic(prompt, { maxTokens, timeout });
  } catch (err) {
    console.warn('[LLM] Anthropic failed, trying Gemini fallback:', err.message);
    return await callGemini(prompt, { maxTokens, timeout });
  }
}

function callGemini(prompt, opts) {
  return gemini.complete(prompt, opts);
}

/**
 * Raw Anthropic Messages API call (moved from noticeDelivery.summarizeCluster).
 * Detects credit exhaustion (402/529 or "credit balance"/"insufficient_funds"
 * in the body) and writes a watchdog alert file before rejecting.
 */
function callAnthropic(prompt, { maxTokens = 300, timeout = 12000 } = {}) {
  const API_KEY = process.env.ANTHROPIC_API_KEY;
  return new Promise((resolve, reject) => {
    if (!API_KEY) return reject(new Error('ANTHROPIC_API_KEY not set'));

    const bodyStr = JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      timeout,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        // Credit exhaustion detection (TASK 1.2)
        const status = res.statusCode;
        if (status === 402 || status === 529 || /credit balance|insufficient_funds/i.test(data)) {
          const err = new Error(`Anthropic credit error (status ${status})`);
          writeCreditAlert(err.message);
          return reject(err);
        }
        try {
          const r = JSON.parse(data);
          if (r.error) return reject(new Error(`[LLM/anthropic] ${r.error.message || 'API error'}`));
          resolve((r.content?.[0]?.text || '').trim());
        } catch (e) {
          reject(new Error(`[LLM/anthropic] parse error: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('[LLM/anthropic] timeout')); });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function writeCreditAlert(errMessage) {
  try {
    fs.writeFileSync(CREDIT_ALERT_FILE, JSON.stringify({
      ts: Date.now(),
      message: 'Anthropic credits exhausted',
      error: String(errMessage).slice(0, 300),
    }));
    console.error('[LLM] Anthropic credit exhaustion detected — wrote', CREDIT_ALERT_FILE);
  } catch (e) {
    console.error('[LLM] Failed to write credit alert file:', e.message);
  }
}

module.exports = { callLLM, callAnthropic, callGemini, CREDIT_ALERT_FILE };
