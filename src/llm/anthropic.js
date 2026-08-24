/**
 * anthropic.js — Anthropic (Claude) LLM provider.
 */

const https = require('https');

const API_KEY = process.env.ANTHROPIC_API_KEY;

/**
 * Complete a prompt using Anthropic Claude.
 * @param {object} opts
 * @param {string} opts.system     - System prompt
 * @param {Array}  opts.messages   - Message array [{role, content}]
 * @param {string} opts.model      - Model ID (default: claude-haiku-4-5)
 * @param {number} opts.maxTokens
 * @param {Array}  [opts.tools]      - Optional tool definitions (enables tool-calling)
 * @param {object} [opts.toolChoice] - Optional tool_choice (e.g. {type:'any'})
 * @returns {Promise<{text: string, content: Array, stopReason: string|null, inputTokens: number, outputTokens: number}>}
 */
async function complete({ system, messages, model = 'claude-haiku-4-5', maxTokens = 1024, tools, toolChoice }) {
  if (!API_KEY) throw new Error('[LLM/anthropic] ANTHROPIC_API_KEY not set');

  const payload = {
    model,
    max_tokens: maxTokens,
    system,
    messages,
  };
  if (tools) payload.tools = tools;
  if (toolChoice) payload.tool_choice = toolChoice;
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
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
          if (r.error) return reject(new Error(`[LLM/anthropic] ${r.error.message}`));
          resolve({
            text: r.content?.[0]?.text ?? '',
            content: r.content ?? [],
            stopReason: r.stop_reason ?? null,
            inputTokens:  r.usage?.input_tokens  ?? 0,
            outputTokens: r.usage?.output_tokens ?? 0,
          });
        } catch (e) {
          reject(new Error(`[LLM/anthropic] Parse error: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { complete };
