'use strict';

/**
 * Tests for the alert recurrence-blindness fixes in src/health.js.
 *
 * Three defects were fixed:
 *   1. No recovery reset — passing checks never cleared sentAlerts, so a fixed
 *      failure that recurred within 4h was silently suppressed.
 *   2. Identity-only dedup collapsed alerts with changed significant values
 *      (disk 86% vs 91%) to the same key and suppressed them.
 *   3. A 24h global cooldown muted EVERY distinct new failure after any one alert.
 *
 * No test framework — state I/O and the WhatsApp client are injected through the
 * module's _test seam, and assertions are plain throws.
 *
 * Run standalone:  node tests/unit/health-alert-dedup.test.js
 * Or via the suite: node tests/run-all.js
 */

const assert = require('assert');
const health = require('../../src/health');

// In-memory state store that round-trips through JSON (mirrors disk semantics:
// load returns a fresh copy; mutations only persist on save).
function makeStateIO(initial = {}) {
  let store = JSON.parse(JSON.stringify(initial));
  return {
    load: () => JSON.parse(JSON.stringify(store)),
    save: (s) => { store = JSON.parse(JSON.stringify(s)); },
    peek: () => store,
  };
}

// Fake WhatsApp client — records every send so tests can inspect what went out.
function makeClient() {
  const sent = [];
  return {
    sent,
    sendMessage: async (to, msg) => { sent.push({ to, msg }); },
    getState: async () => 'CONNECTED',
  };
}

const HOUR = 60 * 60 * 1000;

// Each case returns a short description on success or throws on failure.
const CASES = {
  // T1 — regression: a queued alert older than the 1h TTL is dropped on flush.
  async 'T1 stale queued alert dropped on flush'() {
    const now = Date.now();
    const io = makeStateIO({
      sentAlerts: {},
      pendingAlerts: [
        { msg: 'STALE alert body', queuedAt: now - 2 * HOUR, identity: health.alertIdentity('STALE alert body') },
        { msg: 'FRESH alert body', queuedAt: now - 60 * 1000, identity: health.alertIdentity('FRESH alert body') },
      ],
    });
    const client = makeClient();
    health._test.setStateIO(io);

    await health.initHealth(client, 'master@g.us');

    const bodies = client.sent.map(s => s.msg);
    assert.ok(!bodies.includes('STALE alert body'), 'stale alert must NOT be flushed');
    assert.ok(bodies.includes('FRESH alert body'), 'fresh alert must be flushed');
    assert.deepStrictEqual(io.peek().pendingAlerts, [], 'pendingAlerts cleared after flush');
    return 'stale (>1h) dropped, fresh flushed';
  },

  // T2 — regression: a verbatim repeat of an already-sent alert stays suppressed.
  async 'T2 exact duplicate replay suppressed'() {
    const io = makeStateIO({ sentAlerts: {} });
    const client = makeClient();
    health._test.setStateIO(io);
    health._test.setClient(client);

    await health.sendAlert('DB error: connection refused');
    await health.sendAlert('DB error: connection refused');

    assert.strictEqual(client.sent.length, 1, 'identical alert must fire exactly once');
    return 'verbatim duplicate suppressed';
  },

  // T3 — core fix 1: failure fires, checks pass (recovery), same failure recurs → fires again.
  // Exercises the real primitives checkAndAlert uses: sendAlert + recoveryReset.
  async 'T3 recovery reset lets a recurrence re-fire'() {
    const io = makeStateIO({ sentAlerts: {} });
    const client = makeClient();
    health._test.setStateIO(io);
    health._test.setClient(client);

    const failure = 'Stuck pending action (>30 min)';

    await health.sendAlert(failure);                     // failure fires
    assert.strictEqual(client.sent.length, 1, 'first failure should fire');

    await health.sendAlert(failure);                     // still failing → dedup suppresses
    assert.strictEqual(client.sent.length, 1, 'repeat within window suppressed pre-recovery');

    health.recoveryReset();                              // checks pass → clear alert memory
    assert.deepStrictEqual(io.peek().sentAlerts, {}, 'recovery must clear sentAlerts');

    await health.sendAlert(failure);                     // recurs → fires again
    assert.strictEqual(client.sent.length, 2, 'recurrence after recovery must fire again');
    return 'recurrence after recovery re-fires';
  },

  // T4 — core fix 2: same failure type with changed significant values within 4h → fires.
  async 'T4 changed significant values re-fire within 4h'() {
    const io = makeStateIO({ sentAlerts: {} });
    const client = makeClient();
    health._test.setStateIO(io);
    health._test.setClient(client);

    await health.sendAlert('Disk alert: 86% used (10.00GB free)');
    await health.sendAlert('Disk alert: 91% used (5.00GB free)');

    assert.strictEqual(client.sent.length, 2, 'changed disk % within 4h must re-fire');
    return 'changed values re-fire (86% then 91%)';
  },

  // T5 — core fix 3: a distinct new failure right after an unrelated alert → fires (no 24h block).
  async 'T5 distinct failure not blocked by prior alert'() {
    const io = makeStateIO({ sentAlerts: {} });
    const client = makeClient();
    health._test.setStateIO(io);
    health._test.setClient(client);

    await health.sendAlert('DB error: table missing');
    await health.sendAlert('WhatsApp state: TIMEOUT (3 consecutive checks)');

    assert.strictEqual(client.sent.length, 2, 'distinct failures must both fire — no global cooldown');
    return 'distinct failure fires despite recent unrelated alert';
  },
};

async function run() {
  const results = [];
  let failed = 0;
  for (const [name, fn] of Object.entries(CASES)) {
    try {
      const detail = await fn();
      results.push(`✅ ${name} — ${detail}`);
    } catch (e) {
      failed++;
      results.push(`❌ ${name} — ${e.message}`);
    } finally {
      // Detach the test seam so later work (and other test files) see a clean module.
      health._test.reset();
    }
  }
  return failed === 0
    ? { pass: true, message: `health-alert-dedup: ${results.length}/${results.length} cases passed` }
    : { pass: false, message: `health-alert-dedup: ${failed} failed:\n  ${results.join('\n  ')}` };
}

module.exports = { run };

// Standalone execution
if (require.main === module) {
  (async () => {
    console.log('\n=== health-alert-dedup.test.js ===\n');
    const r = await run();
    console.log(r.message);
    console.log(`\n=== ${r.pass ? 'PASS' : 'FAIL'} ===`);
    if (!r.pass) process.exit(1);
  })();
}
