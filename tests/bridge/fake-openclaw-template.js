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

// Parse pending_commands
const match = pollOut.match(/\{[\s\S]*"pending_commands"[\s\S]*\}/);
if (!match) { process.exit(0); }
const cmd = JSON.parse(match[0]).pending_commands[0];
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
process.exit(0);
