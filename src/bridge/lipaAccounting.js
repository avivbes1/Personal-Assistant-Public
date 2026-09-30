'use strict';
/**
 * bridge/lipaAccounting.js — advisory cost accounting for the Lipa lane.
 *
 * This is deliberately SEPARATE from the billing circuit breaker in
 * lipaReliability.js. The breaker reacts to REAL provider billing errors (a 402 /
 * insufficient_credits). This module instead tracks a conservative LOWER-BOUND
 * dollar estimate per request and enforces two soft controls:
 *
 *   - a DAILY cap ($20): blocks NEW launches for the rest of the Jerusalem day
 *     once the day's recorded lower-bound spend reaches the cap. It never kills
 *     an in-flight request — the poll gate consults it before claiming.
 *   - a per-REQUEST cap ($2): flags a request for a post-completion alert. It is
 *     advisory only: the response is still delivered, nothing is blocked or retried.
 *
 * The estimate is a lower bound: when the provider reports a real cost we store
 * that; otherwise we derive from whatever token counts we have (missing tokens
 * count as 0, so the stored number never overstates spend). When cost AND all
 * token counts are unknown we store cost_usd_lower_bound = NULL and flag the row
 * cost_unknown = 1, so "unknown" is never silently counted as $0 in forensics
 * (though getDailySpend, summing SQL, naturally treats NULL as contributing 0).
 */

const { israelDateIso } = require('../timeUtils');

function db() {
  return require('../db').getDB();
}

// ── model-specific rates — dollars per 1M tokens ───────────────────────
// Rates are keyed by model prefix. When the model is unknown, we use the most
// expensive rates (Opus) so the bound is genuinely conservative.
const MODEL_RATES = {
  'opus':   { input: 15.0,  output: 75.0,  cacheRead: 1.50  },
  'sonnet': { input: 3.0,   output: 15.0,  cacheRead: 0.30  },
  'haiku':  { input: 0.80,  output: 4.0,   cacheRead: 0.08  },
  'flash':  { input: 0.15,  output: 0.60,  cacheRead: 0.0375 },
};
const DEFAULT_RATES = MODEL_RATES.opus; // most expensive = conservative bound
const MTOK = 1_000_000;

/** Resolve rates for a model string. Falls back to Opus (most expensive). */
function ratesForModel(model) {
  if (!model) return DEFAULT_RATES;
  const m = String(model).toLowerCase();
  for (const [key, rates] of Object.entries(MODEL_RATES)) {
    if (m.includes(key)) return rates;
  }
  return DEFAULT_RATES;
}
// Legacy exports for backward compat (Opus rates)
const USD_PER_MTOK_INPUT = DEFAULT_RATES.input;
const USD_PER_MTOK_OUTPUT = DEFAULT_RATES.output;
const USD_PER_MTOK_CACHE_READ = DEFAULT_RATES.cacheRead;

// ── caps ─────────────────────────────────────────────────────────────────────
const DAILY_CAP_USD = 20;
const REQUEST_CAP_USD = 2;

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

/**
 * Lower-bound dollar estimate from token counts using model-specific rates.
 * Missing counts are treated as 0 (keeps it a lower bound). Cache-write tokens
 * are excluded (no provider charges for writes separately in current pricing).
 * Returns { cost, partial } where partial=true if ANY expected token count is
 * missing (so callers know the estimate is incomplete). Returns { cost: null }
 * when NO token count is known.
 */
function estimateFromTokens({ inputTokens, outputTokens, cacheReadTokens, model } = {}) {
  const inp = num(inputTokens), out = num(outputTokens), cr = num(cacheReadTokens);
  if (inp == null && out == null && cr == null) return { cost: null, partial: false };
  const rates = ratesForModel(model);
  const partial = (inp == null || out == null); // missing a major token class
  const cost = ((inp || 0) * rates.input
              + (out || 0) * rates.output
              + (cr  || 0) * rates.cacheRead) / MTOK;
  return { cost, partial };
}

/**
 * Record the (lower-bound) cost of one request. If costUsd is provided it is
 * used verbatim; otherwise it is derived from tokens. If both are unknown the
 * row stores cost_usd_lower_bound = NULL and cost_unknown = 1.
 * Returns { id, cost, unknown } — cost is the number used (null when unknown).
 */
