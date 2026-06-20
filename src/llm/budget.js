/**
 * budget.js — Daily token budget guard.
 * Prevents runaway LLM costs from malicious messages or bugs.
 */

const DAILY_LIMIT = Number(process.env.TOKEN_LIMIT_DAILY ?? 200_000);

// In-memory cache: { 'YYYY-MM-DD': tokensUsed }
const cache = new Map();

function today() {
  return new Date().toISOString().slice(0, 10);
}

function getUsage() {
  return cache.get(today()) ?? 0;
}

function check(estimated = 1024) {
  const current = getUsage();
  if (current + estimated > DAILY_LIMIT) {
    throw new Error(
      `[LLM] Daily token budget exceeded (${current}/${DAILY_LIMIT}). ` +
      `Resets at midnight UTC. Set TOKEN_LIMIT_DAILY env var to adjust.`
    );
  }
}

function charge(tokensUsed) {
  const day = today();
  cache.set(day, (cache.get(day) ?? 0) + tokensUsed);
}

function status() {
  return { used: getUsage(), limit: DAILY_LIMIT, remaining: DAILY_LIMIT - getUsage() };
}

module.exports = { check, charge, status };
