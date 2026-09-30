'use strict';
const _fs = require('fs'), _path = require('path');
const _dbEnv = process.env.FAMILYBOT_DB_PATH || '';
const _dataDir = _path.resolve(__dirname, '../../data');
const _realDb = _dbEnv ? (function(){ try { return _fs.realpathSync(_dbEnv); } catch(_) { return _path.resolve(_dbEnv); } })() : '';
const _realProd = (function(){ try { return _fs.realpathSync(_path.join(_dataDir, 'family.db')); } catch(_) { return ''; } })();
if (!_dbEnv || _realDb.startsWith(_dataDir) || _realDb === _realProd) {
  module.exports = { async run() { return { pass: false, message: 'REFUSED: not isolated DB' }; } };
  return;
}
/**
 * lipa-race.test.js — full-flow race + roundtrip tests on isolated DB.
 *
 * Uses a fake executable named "openclaw" that runs poll.js + respond.js
 * as subprocesses with the env it receives from the preflight.
 *
 * R1: Full flow: preflight → fake openclaw → poll → respond → done + outbox
 *     + terminal execution state + lock released + spawn count = 1.
 *     Then restart preflight and assert no replay (no second spawn).
 * R2: Fake worker alive past TTL → second preflight blocked by execution_state.
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { initDB, getDB } = require('../../src/db');
const { ensureLipaTables } = require('../../src/bridge/lipaLane');
const rel = require('../../src/bridge/lipaReliability');

const PREFLIGHT = path.join(__dirname, '../../scripts/lipa-bridge-preflight.js');

function runChild(script, env, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [script], {
      stdio: ['ignore', 'pipe', 'pipe'], env, timeout: timeoutMs,
    });
    const stdout = [], stderr = [];
    proc.stdout.on('data', (d) => stdout.push(d));
    proc.stderr.on('data', (d) => stderr.push(d));
    proc.on('exit', (code) => resolve({
      code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(),
    }));
    proc.on('error', (err) => resolve({ code: null, error: err.message, stdout: '', stderr: '' }));
  });
}

module.exports = {
  async run() {
    const errors = [];
    initDB();
    ensureLipaTables();
    const db = getDB();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lipa-race-'));
    const spawnLog = path.join(tmpDir, 'spawn.log');
    const dbPath = process.env.FAMILYBOT_DB_PATH;

    // Copy the fake-openclaw template as "openclaw" in the temp dir
    const POLL = path.resolve(__dirname, '../../scripts/lipa-bridge-poll.js');
    const RESPOND = path.resolve(__dirname, '../../scripts/lipa-bridge-respond.js');
    const templatePath = path.join(__dirname, 'fake-openclaw-template.js');
    fs.copyFileSync(templatePath, path.join(tmpDir, 'openclaw'));
    fs.chmodSync(path.join(tmpDir, 'openclaw'), 0o755);

    const baseEnv = {
      ...process.env,
      FAMILYBOT_DB_PATH: dbPath,
      SPAWN_LOG: spawnLog,
      PATH: tmpDir + ':' + (process.env.PATH || ''),
      LIPA_BRIDGE_CLI_TIMEOUT_MS: '10000',
      LIPA_BRIDGE_LOCK_TTL_MS: '3000',
      FAKE_POLL_PATH: POLL,
      FAKE_RESPOND_PATH: RESPOND,
    };

    try {
      // ── R1: Full flow + no replay ──────────────────────────────────────────
      {
        db.prepare("DELETE FROM bridge_lipa_costs").run();
        db.prepare("DELETE FROM bridge_lipa_outbox").run();
        db.prepare("DELETE FROM bridge_lipa_attempts").run();
        db.prepare("DELETE FROM bridge_lipa_inbox").run();
        db.prepare("DELETE FROM bridge_lipa_state").run();

        const now = Date.now();
        db.prepare(`INSERT INTO bridge_lipa_inbox
          (request_id, command, args_json, created_at, status, attempts, available_at)
          VALUES ('R1_FLOW', 'free_text', '{"text":"roundtrip"}', ?, 'pending', 0, ?)`)
          .run(now, now);
        fs.writeFileSync(spawnLog, '');

        // Run preflight — should claim, spawn fake openclaw, which runs poll+respond
        const r1 = await runChild(PREFLIGHT, baseEnv);

        // Assert spawn count = 1
        const log1 = fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, 'utf8').trim() : '';
        const spawns1 = log1 ? log1.split('\n').filter(l => l).length : 0;
        if (spawns1 !== 1) errors.push(`R1: expected 1 spawn, got ${spawns1}`);

        // Assert row is done
        const row = db.prepare("SELECT status FROM bridge_lipa_inbox WHERE request_id='R1_FLOW'").get();
        if (!row || row.status !== 'done') errors.push(`R1: row status=${row?.status}, expected done`);

        // Assert outbox entry exists
        const inbox = db.prepare("SELECT id FROM bridge_lipa_inbox WHERE request_id='R1_FLOW'").get();
        if (inbox) {
          const outbox = db.prepare('SELECT id FROM bridge_lipa_outbox WHERE inbox_id=?').get(inbox.id);
          if (!outbox) errors.push('R1: no outbox entry');
        }

        // Assert execution state is terminal
        const execState = db.prepare("SELECT value FROM bridge_lipa_state WHERE key='execution_state'").get();
        if (execState) {
          const es = JSON.parse(execState.value);
          if (es.state !== 'terminal') errors.push(`R1: execution state=${es.state}, expected terminal`);
        } else {
          errors.push('R1: no execution state after completion');
        }

        // Assert lock released
        const lock = db.prepare("SELECT value FROM bridge_lipa_state WHERE key='worker_lock'").get();
        if (lock) errors.push('R1: worker lock not released after completion');

        // Assert no hold
        const hold = db.prepare("SELECT value FROM bridge_lipa_state WHERE key='execution_hold'").get();
        if (hold) errors.push('R1: hold set despite clean completion');

        // ── RESTART: no replay ──
        fs.writeFileSync(spawnLog, '');
        const r1b = await runChild(PREFLIGHT, baseEnv);
        const log1b = fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, 'utf8').trim() : '';
        const spawns1b = log1b ? log1b.split('\n').filter(l => l).length : 0;
        if (spawns1b !== 0) errors.push(`R1 restart: expected 0 spawns (no replay), got ${spawns1b}`);

        db.prepare("DELETE FROM bridge_lipa_costs").run();
        db.prepare("DELETE FROM bridge_lipa_outbox").run();
        db.prepare("DELETE FROM bridge_lipa_attempts").run();
        db.prepare("DELETE FROM bridge_lipa_inbox").run();
        db.prepare("DELETE FROM bridge_lipa_state").run();
      }

      // ── R2: Real fake worker alive past TTL → blocked ──────────────────────
      {
        db.prepare("DELETE FROM bridge_lipa_costs").run();
        db.prepare("DELETE FROM bridge_lipa_outbox").run();
        db.prepare("DELETE FROM bridge_lipa_attempts").run();
        db.prepare("DELETE FROM bridge_lipa_inbox").run();
        db.prepare("DELETE FROM bridge_lipa_state").run();

        const now = Date.now();
        db.prepare(`INSERT INTO bridge_lipa_inbox
          (request_id, command, args_json, created_at, status, attempts, available_at)
          VALUES ('R2_TTL', 'noop', '{}', ?, 'pending', 0, ?)`)
          .run(now, now);
        fs.writeFileSync(spawnLog, '');

        // First preflight with a LONG fake worker (survives past 3s TTL)
        const env1 = { ...baseEnv, FAKE_SLEEP_ONLY: '8000' };
        const p1 = runChild(PREFLIGHT, env1);

        // Wait for TTL to expire (3s lock TTL + margin)
        await new Promise(r => setTimeout(r, 4000));

        // Add new work
        db.prepare(`INSERT INTO bridge_lipa_inbox
          (request_id, command, args_json, created_at, status, attempts, available_at)
          VALUES ('R2_NEW', 'noop', '{}', ?, 'pending', 0, ?)`)
          .run(Date.now(), Date.now());

        // Second preflight — should be blocked by execution_state (active)
        const r2 = await runChild(PREFLIGHT, baseEnv);
        await p1; // wait for first to finish

        const log2 = fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, 'utf8').trim() : '';
        const spawns2 = log2 ? log2.split('\n').filter(l => l).length : 0;

        // Only 1 spawn (the first preflight). Second was blocked.
        if (spawns2 > 1) errors.push(`R2: expected <=1 spawn, got ${spawns2}`);
        const r2out = r2.stdout + r2.stderr;
        if (!r2out.includes('execution_state_active') && !r2out.includes('execution_hold') && !r2out.includes('lock_held')) {
          errors.push('R2: second wrapper not blocked: ' + r2out.substring(0, 200));
        }

        db.prepare("DELETE FROM bridge_lipa_costs").run();
        db.prepare("DELETE FROM bridge_lipa_outbox").run();
        db.prepare("DELETE FROM bridge_lipa_attempts").run();
        db.prepare("DELETE FROM bridge_lipa_inbox").run();
        db.prepare("DELETE FROM bridge_lipa_state").run();
      }

    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }

    return errors.length === 0
      ? { pass: true, message: 'Lipa race: R1 full flow (preflight→openclaw→poll→respond→done+outbox+terminal, spawn=1, no replay). R2 fake worker past TTL blocked.' }
      : { pass: false, message: errors.join('\n         ') };
  },
};
