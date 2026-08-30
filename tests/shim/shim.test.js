/**
 * H5 — Regression suite for the Baileys compatibility shim (src/baileys-client.js).
 *
 * baileys-client.js makes Baileys objects impersonate whatsapp-web.js objects. It
 * had ZERO tests, and ISSUE-023 lived here. This suite pins the full whatsapp-web.js
 * compatibility surface with hand-authored fixtures (P-014), so no shim field can be
 * changed silently again.
 *
 * The suite has four parts:
 *   1. Surface  — every fixture's id/from/to/author/type/body/hasMedia/hasQuotedMsg.
 *   2. Quoted   — getQuotedMessage() surface + round-trip to the id sendMessage()
 *                 would have returned (the ISSUE-023 path, incl. LID variants).
 *   3. Property — toBaileysJid(toWWebJid(j)) === normalizeJid(j) for phone / group /
 *                 device-suffixed / LID JIDs. This failed before the H5 JID fix.
 *   4. LID cache — the lid_map table survives a process restart.
 *
 * Fixture expectations are written BY HAND, never generated from the shim's output —
 * a self-labelled fixture would only prove the shim agrees with itself.
 *
 * Exports run() → { pass, message } so tests/run-all.js (npm test / CI) picks it up.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  BaileysClient,
  BaileysMessage,
  toWWebJid,
  toBaileysJid,
  normalizeJid,
} = require('../../src/baileys-client');

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

function loadFixtures() {
  return fs.readdirSync(FIXTURE_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8')) }));
}

// Build a client that behaves like the real one for identity resolution: a real
// BaileysClient with a stubbed signal repository serving the fixture's lidMap.
function makeClient(fx) {
  const c = new BaileysClient();
  c._myJid = fx.myJid;
  const lidMap = fx.lidMap || {};
  c._sock = {
    signalRepository: {
      lidMapping: { getPNForLID: async (lid) => lidMap[lid] || null },
    },
  };
  return c;
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function fmt(v) {
  return JSON.stringify(v);
}

async function surfaceAndQuotedChecks() {
  const errors = [];
  const fixtures = loadFixtures();
  if (fixtures.length === 0) errors.push('no fixtures found in tests/shim/fixtures/');

  for (const fx of fixtures) {
    const client = makeClient(fx);
    let msg;
    try {
      msg = new BaileysMessage(client, fx.raw);
    } catch (e) {
      errors.push(`[${fx.file}] BaileysMessage constructor threw: ${e.message}`);
      continue;
    }

    // 1) Surface
    for (const [key, expected] of Object.entries(fx.expect)) {
      const actual = getPath(msg, key);
      if (actual !== expected) {
        errors.push(`[${fx.file}] ${key}: expected ${fmt(expected)}, got ${fmt(actual)}`);
      }
    }

    // 2) Quoted (only fixtures that carry a quoted expectation)
    if (fx.quoted) {
      if (!msg.hasQuotedMsg) {
        errors.push(`[${fx.file}] expected hasQuotedMsg=true for a quoted fixture`);
        continue;
      }
      let q;
      try {
        q = await msg.getQuotedMessage();
      } catch (e) {
        errors.push(`[${fx.file}] getQuotedMessage() threw: ${e.message}`);
        continue;
      }
      const checks = {
        'fromMe': q.fromMe,
        'id.id': getPath(q, 'id.id'),
        'id._serialized': getPath(q, 'id._serialized'),
        'type': q.type,
        'body': q.body,
      };
      for (const [key, actual] of Object.entries(checks)) {
        if (key in fx.quoted && actual !== fx.quoted[key]) {
          errors.push(`[${fx.file}] quoted.${key}: expected ${fmt(fx.quoted[key])}, got ${fmt(actual)}`);
        }
      }

      // Round-trip: the quoted reply must resolve to the exact id sendMessage()
      // would have returned for the bot's original message.
      if (fx.quoted.sentKey) {
        const sent = new BaileysMessage(client, {
          key: fx.quoted.sentKey,
          message: { conversation: fx.quoted.body },
          messageTimestamp: 0,
        });
        if (q.id._serialized !== sent.id._serialized) {
          errors.push(`[${fx.file}] round-trip id._serialized: quoted ${fmt(q.id._serialized)} !== sent ${fmt(sent.id._serialized)}`);
        }
        if (q.id.id !== sent.id.id) {
          errors.push(`[${fx.file}] round-trip id.id: quoted ${fmt(q.id.id)} !== sent ${fmt(sent.id.id)}`);
        }
      }
    }
  }
  return errors;
}

// 3) Property: toBaileysJid(toWWebJid(j)) === normalizeJid(j).
// Domain = JIDs Baileys actually hands us (phone / group / device-suffixed / LID).
function propertyChecks() {
  const errors = [];
  const jids = [
    '972521234567@s.whatsapp.net',    // phone
    '972539876543:0@s.whatsapp.net',  // device-suffixed phone
    '972111222333-1600000000@g.us',   // group
    '222000222000@lid',               // LID
    '333000333000:5@lid',             // device-suffixed LID
  ];
  for (const j of jids) {
    const rt = toBaileysJid(toWWebJid(j));
    const norm = normalizeJid(j);
    if (rt !== norm) {
      errors.push(`property toBaileysJid(toWWebJid(${j}))=${fmt(rt)} !== normalizeJid=${fmt(norm)}`);
    }
  }
  return errors;
}

// 4) lid_map survives a process restart (step 4): a fresh node process reads back
// what a previous process wrote to an isolated temp DB.
function lidCacheChecks() {
  const errors = [];
  const probe = path.join(__dirname, '_lid-cache-probe.js');
  const tmpDb = path.join(os.tmpdir(), `shim-lidmap-${process.pid}.db`);
  const env = { ...process.env, FAMILYBOT_DB_PATH: tmpDb };
  const cleanup = () => {
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + ext); } catch (_) {}
    }
  };
  try {
    cleanup();
    execFileSync('node', [probe, 'save'], { env, stdio: 'ignore' });
    // Fresh process = simulated restart. Non-zero exit means the mapping did not persist.
    execFileSync('node', [probe, 'read'], { env, stdio: 'ignore' });
  } catch (e) {
    errors.push(`lid_map did not survive a restart (probe failed: ${e.message})`);
  } finally {
    cleanup();
  }
  return errors;
}

module.exports = {
  async run() {
    const errors = [];
    errors.push(...await surfaceAndQuotedChecks());
    errors.push(...propertyChecks());
    errors.push(...lidCacheChecks());

    if (errors.length > 0) {
      return { pass: false, message: `${errors.length} shim assertion(s) failed:\n  ${errors.join('\n  ')}` };
    }
    const n = loadFixtures().length;
    return {
      pass: true,
      message: `${n} fixtures pinned (surface + quoted round-trip), JID property holds for phone/group/device/LID, lid_map survives restart.`,
    };
  },
};
