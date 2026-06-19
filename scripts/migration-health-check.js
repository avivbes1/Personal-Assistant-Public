#!/usr/bin/env node
/**
 * migration-health-check.js
 *
 * Runs after EVERY file change during Phase 2 migration.
 * Checks: all key modules load, config loads, DB accessible, bot process alive, health endpoint up.
 * Fast: <5 seconds. No LLM calls. No network calls (except localhost).
 *
 * Usage: node scripts/migration-health-check.js
 * Exit 0 = all good. Exit 1 = something broke.
 */

const path = require('path');
const fs   = require('fs');
const http = require('http');

let passed = 0;
let failed = 0;
const errors = [];

function ok(label)       { passed++; process.stdout.write(`  ✅ ${label}\n`); }
function fail(label, e)  { failed++; errors.push({ label, error: e?.message || e }); process.stdout.write(`  ❌ ${label}: ${e?.message || e}\n`); }

// ── 1. Module load checks ─────────────────────────────────────────────────────

function checkRequire(label, modPath) {
  try {
    require(modPath);
    ok(label);
  } catch (e) {
    fail(label, e);
  }
}

console.log('\n🔬 Migration Health Check\n');
console.log('── Module loads ──────────────────────────────────');

// Clear require cache so we pick up fresh files
Object.keys(require.cache).forEach(k => delete require.cache[k]);

checkRequire('src/config.js loads',          path.join(__dirname, '../src/config.js'));
checkRequire('src/db.js loads',              path.join(__dirname, '../src/db.js'));
checkRequire('src/family-profiles.js loads', path.join(__dirname, '../src/family-profiles.js'));
checkRequire('src/calendar.js loads',        path.join(__dirname, '../src/calendar.js'));
checkRequire('src/agent.js loads',           path.join(__dirname, '../src/agent.js'));
checkRequire('src/parser.js loads',          path.join(__dirname, '../src/parser.js'));
checkRequire('src/query.js loads',           path.join(__dirname, '../src/query.js'));
checkRequire('src/triage-engine.js loads',   path.join(__dirname, '../src/triage-engine.js'));
checkRequire('src/noticeDelivery.js loads',  path.join(__dirname, '../src/noticeDelivery.js'));
checkRequire('src/health.js loads',          path.join(__dirname, '../src/health.js'));
checkRequire('src/scheduler.js loads',       path.join(__dirname, '../src/scheduler.js'));

// ── 2. Config sanity ──────────────────────────────────────────────────────────

console.log('\n── Config sanity ────────────────────────────────');

try {
  Object.keys(require.cache).forEach(k => delete require.cache[k]);
  const config = require(path.join(__dirname, '../src/config.js'));

  const required = ['AVIV_PHONE', 'LIAT_PHONE', 'MASTER_GROUP_NAME', 'AVIV_CALENDAR_ID', 'LIAT_CALENDAR_ID', 'TIMEZONE'];
  const missing  = required.filter(k => !config[k]);

  if (missing.length) fail('Config has required keys', new Error('Missing: ' + missing.join(', ')));
  else ok('Config has all required keys');

  if (config.AVIV_PHONE && config.AVIV_PHONE.length >= 9) ok('AVIV_PHONE is set');
  else fail('AVIV_PHONE is set', new Error('empty or too short'));

  if (config.MASTER_GROUP_NAME && config.MASTER_GROUP_NAME.length > 0) ok('MASTER_GROUP_NAME is set');
  else fail('MASTER_GROUP_NAME is set', new Error('empty'));
} catch (e) {
  fail('Config loads without error', e);
}

// ── 3. DB accessibility ───────────────────────────────────────────────────────

console.log('\n── Database ─────────────────────────────────────');

try {
  Object.keys(require.cache).forEach(k => delete require.cache[k]);
  const { initDB, getDB } = require(path.join(__dirname, '../src/db.js'));
  initDB();
  const db = getDB();

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  const expected = ['messages', 'groups', 'notices', 'family_members'];
  const missingTables = expected.filter(t => !tables.includes(t));

  if (missingTables.length) fail('DB tables exist', new Error('Missing: ' + missingTables.join(', ')));
  else ok('DB tables exist: ' + expected.join(', '));

  const memberCount = db.prepare('SELECT COUNT(*) as n FROM family_members').get().n;
  if (memberCount > 0) ok(`family_members has ${memberCount} rows`);
  else fail('family_members has rows', new Error('0 rows — family seeding may have broken'));
} catch (e) {
  fail('DB accessible', e);
}

// ── 4. Critical config files exist ───────────────────────────────────────────

console.log('\n── Critical files ───────────────────────────────');

const criticalFiles = [
  ['src/config.js',       'Config module'],
  ['src/db.js',           'DB module'],
  ['src/index.js',        'Entry point'],
  ['src/whatsapp.js',     'WhatsApp handler'],
  ['src/agent.js',        'Agent'],
  ['src/triage-engine.js','Triage engine'],
  ['.env',                '.env file'],
];

for (const [rel, label] of criticalFiles) {
  const full = path.join(__dirname, '..', rel);
  if (fs.existsSync(full)) ok(`${label} exists`);
  else fail(`${label} exists`, new Error(`Missing: ${rel}`));
}

// ── 5. PM2 process alive ──────────────────────────────────────────────────────

console.log('\n── Process ──────────────────────────────────────');

const { execSync } = require('child_process');
try {
  const pm2Out = execSync('pm2 jlist 2>/dev/null', { timeout: 5000 }).toString();
  const procs  = JSON.parse(pm2Out);
  const bot    = procs.find(p => p.name === 'besinsky-bot');
  if (!bot) fail('pm2 process running', new Error('besinsky-bot not found in pm2 list'));
  else if (bot.pm2_env.status !== 'online') fail('pm2 process online', new Error(`status: ${bot.pm2_env.status}`));
  else ok(`pm2 process online (uptime: ${Math.round((Date.now() - bot.pm2_env.pm_uptime) / 60000)}min, restarts: ${bot.pm2_env.restart_time})`);
} catch (e) {
  fail('pm2 check', e);
}

// ── 6. Health endpoint ────────────────────────────────────────────────────────

console.log('\n── Health endpoint ──────────────────────────────');

http.get('http://localhost:3001/health', { timeout: 4000 }, res => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    try {
      const h = JSON.parse(data);
      if (h.whatsapp_connected) ok('WhatsApp connected');
      else fail('WhatsApp connected', new Error('whatsapp_connected: false'));

      if (h.ready_failure_count > 0) fail('No ready_failure_count', new Error(`ready_failure_count: ${h.ready_failure_count}`));
      else ok('ready_failure_count: 0');
    } catch (e) {
      fail('Health endpoint parseable', e);
    }
    finish();
  });
}).on('error', e => {
  fail('Health endpoint reachable', e);
  finish();
});

function finish() {
  console.log('\n── Result ───────────────────────────────────────');
  console.log(`  Passed: ${passed}   Failed: ${failed}`);

  if (failed > 0) {
    console.log('\n🛑 HEALTH CHECK FAILED — do NOT continue migration until fixed:\n');
    errors.forEach(e => console.log(`  • ${e.label}: ${e.error}`));
    console.log('');
    process.exit(1);
  } else {
    console.log('\n✅ All checks passed — safe to continue migration.\n');
    process.exit(0);
  }
}
