'use strict';
/**
 * circuit-breaker.js — Failure isolation for Claude Code calls.
 *
 * States:
 *   closed    — normal operation, calls pass through
 *   open      — too many failures, calls skip to fallback immediately
 *   half-open — cooldown elapsed, allowing one probe call
 *
 * Thresholds (conservative):
 *   3 consecutive failures → open
 *   5 min cooldown → half-open → probe
 */

const FAILURE_THRESHOLD = 3;
const RESET_TIMEOUT_MS  = 5 * 60 * 1000; // 5 minutes

class CircuitBreaker {
  constructor(name = 'claude-code') {
    this.name       = name;
    this.state      = 'closed';
    this.failures   = 0;
    this.lastFail   = null;
  }

  /**
   * Run fn(), fall back to fallback() if circuit is open or fn throws.
   * @param {Function} fn        async () => result
   * @param {Function} fallback  async () => result
   */
  async execute(fn, fallback) {
    if (this.state === 'open') {
      if (Date.now() - this.lastFail >= RESET_TIMEOUT_MS) {
        this.state = 'half-open';
        console.log(`[CircuitBreaker:${this.name}] Half-open — probing`);
      } else {
        console.log(`[CircuitBreaker:${this.name}] Open — skipping to fallback`);
        return fallback();
      }
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure(err);
      console.warn(`[CircuitBreaker:${this.name}] Failure caught, running fallback. Error: ${err.message}`);
      return fallback();
    }
  }

  isOpen() { return this.state === 'open'; }

  _onSuccess() {
    if (this.state !== 'closed') {
      console.log(`[CircuitBreaker:${this.name}] Recovered → closed`);
    }
    this.failures = 0;
    this.state = 'closed';
  }

  _onFailure(err) {
    this.failures++;
    this.lastFail = Date.now();
    console.warn(`[CircuitBreaker:${this.name}] Failure #${this.failures}: ${err.message}`);
    if (this.failures >= FAILURE_THRESHOLD) {
      this.state = 'open';
      console.error(`[CircuitBreaker:${this.name}] OPEN — too many failures (${this.failures}). Cooldown ${RESET_TIMEOUT_MS / 60000}min`);
    }
  }

  status() {
    return {
      name:     this.name,
      state:    this.state,
      failures: this.failures,
      lastFail: this.lastFail,
    };
  }
}

module.exports = { CircuitBreaker };
