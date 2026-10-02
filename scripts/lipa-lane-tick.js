#!/usr/bin/env node
'use strict';
/**
 * lipa-lane-tick.js — standalone Lipa lane tick for OS cron.
 *
 * Runs every 2 minutes from system crontab. One tick:
 *   1. Acquire non-overlap lock (bridge_lipa_state key 'lane_tick_lock')
 *   2. Scan the Lipa IMAP mailbox for new authenticated requests
 *   3. Validate auth + required request_id; enqueue to bridge_lipa_inbox
 *   4. If a NEW pending row exists with no execution hold/active worker:
 *      claim exactly one, persist session, launch ONE model turn via OpenClaw CLI
 *   5. On completion: write response to outbox
 *   6. Drain outbox: send pending reply emails (bounded retry for failed SMTP)
 *   7. Release lock
 *
 * Does NOT call the shared pollCycle (which routes free_text through the chatbot).
 * Does NOT open an OpenClaw/model session just to check mail.
 * The model is triggered ONLY by an authenticated new request_id.
 *
 * Invalid mail, empty mailbox, duplicate ID, execution hold, or active/unknown
 * previous worker → ZERO model launches.
 *
 * On timeout, auth/billing failure, or unknown completion → execution hold,
 * deterministic held/failed status emailed, no blind replay.
 */

const path = require('path');
const { spawn } = require('child_process');

// Load .env BEFORE requiring DB
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const LOCK_KEY = 'lane_tick_lock';
const LOCK_TTL_MS = 150000; // 2.5 min — longer than the 2min cron interval
const LAUNCH_TIMEOUT_MS = 120000; // 2 min model turn timeout
const OUTBOX_RETRY_MAX = 3;
const OUTBOX_RETRY_BACKOFF_MS = 60000; // 1 min between retries

// ── Module-level deps (lazy DB init) ─────────────────────────────────────────

let _dbInited = false;
function db() {
  if (!_dbInited) {
    require('../src/db').initDB();
    require('../src/bridge/lipaLane').ensureLipaTables();
    _dbInited = true;
  }
  return require('../src/db').getDB();
}

function log(msg) { console.log(`[LipaTick] ${new Date().toISOString()} ${msg}`); }
function logErr(msg) { console.error(`[LipaTick] ${new Date().toISOString()} ${msg}`); }

// ── Lock ─────────────────────────────────────────────────────────────────────

