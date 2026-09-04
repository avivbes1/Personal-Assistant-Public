'use strict';
/**
 * router.js — Claude Code routing layer.
 *
 * Sits between the caller and the Anthropic API.
 * When CC_ENABLED=true, classifies each call and routes eligible ones
 * through Claude Code first, falling back to direct API on failure.
 *
 * In-memory sticky routing: once a thread is routed, follow-ups go same way.
 * Stickiness lost on process restart — acceptable. Re-classify cleanly.
 *
 * CC_ENABLED=false  → passthrough, zero overhead
 * CC_LOG_ONLY=true  → classify and log, but always use direct API (dark launch)
 *
 * ── C6: Claude Code terms-of-use & the token-reporting gap ──────────────────────
 *
 * POLICY FINDING (Sep 2026). Claude Code authenticates against an Anthropic
 * consumer subscription (Pro/Max). That path is governed by the Consumer Terms
 * of Service + Usage Policy — oriented to *interactive, individual* use — NOT the
 * Commercial Terms that cover the metered API. Sources to verify manually (a live
 * fetch was blocked in the build environment, so this reflects the terms as known
 * at authorship — re-check before relying on it):
 *   • https://www.anthropic.com/legal/consumer-terms
 *   • https://www.anthropic.com/legal/usage-policy
 *   • https://www.anthropic.com/legal/commercial-terms   (the sanctioned API path)
 *   • Claude Code / subscription docs at https://docs.claude.com/en/docs/claude-code
 *
 * Reading:
 *   • INTERACTIVE operator use — Aviv, from his own DM, asking Claude Code to
 *     investigate/refactor/research — is squarely the intended use of a Max
 *     subscription. This is fine.
 *   • Driving AUTOMATED PRODUCTION traffic (the message-classification / triage /
 *     heartbeat pipeline, running unattended around the clock over third-party
 *     family-group messages) through the subscription is a GRAY AREA at best and
 *     likely outside the intended terms. Programmatic/production workloads belong
 *     on the API under the Commercial Terms. Subscription rate limits and
 *     anti-abuse measures assume a human-in-the-loop session, not a service.
 *
 *   Because the distinction is genuinely ambiguous, CC routing of non-interactive
 *   traffic is gated behind CC_PRODUCTION_TRAFFIC (default OFF — see below). The
 *   existing classifier already hard-excludes production sources (heartbeat,
 *   triage, calendar, …) and only routes source==='aviv_dm'; this flag is a
 *   belt-and-suspenders guard should that allowlist ever widen.
 *
 * ZERO-TOKEN REPORTING GAP. A successful CC call returns inputTokens:0 /
 * outputTokens:0 (the work is covered by the subscription, not billed per token).
 * Consequences to be aware of:
 *   • budget.charge() adds 0 for CC calls, so they are INVISIBLE to
 *     TOKEN_LIMIT_DAILY — CC usage is effectively uncapped by the daily budget
 *     guardrail that protects against runaway spend/loops.
 *   • Any token/cost dashboard fed by traceCall/budget will UNDERCOUNT real model
 *     usage by exactly the CC share.
 *   This is a second, independent reason to keep automated production traffic on
 *   the metered API path: the API path is the one the spend guardrail can see.
 *
 * CONFIG:
 *   CC_ENABLED=false            → passthrough, zero overhead
 *   CC_LOG_ONLY=true            → classify + log, always use direct API (dark launch)
 *   CC_PRODUCTION_TRAFFIC=false → (default) CC may serve ONLY interactive sources
 *                                 (aviv_dm). Any CC-classified call from a
 *                                 non-interactive/production source is downgraded
 *                                 to the direct API and logged. Set to 'true' only
 *                                 if/when production CC use is confirmed in-terms.
 */

const { classify }        = require('./classifier');
const { CircuitBreaker }  = require('./circuit-breaker');
const ccRunner            = require('./claude-code/runner');
const fs                  = require('fs');
const path                = require('path');
const crypto              = require('crypto');

const LOG_FILE   = path.join(__dirname, '../../data/cc-router.jsonl');
const STICKY_TTL = 15 * 60 * 1000; // 15 minutes

// C6: sources considered INTERACTIVE (a human operator awaiting a reply). Only
// these may use Claude Code when CC_PRODUCTION_TRAFFIC is off (the default).
// Everything else — triage/heartbeat/calendar/cron/etc. — is production traffic.
const INTERACTIVE_SOURCES = new Set(['aviv_dm']);

// Lazy-create log dir
function ensureLogDir() {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── State ─────────────────────────────────────────────────────────────────────

const breaker     = new CircuitBreaker('claude-code');
const stickyMap   = new Map(); // threadId → { route, tier, expiresAt }

// Cleanup stale sticky entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of stickyMap) {
    if (val.expiresAt < now) stickyMap.delete(key);
  }
}, 5 * 60 * 1000).unref();

