/**
 * gemini.js — Google Gemini LLM provider (fallback for Anthropic).
 *
 * Thin raw-HTTPS client. Used by fallback.js when the Anthropic call fails
 * (e.g. credit exhaustion). Returns a plain string, same shape as callAnthropic.
 */

const https = require('https');

const GEMINI_MODEL = 'gemini-2.5-flash';

/**
 * Complete a prompt using Gemini.
 * @param {string} prompt
 * @param {object} [opts]
 * @param {number} [opts.maxTokens=300]
 * @param {number} [opts.timeout=12000]
 * @returns {Promise<string>} generated text
 */
function complete(prompt, { maxTokens = 300, timeout = 12000 } = {}) {
  const key = process.env.GEMINI_API_KEY;
  return new Promise((resolve, reject) => {
    if (!key) return reject(new Error('[LLM/gemini] GEMINI_API_KEY not set'));

    const bodyStr = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    });

    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
      method: 'POST',
      timeout,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          if (r.error) return reject(new Error(`[LLM/gemini] ${r.error.message || 'API error'}`));
          const text = (r.candidates?.[0]?.content?.parts || [])
            .map(p => p.text || '')
            .join('')
            .trim();
          resolve(text);
        } catch (e) {
          reject(new Error(`[LLM/gemini] parse error: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('[LLM/gemini] timeout')); });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

module.exports = { complete, GEMINI_MODEL };
