/**
 * 2026-09-09-infra-resilience.js — Regression test for WORKPLAN Phase I (I1 + I2).
 *
 * Incident: the 2026-09-09 outage. Two failure modes it exposed:
 *   I1 — a full disk silently corrupted the Baileys session/DB with no warning.
 *   I2 — /health reported whatsapp_connected:true throughout the outage because
 *        the flag was `!!(client && client.info)`, and client.info is always
 *        populated once the client object is constructed.
 *
 * Fixes verified here:
 *   I1: health.checkDiskSpace() classifies warn(80)/alert(85)/critical(>90) usage,
 *       DMs immediately only on critical, and getDiskStats() returns a sane shape.
 *   I2: whatsapp-state.deriveConnectionState() reports connected ONLY when the
 *       socket is ready, not stale, and not awaiting a QR — and exposes a discrete
 *       whatsapp_state (connected|stale|awaiting_qr|disconnected).
 */

'use strict';
const assert = require('assert');

module.exports = {
  async run() {
    // Isolate metric writes so the test never appends to the live trend file.
    process.env.FAMILYBOT_METRICS_PATH = require('path').join(require('os').tmpdir(), `infra-test-metrics-${process.pid}.jsonl`);
    const { getDiskStats, checkDiskSpace } = require('../../src/health');
    const { deriveConnectionState } = require('../../src/whatsapp-state');

    // ── I1: getDiskStats shape ────────────────────────────────────────────────
    const disk = getDiskStats();
    assert.ok(disk, 'getDiskStats should return stats on this host');
    for (const k of ['total_bytes', 'free_bytes', 'free_pct', 'used_pct']) {
      assert.strictEqual(typeof disk[k], 'number', `getDiskStats.${k} should be a number`);
    }
    assert.ok(Math.abs(disk.free_pct + disk.used_pct - 100) < 0.2, 'free_pct + used_pct ≈ 100');

    // Helper: run checkDiskSpace with an injected disk + notify spy (no real DM,
    // no prod health-state.json writes).
    async function classify(used_pct) {
      const failures = [];
      const notified = [];
      const injected = { total_bytes: 100e9, free_bytes: (100 - used_pct) * 1e9, free_pct: 100 - used_pct, used_pct };
      await checkDiskSpace(failures, injected, (msg) => { notified.push(msg); });
      return { failures, notified };
    }

    // 50% used → healthy, no failure, no DM
    let r = await classify(50);
    assert.strictEqual(r.failures.length, 0, '50% used → no failure');
    assert.strictEqual(r.notified.length, 0, '50% used → no DM');

    // 82% → warning, no DM
    r = await classify(82);
    assert.ok(/Disk warning/.test(r.failures[0]), '82% used → warning failure');
    assert.strictEqual(r.notified.length, 0, '82% used → no immediate DM');

    // 86% → alert, no DM
    r = await classify(86);
    assert.ok(/Disk alert/.test(r.failures[0]), '86% used → alert failure');
    assert.strictEqual(r.notified.length, 0, '86% used → no immediate DM');

    // 90% exactly → alert (spec: critical is strictly >90)
    r = await classify(90);
    assert.ok(/Disk alert/.test(r.failures[0]), '90% used → alert (not critical)');
    assert.strictEqual(r.notified.length, 0, '90% used → no immediate DM');

    // 91% → critical + immediate DM
    r = await classify(91);
    assert.ok(/Disk critical/.test(r.failures[0]), '91% used → critical failure');
    assert.strictEqual(r.notified.length, 1, '91% used → immediate DM sent');
    assert.ok(/critical/i.test(r.notified[0]), 'critical DM mentions the severity');

    // ── I2: connection-state truthfulness ─────────────────────────────────────
    const healthyWd = { isStale: false, presenceFailCount: 0 };

    const cases = [
      // [name, input, expectedState, expectedConnected]
      ['no client', { hasClient: false, isReady: false, awaitingQr: false, watchdogState: null }, 'disconnected', false],
      ['awaiting qr', { hasClient: true, isReady: false, awaitingQr: true, watchdogState: null }, 'awaiting_qr', false],
      ['ready + healthy watchdog', { hasClient: true, isReady: true, awaitingQr: false, watchdogState: healthyWd }, 'connected', true],
      ['ready + no watchdog yet', { hasClient: true, isReady: true, awaitingQr: false, watchdogState: null }, 'connected', true],
      ['stale socket', { hasClient: true, isReady: true, awaitingQr: false, watchdogState: { isStale: true, presenceFailCount: 0 } }, 'stale', false],
      ['presence fails ≥10', { hasClient: true, isReady: true, awaitingQr: false, watchdogState: { isStale: false, presenceFailCount: 10 } }, 'stale', false],
      ['presence fails 9 (ok)', { hasClient: true, isReady: true, awaitingQr: false, watchdogState: { isStale: false, presenceFailCount: 9 } }, 'connected', true],
      ['client up but not ready', { hasClient: true, isReady: false, awaitingQr: false, watchdogState: null }, 'disconnected', false],
    ];

    for (const [name, input, expState, expConn] of cases) {
      const out = deriveConnectionState(input);
      assert.strictEqual(out.whatsapp_state, expState, `${name}: whatsapp_state`);
      assert.strictEqual(out.whatsapp_connected, expConn, `${name}: whatsapp_connected`);
    }

    return {
      pass: true,
      message: 'I1 disk thresholds (warn/alert/critical + immediate DM) and I2 connection-state truthfulness verified',
    };
  },
};