// ── Log helper ────────────────────────────────────────────────────────────────

function logEvent(event) {
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  } catch (_) { /* non-fatal */ }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Route a completion call. Transparent wrapper around anthropic.complete().
 *
 * @param {object} opts        Same shape as anthropic.complete() opts
 * @param {object} routeCtx
 * @param {string} routeCtx.source    e.g. 'aviv_dm', 'heartbeat', 'triage'
 * @param {string} [routeCtx.threadId] Conversation thread for sticky routing
 * @param {Function} directFn  anthropic.complete — injected to avoid circular dep
 * @returns {Promise<{ text, inputTokens, outputTokens }>}
 */
async function route(opts, routeCtx = {}, directFn) {
  const enabled  = process.env.CC_ENABLED   === 'true';
  const logOnly  = process.env.CC_LOG_ONLY  === 'true';
  // C6: default OFF — CC may serve only interactive sources unless explicitly
  // opted in. See the terms-of-use note at the top of this file.
  const prodTraffic = process.env.CC_PRODUCTION_TRAFFIC === 'true';

  // Disabled → pure passthrough
  if (!enabled) return directFn(opts);

  // Extract the user-facing message text for classification
  const lastUserMsg = (opts.messages || []).slice().reverse().find(m => m.role === 'user');
  const messageText = typeof lastUserMsg?.content === 'string'
    ? lastUserMsg.content
    : opts.system || '';

  // Check sticky route
  const { source, threadId } = routeCtx;
  let classification;

  if (threadId && stickyMap.has(threadId)) {
    const sticky = stickyMap.get(threadId);
    classification = { route: sticky.route, tier: sticky.tier, reason: 'sticky', timeoutMs: sticky.timeoutMs };
  } else {
    classification = classify(messageText, { source });
  }

  const { route: chosenRoute, tier, reason, timeoutMs } = classification;

  logEvent({
    type:      'classify',
    source,
    route:     chosenRoute,
    tier,
    reason,
    timeoutMs,
    promptLen: messageText.length,
    promptHash: crypto.createHash('sha256').update(messageText).digest('hex').slice(0, 12),
    logOnly,
  });

  // Log-only mode — always use direct regardless of classification
  if (logOnly || chosenRoute === 'direct') {
    return directFn(opts);
  }

  // C6: production-traffic guard. Unless CC_PRODUCTION_TRAFFIC is explicitly on,
  // only interactive sources may reach Claude Code — automated/production traffic
  // is downgraded to the metered API path (which the daily-token guardrail can
  // see) regardless of what the content classifier decided.
  if (!prodTraffic && !INTERACTIVE_SOURCES.has(source)) {
    logEvent({ type: 'production_traffic_guard', source, tier, downgraded_from: chosenRoute });
    return directFn(opts);
  }

  // ── Claude Code path ───────────────────────────────────────────────────────

  // Sticky register
  if (threadId) {
    stickyMap.set(threadId, { route: chosenRoute, tier, timeoutMs, expiresAt: Date.now() + STICKY_TTL });
  }

  const ccTask = messageText;

  return breaker.execute(
    // Primary: Claude Code
    async () => {
      const ccStart = Date.now();
      let ccResult;
      try {
        ccResult = await ccRunner.run({ task: ccTask, timeoutMs });
      } catch (err) {
        logEvent({ type: 'cc_failure', tier, reason: err.message, durationMs: Date.now() - ccStart });
        throw err; // circuit breaker catches and falls back
      }

      logEvent({
        type:       'cc_success',
        tier,
        durationMs: ccResult.durationMs,
        promptHash: ccResult.promptHash,
      });

      // Return in same shape as anthropic.complete()
      return {
        text:         ccResult.text,
        inputTokens:  0,  // no token charge — covered by Max subscription
        outputTokens: 0,
      };
    },

    // Fallback: direct Anthropic API
    async () => {
      console.warn(`[Router] CC fallback → direct API (tier=${tier})`);
      logEvent({ type: 'cc_fallback', tier, reason: 'circuit_breaker_or_error' });

      // Sticky: reset to direct so follow-ups don't keep hitting broken CC
      if (threadId) {
        stickyMap.set(threadId, { route: 'direct', tier: null, timeoutMs: null, expiresAt: Date.now() + STICKY_TTL });
      }

      return directFn(opts);
    }
  );
}

// ── Auth health check (called by heartbeat) ────────────────────────────────────

async function checkAuth() {
  const ok = await ccRunner.checkAuth();
  logEvent({ type: 'auth_check', ok });
  return ok;
}

function breakerStatus() {
  return breaker.status();
}

module.exports = { route, checkAuth, breakerStatus };
