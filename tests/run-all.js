#!/usr/bin/env node
/**
 * Pre-release regression test suite.
 * Run before any significant system change: node tests/run-all.js
 *
 * Rule: every bug found and fixed → new file in tests/regression/
 */

const path = require('path');
const fs = require('fs');

// Regression tests + unit tests (both expose a run() => {pass, message} export).
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

console.log(`\n🧪 Running ${testFiles.length} regression tests...\n`);

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

  console.log(`\n─────────────────────────────`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`─────────────────────────────\n`);

  if (failed > 0) process.exit(1);
})();
