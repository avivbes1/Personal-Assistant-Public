/**
 * src/llm/index.js — LLM provider abstraction.
 *
 * Usage:
 *   const llm = require('./llm');
 *   const { text } = await llm.complete({ system, messages, model, maxTokens });
 *
 * Provider selection: LLM_PROVIDER env var (default: anthropic)
 *   anthropic — Claude via Anthropic API (default)
 *   mock      — Deterministic, no network (for tests)
 *
 * Token budget: checked before every call, charged after.
 * Set TOKEN_LIMIT_DAILY env var to override (default: 200,000).
 */

const budget = require('./budget');

const PROVIDERS = {
  anthropic: () => require('./anthropic'),
  mock:      () => require('./mock'),
};

function getProvider() {
  const name = process.env.LLM_PROVIDER ?? 'anthropic';
  const factory = PROVIDERS[name];
  if (!factory) throw new Error(`[LLM] Unknown provider: "${name}". Valid: ${Object.keys(PROVIDERS).join(', ')}`);
  return factory();
}

/**
 * Run a completion through the configured provider with budget tracking.
 *
 * @param {object} opts
 * @param {string}  opts.system     - System prompt
 * @param {Array}   opts.messages   - [{role, content}]
 * @param {string}  [opts.model]    - Model override
 * @param {number}  [opts.maxTokens=1024]
 * @param {boolean} [opts.skipBudget=false] - Bypass budget check (use sparingly)
 * @returns {Promise<{text: string, inputTokens: number, outputTokens: number}>}
 */
async function complete(opts) {
  const maxTokens = opts.maxTokens ?? 1024;

  if (!opts.skipBudget) budget.check(maxTokens);

  const provider = getProvider();
  const result = await provider.complete({ ...opts, maxTokens });

  budget.charge(result.inputTokens + result.outputTokens);

  return result;
}

module.exports = { complete, budget };