function recordRequestCost({ inboxId, inputTokens, outputTokens, cacheReadTokens,
                             cacheWriteTokens, model, costUsd, now = Date.now() } = {}) {
  let cost = num(costUsd);
  let partialUsage = false;
  if (cost == null) {
    const est = estimateFromTokens({ inputTokens, outputTokens, cacheReadTokens, model });
    cost = est.cost;
    partialUsage = est.partial;
  }
  // unknown = true when we have NO cost info at all (no costUsd, no tokens)
  // partial usage (some tokens known, some not) still gets cost_unknown=1
  // because the estimate is incomplete and could significantly understate spend.
  const unknown = cost == null || partialUsage;
  const res = db().prepare(
    `INSERT INTO bridge_lipa_costs
       (inbox_id, model, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, cost_usd_lower_bound, cost_unknown, recorded_at, date_jerusalem)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    inboxId == null ? null : inboxId, model || null,
    num(inputTokens), num(outputTokens), num(cacheReadTokens), num(cacheWriteTokens),
    unknown ? null : cost, unknown ? 1 : 0, now, israelDateIso(new Date(now))
  );
  return { id: res.lastInsertRowid, cost: unknown ? null : cost, unknown };
}

/**
 * Total recorded lower-bound spend for a Jerusalem calendar day (default today).
 * NULL (unknown) rows contribute 0 to the SUM.
 */
function getDailySpend(dateStr, now = Date.now()) {
  const day = dateStr || israelDateIso(new Date(now));
  const row = db().prepare(
    'SELECT COALESCE(SUM(cost_usd_lower_bound), 0) AS spend FROM bridge_lipa_costs WHERE date_jerusalem = ?'
  ).get(day);
  return row ? row.spend : 0;
}

/**
 * Soft daily cap. blocked = today's recorded lower-bound spend >= $20.
 * Fails CLOSED on any DB read error: returns blocked:true so new launches are
 * gated until accounting is healthy again.
 */
function checkDailyCap(now = Date.now()) {
  try {
    const spend = getDailySpend(null, now);
    return { blocked: spend >= DAILY_CAP_USD, spend, cap: DAILY_CAP_USD };
  } catch (e) {
    console.error('[Lipa accounting] checkDailyCap read error (fail closed):', e.message);
    return { blocked: true, spend: 0, cap: DAILY_CAP_USD, error: e.message };
  }
}

/**
 * Per-request cap. Advisory only — flags for an alert, never blocks or retries.
 * When inboxId is provided, sums cost_usd_lower_bound across ALL cost rows for
 * that inbox_id (cumulative across retries/attempts), so a row that costs $1 on
 * each of 3 attempts correctly triggers the $2 threshold on the 3rd attempt.
 * Falls back to the supplied cost estimate when no inboxId or DB lookup fails.
 *
 * @param {{ inboxId?: number, cost?: number } | number} opts
 *   Legacy signature (plain number) still accepted for backward compat.
 */
function checkRequestCap(opts) {
  // Accept legacy plain-number signature
  if (typeof opts === 'number' || opts == null) {
    const cost = num(opts) || 0;
    return { alert: cost >= REQUEST_CAP_USD, cost, cap: REQUEST_CAP_USD };
  }
  const { inboxId, cost: costHint } = opts;
  let total = num(costHint) || 0;
  if (inboxId != null) {
    try {
      const row = db().prepare(
        'SELECT COALESCE(SUM(cost_usd_lower_bound), 0) AS s FROM bridge_lipa_costs WHERE inbox_id = ?'
      ).get(inboxId);
      total = row ? (row.s || 0) : total;
    } catch (e) {
      console.error('[Lipa accounting] checkRequestCap cumulative lookup failed, using estimate:', e.message);
    }
  }
  return { alert: total >= REQUEST_CAP_USD, cost: total, cap: REQUEST_CAP_USD };
}

module.exports = {
  USD_PER_MTOK_INPUT, USD_PER_MTOK_OUTPUT, USD_PER_MTOK_CACHE_READ,
  MODEL_RATES, DEFAULT_RATES, ratesForModel,
  DAILY_CAP_USD, REQUEST_CAP_USD,
  estimateFromTokens, recordRequestCost, getDailySpend, checkDailyCap, checkRequestCap,
};
