'use strict';
// test-env.js — one-stop test-isolation bootstrap.
//
//   require('./lib/test-env');  // at the top of a test entrypoint
//
// Loading this module:
//   1. Flags the process as a test run (FAMILYBOT_TEST=1).
//   2. Points FAMILYBOT_DB_PATH at a throwaway temp DB (unless already set to a
//      non-production path) and initializes its schema, so no test can write the
//      production database at data/family.db.
//   3. Installs the outbound guards (SMTP / WhatsApp HTTP / Calendar writes) via
//      ./outbound-guard, which fail closed when a live send is attempted.
//
// Everything here is idempotent and transparent to production: the guards only
// activate because this module sets FAMILYBOT_TEST=1 before requiring them.

const os = require('os');
const fs = require('fs');
const path = require('path');

// 1. Mark this as a test run.
process.env.FAMILYBOT_TEST = '1';

// 2. Isolate the DB. The production DB lives at data/family.db (optionally a
//    besinsky.db symlink). Treat any path under the repo's data/ dir as unsafe.
function isProductionDbPath(p) {
  if (!p) return true; // unset → db.js would default to the production path
  const resolved = path.resolve(p);
  const prodDataDir = path.resolve(__dirname, '../../data');
  return resolved.startsWith(prodDataDir + path.sep) || resolved === prodDataDir;
}

if (isProductionDbPath(process.env.FAMILYBOT_DB_PATH)) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'besinsky-test-'));
  process.env.FAMILYBOT_DB_PATH = path.join(tmpDir, 'test.db');
  try {
    const { initDB } = require('../../src/db');
    initDB();
  } catch (_) { /* schema init is best-effort; individual tests may init themselves */ }
}

// 3. Install outbound interceptors (reads FAMILYBOT_TEST, now set above).
const outboundGuard = require('./outbound-guard');

module.exports = {
  dbPath: process.env.FAMILYBOT_DB_PATH,
  outboundGuard,
  blocked: outboundGuard.blocked,
};
