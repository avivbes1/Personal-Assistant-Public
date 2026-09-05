'use strict';

/**
 * M3: guard against dead code — every src/ module must be imported by another
 * src/ file or be an allowlisted entry point. Delegates to the CI script so the
 * standalone `node scripts/check-unused-modules.js` and the test suite share one
 * source of truth.
 *
 * Run standalone:  node tests/unit/no-orphan-modules.test.js
 * Or via the suite: node tests/run-all.js
 */

const { run } = require('../../scripts/check-unused-modules');

module.exports = { run };

if (require.main === module) {
  const r = run();
  console.log(`${r.pass ? '✅' : '❌'} ${r.message}`);
  if (!r.pass) process.exit(1);
}
