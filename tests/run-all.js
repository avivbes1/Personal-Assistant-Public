#!/usr/bin/env node
/**
 * Pre-release regression test suite.
 * Run before any significant system change: node tests/run-all.js
 *
 * Rule: every bug found and fixed → new file in tests/regression/
 *
 * Bridge tests (tests/bridge/) are NEVER imported directly — they must run in
 * an isolated DB process via run-bridge-isolated.js. This prevents any bridge
 * test from accidentally touching the production DB via a shared module cache.
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

// Regression tests + unit tests (both expose a run() => {pass, message} export).
// Bridge tests are EXCLUDED here — they are delegated to run-bridge-isolated.js below.
const dirs = [
  { dir: path.join(__dirname, 'regression'), match: f => f.endsWith('.js') },
  { dir: path.join(__dirname, 'unit'),       match: f => f.endsWith('.test.js') },
];
const testFiles = dirs.flatMap(({ dir, match }) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(match).sort().map(f => path.join(dir, f))
    : []
);

let passed = 0;
let failed = 0;

console.log(`\n🧪 Running ${testFiles.length} regression/unit tests...\n`);

(async () => {
  for (const fullPath of testFiles) {
    const file = path.relative(__dirname, fullPath);
    try {
      // require() inside the try so a single test file that fails to load
      // (e.g. a missing dependency in an unrelated module) is reported as one
      // ERROR instead of crashing the entire suite.
      const mod = require(fullPath);
      const result = typeof mod.run === 'function'
        ? await mod.run()
        : { pass: false, message: 'No run() export' };

      if (result.pass) {
        console.log(`  ✅ PASS  ${file}`);
        if (result.message) console.log(`         ${result.message}`);
        passed++;
      } else {
        console.log(`  ❌ FAIL  ${file}`);
        console.log(`         ${result.message}`);
        failed++;
      }
    } catch (e) {
      console.log(`  ❌ ERROR ${file}`);
      console.log(`         ${e.message}`);
      failed++;
    }
  }

  // ── Bridge tests: always delegated to run-bridge-isolated.js ──────────────
  // Bridge tests MUST run in an isolated child process with FAMILYBOT_DB_PATH
  // set to a temp DB. They are NEVER require()d directly from this file.
  const bridgeRunner = path.join(__dirname, 'bridge', 'run-bridge-isolated.js');
  if (fs.existsSync(bridgeRunner)) {
    console.log('\n🔒 Running bridge tests (isolated DB)...\n');
    const br = spawnSync(process.execPath, [bridgeRunner], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
    const stdout = br.stdout ? br.stdout.toString() : '';
    const stderr = br.stderr ? br.stderr.toString() : '';
    // Print bridge runner output as-is
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    // Parse bridge pass/fail from its summary line
    const summaryMatch = (stdout + stderr).match(/(\d+) passed, (\d+) failed/);
    if (summaryMatch) {
      passed += parseInt(summaryMatch[1], 10);
      failed += parseInt(summaryMatch[2], 10);
    } else if (br.status !== 0 || br.error) {
      // Runner itself failed
      console.log('  ❌ ERROR bridge/run-bridge-isolated.js (runner crashed)');
      if (br.error) console.log(`         ${br.error.message}`);
      failed++;
    }
  }

  console.log(`\n─────────────────────────────`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`─────────────────────────────\n`);

  if (failed > 0) process.exit(1);
})();