function acquireLock(holder) {
  const now = Date.now();
  const d = db();
  const tx = d.transaction(() => {
    const row = d.prepare('SELECT value FROM bridge_lipa_state WHERE key = ?').get(LOCK_KEY);
    if (row && row.value) {
      try {
        const lock = JSON.parse(row.value);
        if (lock.expires_at > now) return false; // held by another tick
      } catch (_) { /* corrupt → overwrite */ }
    }
    const val = JSON.stringify({ holder, acquired_at: now, expires_at: now + LOCK_TTL_MS });
    d.prepare(`INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(LOCK_KEY, val, now);
    return true;
  });
  return tx();
}

function releaseLock(holder) {
  const d = db();
  const row = d.prepare('SELECT value FROM bridge_lipa_state WHERE key = ?').get(LOCK_KEY);
  if (row && row.value) {
    try {
      const lock = JSON.parse(row.value);
      if (lock.holder === holder) {
        d.prepare('DELETE FROM bridge_lipa_state WHERE key = ?').run(LOCK_KEY);
      }
    } catch (_) {}
  }
}

// ── Mailbox scan (Lipa-only, no shared pollCycle) ────────────────────────────

async function scanLipaMailbox() {
  const lipaConfig = require('../src/bridge/lipaConfig');
  if (!lipaConfig.enabled || !lipaConfig.valid) {
    log('Lipa lane disabled or invalid config — skip mailbox scan');
    return 0;
  }

  const { ImapFlow } = require('imapflow');
  const inboundConfig = require('../src/bridge/inboundConfig');
  const LIPA_MAILBOX = process.env.LIPA_BRIDGE_MAILBOX || 'Lipa Bridge';
  const lipaLane = require('../src/bridge/lipaLane');

  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: inboundConfig.account, pass: process.env.INSTINCT_BRIDGE_GMAIL_APP_PASSWORD || '' },
    logger: false,
  });

  let enqueued = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock(LIPA_MAILBOX);
    try {
      const messages = [];
      for await (const msg of client.fetch(
        { subject: lipaConfig.inboundSubjectPrefix, since: new Date(Date.now() - 86400000) },
        { uid: true, envelope: true, source: true },
        { uid: true }
      )) {
        messages.push(msg);
      }

      for (const msg of messages) {
        const uid = String(msg.uid);
        const envelope = msg.envelope || {};
        const msgId = envelope.messageId || null;
        const subject = envelope.subject || '';

        // Skip own replies
        if (subject.startsWith(lipaConfig.replySubjectPrefix)) continue;

        // Dedup by message_id + mailbox identity (not UID alone)
        const normMsgId = msgId ? msgId.replace(/^<|>$/g, '').toLowerCase() : null;
        if (normMsgId) {
          const existing = db().prepare(
            'SELECT 1 FROM bridge_inbound_log WHERE gmail_message_id = ? OR gmail_message_id = ? OR gmail_message_id = ?'
          ).get(normMsgId, `<${normMsgId}>`, msgId);
          if (existing) continue;
        } else if (!msgId) {
          const byUid = db().prepare('SELECT 1 FROM bridge_inbound_log WHERE gmail_uid = ? AND from_addr LIKE ?')
            .get(uid, '%' + (lipaConfig.account || '') + '%');
          if (byUid) continue;
        }

        // Parse body
        const rawSource = msg.source ? msg.source.toString('utf8') : '';
        const body = extractPlainBody(rawSource);
        const fromAddr = (envelope.from && envelope.from[0]) ? (envelope.from[0].address || '') : '';

        // Validate auth
        const { valid, command } = lipaLane.validateLipaAuth(body);
        if (!valid) {
          log(`auth failed uid=${uid} from=${fromAddr}`);
          logInbound({ uid, messageId: msgId, from: fromAddr, subject, status: 'lipa_auth_failed' });
          continue;
        }
        if (!command) {
          logInbound({ uid, messageId: msgId, from: fromAddr, subject, status: 'lipa_empty' });
          continue;
        }

        // Parse JSON command
        const parsed = parseCommandPayload(command);
        if (parsed.json && parsed.command === null) {
          logInbound({ uid, messageId: msgId, from: fromAddr, subject, status: 'lipa_parse_error', command: 'malformed_json' });
          continue;
        }

        // Require request_id
        if (!parsed.request_id) {
          log(`missing request_id uid=${uid} — refusing`);
          logInbound({ uid, messageId: msgId, from: fromAddr, subject, status: 'lipa_missing_request_id', command: parsed.command });
          continue;
        }

        // Dedup by request_id in inbox
        const existingReq = db().prepare('SELECT 1 FROM bridge_lipa_inbox WHERE request_id = ?').get(parsed.request_id);
        if (existingReq) {
          log(`duplicate request_id=${parsed.request_id} — skip`);
          logInbound({ uid, messageId: msgId, from: fromAddr, subject, status: 'lipa_duplicate_request_id', command: parsed.command, requestId: parsed.request_id });
          continue;
        }

        // Enqueue BEFORE marking mail handled
        lipaLane.enqueueForLipa({
          requestId: parsed.request_id,
          command: parsed.command,
          args: parsed.args,
          fromAddr,
          subject,
          messageId: msgId,
        });
        enqueued++;
        log(`enqueued request_id=${parsed.request_id} cmd=${parsed.command}`);
        logInbound({ uid, messageId: msgId, from: fromAddr, subject, status: 'lipa_queued', command: parsed.command, requestId: parsed.request_id });
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    if (err.message && err.message.includes('does not exist')) {
      log(`mailbox '${LIPA_MAILBOX}' not found — create the Gmail label first`);
    } else {
      logErr(`mailbox scan failed: ${err.message}`);
    }
  } finally {
    try { await client.logout(); } catch (_) {}
  }
  return enqueued;
}

function logInbound(entry) {
  try {
    db().prepare(`INSERT OR IGNORE INTO bridge_inbound_log
      (gmail_uid, gmail_message_id, from_addr, subject, command, request_id, response_summary, processed_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(String(entry.uid), entry.messageId || 'uid:' + entry.uid, entry.from || null,
        entry.subject || null, entry.command || null, entry.requestId || null,
        null, Date.now(), entry.status || 'ok');
  } catch (_) {}
}

// ── Claim + Launch ───────────────────────────────────────────────────────────

function getExecutionHold() {
  try { return require('../src/bridge/lipaReliability').getExecutionHold(); }
  catch (_) { return null; }
}

function getExecutionState() {
  const row = db().prepare("SELECT value FROM bridge_lipa_state WHERE key = 'execution_state'").get();
  if (!row || !row.value) return null;
  try { return JSON.parse(row.value); } catch (_) { return { state: 'unknown', corrupt: true }; }
}

/**
 * Claim exactly one NEW pending row. Returns the row or null.
 * Refuses if execution hold is active or a previous worker is active/unknown.
 */
function claimOne(sessionId) {
  const hold = getExecutionHold();
  if (hold) { log('execution hold active — no launch'); return null; }

  const execState = getExecutionState();
  if (execState && (execState.state === 'active' || execState.state === 'unknown')) {
    log(`execution_state=${execState.state} — no launch`);
    return null;
  }

  const now = Date.now();
  const d = db();
  const tx = d.transaction(() => {
    const row = d.prepare(
      "SELECT * FROM bridge_lipa_inbox WHERE status = 'pending' AND available_at <= ? ORDER BY created_at ASC LIMIT 1"
    ).get(now);
    if (!row) return null;

    const gen = (row.claim_generation || 0) + 1;
    d.prepare(`UPDATE bridge_lipa_inbox
      SET status = 'claimed', claim_generation = ?, session_id = ?, updated_at = ?
      WHERE id = ?`).run(gen, sessionId, now, row.id);

    // Persist execution state BEFORE launch
    d.prepare(`INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES ('execution_state', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(JSON.stringify({ state: 'active', session_id: sessionId, inbox_id: row.id, started_at: now }), now);

    return { ...row, claim_generation: gen, session_id: sessionId };
  });
  return tx();
}

/**
 * Launch a model turn for the claimed row via OpenClaw CLI.
 * Fresh bounded session per request.
 */
function launchModelTurn(claimedRow, opts = {}) {
  const sessionId = claimedRow.session_id;
  const requestId = claimedRow.request_id;
  const args = JSON.parse(claimedRow.args_json || '{}');

  const message = [
    `LIPA_LANE request_id=${requestId}`,
    `Command: ${claimedRow.command}`,
    `Args: ${JSON.stringify(args)}`,
    '',
    'Handle this read-only request. Reply with a JSON object: {"request_id": "...", "ok": true/false, "result": {...}}.',
    'If the request asks for something mutating or unclear, reply {"ok": false, "result": {"error": "review_required", "message": "..."}}.',
    'Never print secrets. No model switch, key change, or paid probe.',
  ].join('\n');

  const launcher = opts.launcher || defaultLauncher;
  return launcher({
    message,
    sessionId,
    timeoutMs: opts.timeoutMs || LAUNCH_TIMEOUT_MS,
  });
}

function defaultLauncher({ message, sessionId, timeoutMs }) {
  return new Promise((resolve) => {
    const args = ['agent', '-m', message, '--agent', 'personal', '--session-id', sessionId, '--json'];
    let child;
    const stdoutChunks = [];
    const stderrChunks = [];
    try {
      child = spawn('openclaw', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, OPENCLAW_SESSION_ID: sessionId },
      });
    } catch (e) {
      return resolve({ code: null, error: e.message, stdout: '', stderr: '' });
    }

    child.stdout.on('data', (d) => stdoutChunks.push(d));
    child.stderr.on('data', (d) => stderrChunks.push(d));

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch (_) {}
      resolve({ code: null, timedOut: true, stdout: Buffer.concat(stdoutChunks).toString(), stderr: Buffer.concat(stderrChunks).toString() });
    }, timeoutMs);

    child.on('error', (err) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ code: null, error: err.message, stdout: '', stderr: '' });
    });
    child.on('exit', (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdoutChunks).toString(), stderr: Buffer.concat(stderrChunks).toString() });
    });
  });
}

/**
 * Complete a claimed row: mark done, write outbox.
 */
function completeRow(inboxId, claimGen, sessionId, responseObj) {
  const d = db();
  const now = Date.now();
  const tx = d.transaction(() => {
    const row = d.prepare('SELECT * FROM bridge_lipa_inbox WHERE id = ?').get(inboxId);
    if (!row || row.status !== 'claimed' || row.claim_generation !== claimGen) return false;

    d.prepare("UPDATE bridge_lipa_inbox SET status = 'done', processed_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, inboxId);

    // Dedup outbox
    const existing = d.prepare('SELECT id FROM bridge_lipa_outbox WHERE inbox_id = ?').get(inboxId);
    if (!existing) {
      d.prepare(`INSERT INTO bridge_lipa_outbox (inbox_id, request_id, response_json, original_subject, in_reply_to, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(inboxId, row.request_id, JSON.stringify(responseObj), row.subject, row.gmail_message_id, now);
    }

    // Set execution state to terminal
    d.prepare(`INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES ('execution_state', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(JSON.stringify({ state: 'terminal', session_id: sessionId, completed_at: now }), now);

    return true;
  });
  return tx();
}

/**
 * Set execution hold on failure/timeout.
 */
function setHold(reason, sessionId, inboxId) {
  const d = db();
  const now = Date.now();
  const holdVal = JSON.stringify({ active: true, reason, session_id: sessionId, claimed_ids: [inboxId], since: now });
  d.prepare(`INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES ('execution_hold', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(holdVal, now);
  d.prepare(`INSERT INTO bridge_lipa_state (key, value, updated_at) VALUES ('execution_state', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(JSON.stringify({ state: 'unknown', session_id: sessionId, reason, since: now }), now);

  // Mark inbox row as needs_review
  d.prepare("UPDATE bridge_lipa_inbox SET status = 'needs_review', last_error = ?, updated_at = ? WHERE id = ?")
    .run(reason.substring(0, 300), now, inboxId);
}

/**
 * Queue a held/failed status email for the request.
 */
function queueStatusEmail(inboxId, requestId, subject, reason) {
  const responseObj = { request_id: requestId, ok: false, result: { error: 'held', message: reason } };
  const d = db();
  const now = Date.now();
  const existing = d.prepare('SELECT id FROM bridge_lipa_outbox WHERE inbox_id = ?').get(inboxId);
  if (!existing) {
    d.prepare(`INSERT INTO bridge_lipa_outbox (inbox_id, request_id, response_json, original_subject, created_at)
      VALUES (?, ?, ?, ?, ?)`)
      .run(inboxId, requestId, JSON.stringify(responseObj), subject, now);
  }
}

// ── Outbox drain with bounded retry ──────────────────────────────────────────

async function drainOutbox(opts = {}) {
  const sendFn = opts.sendFn || defaultSendReply;
  const d = db();
  const pending = d.prepare(
    "SELECT * FROM bridge_lipa_outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT 10"
  ).all();

  // Also retry failed rows with bounded attempts
  const failedRows = d.prepare(
    "SELECT * FROM bridge_lipa_outbox WHERE status LIKE 'failed:%' ORDER BY created_at ASC LIMIT 5"
  ).all();

  const retryable = failedRows.filter(r => {
    // Parse retry count from status: "failed:N:error" or "failed:error" (legacy=attempt 1)
    const parts = (r.status || '').split(':');
    const attempt = parts.length >= 3 && /^\d+$/.test(parts[1]) ? parseInt(parts[1], 10) : 1;
    if (attempt >= OUTBOX_RETRY_MAX) return false;
    // Backoff: only retry if enough time has passed
    const lastAttempt = r.sent_at || r.created_at;
    return (Date.now() - lastAttempt) > (OUTBOX_RETRY_BACKOFF_MS * attempt);
  });

  for (const row of [...pending, ...retryable]) {
    try {
      await sendFn(row);
      d.prepare("UPDATE bridge_lipa_outbox SET status = 'sent', sent_at = ? WHERE id = ?")
        .run(Date.now(), row.id);
      log(`outbox id=${row.id} sent`);
    } catch (err) {
      // Increment retry count
      const parts = (row.status || '').split(':');
      const attempt = parts.length >= 3 && /^\d+$/.test(parts[1]) ? parseInt(parts[1], 10) + 1 : 2;
      const errMsg = (err.message || '').substring(0, 100);
      d.prepare("UPDATE bridge_lipa_outbox SET status = ?, sent_at = ? WHERE id = ?")
        .run(`failed:${attempt}:${errMsg}`, Date.now(), row.id);
      logErr(`outbox id=${row.id} send failed (attempt ${attempt}): ${errMsg}`);
    }
  }
}

async function defaultSendReply(outboxRow) {
  const lipaLane = require('../src/bridge/lipaLane');
  return lipaLane.sendLipaReply(outboxRow);
}

// ── Command parsing (extracted from inbound.js, not imported) ────────────────

function parseCommandPayload(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.command === 'string') {
        return { json: true, command: parsed.command.toLowerCase().trim(), args: parsed.args || {}, request_id: parsed.request_id || null };
      }
    } catch (_) {
      return { json: true, command: null, args: {}, request_id: null, parseError: trimmed.substring(0, 200) };
    }
  }
  return { json: false, command: trimmed.toLowerCase(), args: {}, request_id: null };
}

function extractPlainBody(raw) {
  if (!raw) return '';
  const headerEnd = raw.indexOf('\r\n\r\n');
  const altEnd = raw.indexOf('\n\n');
  const splitAt = headerEnd !== -1 ? headerEnd + 4 : (altEnd !== -1 ? altEnd + 2 : -1);
  if (splitAt === -1) return '';
  return raw.substring(splitAt).replace(/--[^\r\n]+--\s*$/, '').trim();
}

// ── List existing pending/unknown rows (no automatic replay) ─────────────────

function listExistingWork() {
  const d = db();
  const pending = d.prepare("SELECT id, request_id, status, created_at FROM bridge_lipa_inbox WHERE status IN ('pending','claimed','retry','needs_review') ORDER BY created_at ASC").all();
  return pending;
}

// ── Main tick ────────────────────────────────────────────────────────────────

async function tick(opts = {}) {
  const holder = `tick-${process.pid}-${Date.now()}`;
  const result = { scanned: false, enqueued: 0, launched: false, completed: false, drained: false, error: null };

  // 1. Acquire lock
  if (!acquireLock(holder)) {
    log('lock held by another tick — exit');
    return { ...result, error: 'lock_held' };
  }

  try {
    // 2. Scan mailbox (no model turn)
    if (!opts.skipMailbox) {
      try {
        result.enqueued = await scanLipaMailbox();
        result.scanned = true;
      } catch (err) {
        logErr(`mailbox scan error: ${err.message}`);
      }
    } else {
      result.scanned = true;
    }

    // 3. List existing pending/unknown work (no automatic replay)
    const existingWork = listExistingWork();
    if (existingWork.length > 0) {
      log(`existing work: ${existingWork.map(r => `${r.request_id}(${r.status})`).join(', ')}`);
    }

    // 4. Claim one NEW pending row (if no hold/active worker)
    const sessionId = `lipa-lane-${process.pid}-${Date.now()}`;
    const claimed = claimOne(sessionId);
    if (claimed) {
      log(`claimed inbox_id=${claimed.id} request_id=${claimed.request_id}`);

      // 5. Launch model turn
      result.launched = true;
      const launchResult = await launchModelTurn(claimed, opts);

      if (launchResult.timedOut) {
        logErr(`timeout request_id=${claimed.request_id}`);
        setHold(`timeout after ${LAUNCH_TIMEOUT_MS}ms`, sessionId, claimed.id);
        queueStatusEmail(claimed.id, claimed.request_id, claimed.subject, `Model turn timed out after ${LAUNCH_TIMEOUT_MS}ms`);
      } else if (launchResult.code !== 0) {
        const errInfo = launchResult.error || `exit code ${launchResult.code}`;
        const isBilling = (launchResult.stderr || '').includes('billing') || (launchResult.stderr || '').includes('credit balance');
        logErr(`launch failed request_id=${claimed.request_id}: ${errInfo}`);
        setHold(isBilling ? `billing error: ${errInfo}` : `launch failed: ${errInfo}`, sessionId, claimed.id);
        queueStatusEmail(claimed.id, claimed.request_id, claimed.subject, isBilling ? `Billing/auth error: ${errInfo}` : `Model turn failed: ${errInfo}`);
      } else {
        // Parse response from stdout
        const stdout = launchResult.stdout || '';
        let responseObj;
        try {
          // The agent output should contain the JSON response
          const jsonMatch = stdout.match(/\{[\s\S]*"request_id"[\s\S]*\}/);
          if (jsonMatch) {
            responseObj = JSON.parse(jsonMatch[0]);
          } else {
            // Treat the whole stdout as the response
            responseObj = { request_id: claimed.request_id, ok: true, result: { reply: stdout.trim().substring(0, 5000) } };
          }
        } catch (_) {
          responseObj = { request_id: claimed.request_id, ok: true, result: { reply: stdout.trim().substring(0, 5000) } };
        }

        if (completeRow(claimed.id, claimed.claim_generation, sessionId, responseObj)) {
          result.completed = true;
          log(`completed request_id=${claimed.request_id}`);
        } else {
          logErr(`completion fenced request_id=${claimed.request_id}`);
          setHold(`completion fenced — row moved during launch`, sessionId, claimed.id);
          queueStatusEmail(claimed.id, claimed.request_id, claimed.subject, 'Completion fenced — row state changed during launch');
        }
      }
    }

    // 6. Drain outbox
    try {
      await drainOutbox(opts);
      result.drained = true;
    } catch (err) {
      logErr(`outbox drain error: ${err.message}`);
    }

  } finally {
    releaseLock(holder);
  }

  return result;
}

// ── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  tick()
    .then((res) => {
      if (res.launched) log(`tick result: launched=${res.launched} completed=${res.completed}`);
      else if (res.enqueued > 0) log(`tick result: enqueued=${res.enqueued}`);
      // else: quiet tick, no output (don't spam cron mail)
      process.exit(0);
    })
    .catch((err) => {
      logErr(`tick error: ${err.message}`);
      process.exit(0); // always exit clean for cron
    });
}

// ── Exports for testing ──────────────────────────────────────────────────────

module.exports = {
  tick,
  acquireLock,
  releaseLock,
  claimOne,
  completeRow,
  setHold,
  queueStatusEmail,
  drainOutbox,
  listExistingWork,
  parseCommandPayload,
  // constants
  LOCK_KEY,
  LOCK_TTL_MS,
  OUTBOX_RETRY_MAX,
};
