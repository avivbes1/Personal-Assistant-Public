#!/usr/bin/env node
/**
 * Standalone runner for the Baileys shim fixture suite (H5).
 *   node tests/shim/run.js
 * Pure fixtures — no API calls, no secrets. Also wired into `npm test` via
 * tests/regression/2026-08-30-baileys-shim.js and into CI.
 */
const suite = require('./shim.test');

(async () => {
  const result = await suite.run();
  if (result.pass) {
    console.log(`✅ PASS  baileys shim suite`);
    if (result.message) console.log(`         ${result.message}`);
    process.exit(0);
  } else {
    console.log(`❌ FAIL  baileys shim suite`);
    console.log(`         ${result.message}`);
    process.exit(1);
  }
})();
