'use strict';
/**
 * test-db-isolate.js — Isolated DB setup for bridge tests.
 *
 * MUST be required BEFORE any src/ or scripts/ imports. Sets FAMILYBOT_DB_PATH
 * to a temp file so tests never touch the production database.
 *
 * Usage in test files:
 *   const { dbPath, cleanup: cleanupDb } = require('./test-db-isolate');
 *   // ... run tests ...
 *   // cleanupDb() in finally block
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lipa-test-'));
const dbPath = path.join(tmpDir, 'test.db');

// Set BEFORE any imports read it
process.env.FAMILYBOT_DB_PATH = dbPath;

// Safety check: refuse if somehow pointed at production
const PROD_DB = path.join(__dirname, '../../data/family.db');
if (path.resolve(dbPath) === path.resolve(PROD_DB)) {
  throw new Error('TEST SAFETY: isolated DB path resolved to production DB! Aborting.');
}

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

module.exports = { dbPath, tmpDir, cleanup };
