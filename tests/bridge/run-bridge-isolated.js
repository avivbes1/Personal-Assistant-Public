#!/usr/bin/env node
'use strict';
/**
 * run-bridge-isolated.js — Run bridge tests on an isolated DB.
 *
 * Spawns each bridge test file as a child process with FAMILYBOT_DB_PATH
 * set to a temp DB. The production database is NEVER touched.
 *
 * This replaces the auto-discovery in run-all.js for bridge/ tests.
 * run-all.js should skip bridge/ files and delegate to this script.
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BRIDGE_DIR = __dirname;
const PROD_DB = path.resolve(__dirname, '../../data/family.db');

// Create isolated DB
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lipa-bridge-suite-'));
const dbPath = path.join(tmpDir, 'test.db');

// Initialize the isolated DB with schema
const Database = require('better-sqlite3');
const db = new Database(dbPath);
// Run initDB to create all tables
process.env.FAMILYBOT_DB_PATH = dbPath;
const { initDB } = require('../../src/db');
initDB();
const { ensureLipaTables } = require('../../src/bridge/lipaLane');
ensureLipaTables();
db.close();
// Reset the cached module so child requires get a fresh DB
delete require.cache[require.resolve('../../src/db')];

const testFiles = fs.readdirSync(BRIDGE_DIR)
  .filter(f => f.endsWith('.test.js'))
  .sort()
  .map(f => path.join(BRIDGE_DIR, f));

let passed = 0, failed = 0;

for (const file of testFiles) {
  const name = path.basename(file);
  const result = spawnSync(process.execPath, ['-e', `
    process.env.FAMILYBOT_DB_PATH = ${JSON.stringify(dbPath)};
    const t = require(${JSON.stringify(file)});
    t.run().then(r => {
      console.log(r.pass ? 'PASS' : 'FAIL', r.message);
      process.exit(r.pass ? 0 : 1);
    }).catch(e => {
      console.error('ERROR:', e.message);
      process.exit(1);
    });
  `], {
    env: { ...process.env, FAMILYBOT_DB_PATH: dbPath },
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout = result.stdout ? result.stdout.toString() : '';
  const stderr = result.stderr ? result.stderr.toString() : '';
  const output = stdout + stderr;
  const isPass = result.status === 0 && output.includes('PASS');

  if (isPass) {
    passed++;
    // Extract the message from the PASS line
    const msg = output.split('\n').find(l => l.startsWith('PASS'));
    console.log(`  ✅ PASS  bridge/${name}`);
    if (msg) console.log(`         ${msg.replace('PASS ', '')}`);
  } else {
    failed++;
    console.log(`  ❌ FAIL  bridge/${name}`);
    const failLines = output.split('\n').filter(l => l.includes('FAIL') || l.includes('ERROR') || l.includes('T') && l.includes(':'));
    failLines.slice(0, 5).forEach(l => console.log(`         ${l.trim()}`));
  }
}

// Cleanup
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

console.log(`\n  Bridge tests: ${passed} passed, ${failed} failed (isolated DB: ${dbPath})`);
process.exit(failed > 0 ? 1 : 0);
