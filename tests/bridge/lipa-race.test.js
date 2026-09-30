'use strict';
// SAFETY: bridge tests must NEVER run against the production DB.
const _fs = require('fs'), _path = require('path');
const _dbEnv = process.env.FAMILYBOT_DB_PATH || '';
const _dataDir = _path.resolve(__dirname, '../../data');
const _realDb = _dbEnv ? (function(){ try { return _fs.realpathSync(_dbEnv); } catch(_) { return _path.resolve(_dbEnv); } })() : '';
const _realProd = (function(){ try { return _fs.realpathSync(_path.join(_dataDir, 'family.db')); } catch(_) { return ''; } })();
if (!_dbEnv || _realDb.startsWith(_dataDir) || _realDb === _realProd) {
  module.exports = { async run() { return { pass: false, message: 'REFUSED: FAMILYBOT_DB_PATH not set or points to production DB' }; } };
  return;
}
/**
 * lipa-race.test.js — real child-process race + roundtrip tests on isolated DB.
 *
 * Creates an isolated DB, a fake executable NAMED "openclaw" injected via PATH,
 * and races real preflight wrappers.
 *
 * R1: Race two wrappers → exactly one spawn (counted from spawn.log)
 * R2: Fake worker alive past TTL → new wrapper blocked by execution_state
 * R3: Poll/respond roundtrip with a due row
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { initDB, getDB } = require('../../src/db');
const { ensureLipaTables } = require('../../src/bridge/lipaLane');
const rel = require('../../src/bridge/lipaReliability');

const PREFLIGHT = path.join(__dirname, '../../scripts/lipa-bridge-preflight.js');
const POLL = path.join(__dirname, '../../scripts/lipa-bridge-poll.js');
const RESPOND = path.join(__dirname, '../../scripts/lipa-bridge-respond.js');

function runChild(script, env, timeoutMs = 15000) {
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

    // Create a temp dir with a fake "openclaw" executable
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lipa-race-'));
    const spawnLog = path.join(tmpDir, 'spawn.log');
    const fakeCli = path.join(tmpDir, 'openclaw');  // NAMED "openclaw"

    // Fake openclaw: logs to spawn.log, stays alive for FAKE_SLEEP_MS
    fs.writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(process.env.SPAWN_LOG || '/dev/null',
  JSON.stringify({ pid: process.pid, sid: process.env.OPENCLAW_SESSION_ID, ts: Date.now() }) + '\\n');
const ms = parseInt(process.env.FAKE_SLEEP_MS || '2000', 10);
setTimeout(() => process.exit(0), ms);
`, { mode: 0o755 });

    const dbPath = process.env.FAMILYBOT_DB_PATH;
    const now = Date.now();
    const baseEnv = {
      ...process.env,
      FAMILYBOT_DB_PATH: dbPath,
      SPAWN_LOG: spawnLog,
      PATH: tmpDir + ':' + (process.env.PATH || ''),
      LIPA_BRIDGE_CLI_TIMEOUT_MS: '8000',
      LIPA_BRIDGE_LOCK_TTL_MS: '2000',
    };

    try {
      // ── R1: Race two wrappers → exactly one spawn ──────────────────────────
      {
        // Clean state
        db.prepare("DELETE FROM bridge_lipa_state").run();
        db.prepare("DELETE FROM bridge_lipa_inbox").run();
        // Insert one due row
        db.prepare(`INSERT INTO bridge_lipa_inbox
          (request_id, command, args_json, created_at, status, attempts, available_at)
          VALUES ('RACE_R1', 'noop', '{"test":"r1"}', ?, 'pending', 0, ?)`)
          .run(now, now);
        // Clear spawn log
        fs.writeFileSync(spawnLog, '');

        const env = { ...baseEnv, FAKE_SLEEP_MS: '3000' };
        const [r1, r2] = await Promise.all([
          runChild(PREFLIGHT, env),
          runChild(PREFLIGHT, env),
        ]);

        // Count spawns from the log
        const logContent = fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, 'utf8').trim() : '';
        const spawnCount = logContent ? logContent.split('\n').length : 0;

        if (r1.code !== 0) errors.push(`R1: wrapper 1 exit ${r1.code}`);
        if (r2.code !== 0) errors.push(`R1: wrapper 2 exit ${r2.code}`);
        if (spawnCount !== 1) errors.push(`R1: expected exactly 1 spawn, got ${spawnCount}`);
        // spawn count=1 IS the proof — exactly one wrapper got through the lock gate
        db.prepare("DELETE FROM bridge_lipa_state").run();
        db.prepare("DELETE FROM bridge_lipa_inbox").run();
      }

      // ── R2: Fake worker alive past TTL → new wrapper blocked ───────────────
      {
        db.prepare("DELETE FROM bridge_lipa_state").run();
        db.prepare("DELETE FROM bridge_lipa_inbox").run();
        db.prepare(`INSERT INTO bridge_lipa_inbox
          (request_id, command, args_json, created_at, status, attempts, available_at)
          VALUES ('RACE_R2', 'noop', '{}', ?, 'pending', 0, ?)`)
          .run(now, now);
        fs.writeFileSync(spawnLog, '');

        // Set execution_state to 'active' directly — simulating a remote worker
        // that's still alive past the lock TTL. This is the authoritative test:
        // the execution_state blocks new launches even when the lock has expired.
        db.prepare(`INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES ('execution_state', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
          .run(JSON.stringify({ state: 'active', session_id: 'remote-alive-r2', started_at: now - 60000 }), now);
        // Expired lock (TTL lapsed)
        db.prepare(`INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES ('worker_lock', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
          .run(JSON.stringify({ holder: 'remote-alive-r2', acquired_at: now - 60000, expires_at: now - 30000 }), now);
        // New work available
        db.prepare(`INSERT INTO bridge_lipa_inbox
          (request_id, command, args_json, created_at, status, attempts, available_at)
          VALUES ('RACE_R2_NEW', 'noop', '{}', ?, 'pending', 0, ?)`)
          .run(now, now);
        fs.writeFileSync(spawnLog, '');

        const env2 = { ...baseEnv, FAKE_SLEEP_MS: '1000' };
        const r2 = await runChild(PREFLIGHT, env2);

        const logContent = fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, 'utf8').trim() : '';
        const spawnCount = logContent ? logContent.split('\n').filter(l => l).length : 0;

        // Zero spawns — blocked by execution_state despite expired lock and new work
        if (spawnCount > 0) errors.push(`R2: expected 0 spawns (blocked by active state), got ${spawnCount}`);
        const r2out = r2.stdout + r2.stderr;
        if (!r2out.includes('execution_state_active')) {
          errors.push('R2: wrapper not blocked by execution_state: ' + r2out.substring(0, 200));
        }
        db.prepare("DELETE FROM bridge_lipa_state").run();
        db.prepare("DELETE FROM bridge_lipa_inbox").run();
      }

      // ── R3: Poll/respond roundtrip ─────────────────────────────────────────
      {
        db.prepare("DELETE FROM bridge_lipa_state").run();
        db.prepare("DELETE FROM bridge_lipa_inbox").run();
        db.prepare("DELETE FROM bridge_lipa_outbox").run();
        db.prepare("DELETE FROM bridge_lipa_attempts").run();

        // Insert a due row
        const res = db.prepare(`INSERT INTO bridge_lipa_inbox
          (request_id, command, args_json, created_at, status, attempts, available_at)
          VALUES ('RACE_R3', 'free_text', '{"text":"hello"}', ?, 'pending', 0, ?)`)
          .run(now, now);
        const rowId = Number(res.lastInsertRowid);

        // Claim it (simulating preflight's atomic claim)
        const sid = 'roundtrip-r3-' + Date.now();
        rel.acquireWorkerLock(sid);
        const claimed = rel.claimDue({ limit: 1, sessionId: sid, now: Date.now() });
        const row = claimed.rows.find(r => r.id === rowId);
        if (!row) { errors.push('R3: could not claim the due row'); } else {
          const gen = row.claim_generation;

          // Run poll.js in bound mode
          const pollEnv = {
            ...baseEnv,
            OPENCLAW_SESSION_ID: sid,
            LIPA_BRIDGE_BOUND: '1',
            LIPA_BRIDGE_CLAIM_ID: String(rowId),
            LIPA_BRIDGE_CLAIM_GEN: String(gen),
          };
          const pollResult = spawnSync(process.execPath, [POLL], {
            env: pollEnv, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
          });
          const pollOut = pollResult.stdout ? pollResult.stdout.toString() : '';
          const pollErr = pollResult.stderr ? pollResult.stderr.toString() : '';

          if (!pollOut.includes('LIPA_BRIDGE_WAKE')) {
            errors.push('R3: poll did not emit WAKE sentinel: ' + pollOut.substring(0, 100) + ' | ' + pollErr.substring(0, 100));
          }
          if (!pollOut.includes(String(rowId))) {
            errors.push('R3: poll output missing row ID');
          }

          // Run respond.js
          const responseJson = JSON.stringify({ request_id: 'RACE_R3', ok: true, result: { reply: 'test response' } });
          const optsJson = JSON.stringify({ claim_generation: gen, session_id: sid });
          const respondResult = spawnSync(process.execPath, [
            RESPOND, String(rowId), 'RACE_R3', responseJson, 'test subject', '', optsJson,
          ], {
            env: { ...baseEnv, OPENCLAW_SESSION_ID: sid },
            timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
          });

          if (respondResult.status !== 0) {
            errors.push(`R3: respond exited ${respondResult.status}: ${respondResult.stderr?.toString().substring(0, 150)}`);
          }

          // Verify the row is now done with an outbox entry
          const finalRow = db.prepare('SELECT status FROM bridge_lipa_inbox WHERE id = ?').get(rowId);
          if (!finalRow || finalRow.status !== 'done') {
            errors.push(`R3: row status=${finalRow?.status}, expected done`);
          }
          const outbox = db.prepare('SELECT id FROM bridge_lipa_outbox WHERE inbox_id = ?').get(rowId);
          if (!outbox) errors.push('R3: no outbox entry after respond');
        }
        rel.releaseWorkerLock(sid);
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
      ? { pass: true, message: 'Lipa race: R1 spawn count=1 (race), R2 TTL bypass blocked (execution state), R3 poll/respond roundtrip complete (due→claimed→done+outbox).' }
      : { pass: false, message: errors.join('\n         ') };
  },
};
