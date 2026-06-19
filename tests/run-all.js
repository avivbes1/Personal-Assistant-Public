#!/usr/bin/env node
/**
 * Pre-release regression test suite.
 * Run before any significant system change: node tests/run-all.js
 *
 * Rule: every bug found and fixed → new file in tests/regression/
 */

const path = require('path');
const fs = require('fs');

const testDir = path.join(__dirname, 'regression');
const testFiles = fs.readdirSync(testDir)
  .filter(f => f.endsWith('.js'))
  .sort();

let passed = 0;
let failed = 0;

console.log(`\n🧪 Running ${testFiles.length} regression tests...\n`);

(async () => {
  for (const file of testFiles) {
    const mod = require(path.join(testDir, file));
    try {
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
