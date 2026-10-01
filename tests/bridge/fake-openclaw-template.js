#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { spawnSync } = require('child_process');

// Log this spawn with all bound env vars
fs.appendFileSync(process.env.SPAWN_LOG || '/dev/null',
  JSON.stringify({ pid: process.pid, sid: process.env.OPENCLAW_SESSION_ID, bound: process.env.LIPA_BRIDGE_BOUND, cid: process.env.LIPA_BRIDGE_CLAIM_ID, cgen: process.env.LIPA_BRIDGE_CLAIM_GEN, ts: Date.now() }) + '\n');

// If FAKE_SLEEP_ONLY is set, just sleep (for TTL tests)
const sleepMs = parseInt(process.env.FAKE_SLEEP_ONLY || '0', 10);
if (sleepMs > 0) { setTimeout(() => process.exit(0), sleepMs); return; }

// Run poll.js with the env we received (bound mode vars inherited)
const POLL = process.env.FAKE_POLL_PATH;
const RESPOND = process.env.FAKE_RESPOND_PATH;

if (!POLL || !RESPOND) {
  process.stderr.write('[fake-openclaw] FAKE_POLL_PATH or FAKE_RESPOND_PATH not set\n');
  process.exit(1);
}

const pollResult = spawnSync(process.execPath, [POLL], {
  env: process.env, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
});
const pollOut = pollResult.stdout ? pollResult.stdout.toString() : '';

if (!pollOut.includes('LIPA_BRIDGE_WAKE')) {
  process.stderr.write('[fake-openclaw] poll did not wake\n');
  process.exit(0);
}

// Parse pending_commands — find the JSON line containing LIPA_BRIDGE_WAKE output.
// The output may contain dotenv "tip" lines with {} on stdout, so we can't just
// match the first {}. Instead, find the line after LIPA_BRIDGE_WAKE.
const lines = pollOut.split('\n');
const wakeIdx = lines.findIndex(l => l.includes('LIPA_BRIDGE_WAKE'));
if (wakeIdx < 0) { process.exit(0); }
// The JSON object starts on the next line
const jsonStr = lines.slice(wakeIdx + 1).join('\n').trim();
let parsed;
try { parsed = JSON.parse(jsonStr); } catch (_) { process.stderr.write('[fake-openclaw] JSON parse failed: ' + jsonStr.substring(0, 100) + '\n'); process.exit(0); }
const cmd = parsed.pending_commands && parsed.pending_commands[0];
if (!cmd) { process.exit(0); }

// Run respond.js
const responseJson = JSON.stringify({ request_id: cmd.request_id, ok: true, result: { reply: 'fake response' } });
const optsJson = JSON.stringify({ claim_generation: cmd.claim_generation, session_id: cmd.session_id });
const respondResult = spawnSync(process.execPath, [
  RESPOND, String(cmd.inbox_id), cmd.request_id || '', responseJson, cmd.subject || '', '', optsJson,
], {
  env: process.env, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
});
if (respondResult.status !== 0) {
  process.stderr.write('[fake-openclaw] respond failed: ' + (respondResult.stderr?.toString() || '').substring(0, 200) + '\n');
}
// WAL checkpoint so the preflight process sees the committed writes
try {
  const Database = require('better-sqlite3');
  const db = new Database(process.env.FAMILYBOT_DB_PATH);
  db.pragma('wal_checkpoint(PASSIVE)');
  db.close();
} catch (_) {}
process.exit(0);
