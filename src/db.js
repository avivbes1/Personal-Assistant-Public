const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'family.db');

let db;

function initDB() {
  const fs = require('fs');
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      body TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      processed INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER,
      title TEXT NOT NULL,
      start_time TEXT,
      end_time TEXT,
      location TEXT,
      added_to_calendar INTEGER DEFAULT 0,
      calendar_owner TEXT,
      FOREIGN KEY (message_id) REFERENCES messages(id)
    );

    CREATE TABLE IF NOT EXISTS action_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER,
      description TEXT NOT NULL,
      due_date TEXT,
      done INTEGER DEFAULT 0,
      FOREIGN KEY (message_id) REFERENCES messages(id)
    );

    CREATE TABLE IF NOT EXISTS clarifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER,
      question TEXT NOT NULL,
      answered INTEGER DEFAULT 0,
      answer TEXT,
      FOREIGN KEY (message_id) REFERENCES messages(id)
    );

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      related_to TEXT,
      description TEXT,
      added_at INTEGER NOT NULL,
      configured INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS processed_msgs (
      msg_id TEXT PRIMARY KEY,
      processed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      event_title TEXT NOT NULL,
      event_start TEXT NOT NULL,
      remind_at TEXT NOT NULL,
      label TEXT NOT NULL,
      owner TEXT DEFAULT 'both',
      sent INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS digest_log (
      date TEXT PRIMARY KEY,
      sent_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS follow_ups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      event_title TEXT NOT NULL,
      event_start TEXT NOT NULL,
      owner TEXT NOT NULL,
      ask_at TEXT NOT NULL,
      bot_msg_id TEXT,
      status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );
  `);

  // Bot tasks — things Tudat itself needs to do (check-ins, follow-throughs, deferred actions)
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT NOT NULL,
      check_in_message TEXT NOT NULL,
      run_at INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      recurring INTEGER DEFAULT 0,
      interval_ms INTEGER DEFAULT 0,
      time_of_day TEXT DEFAULT NULL,
      stop_on_confirm INTEGER DEFAULT 0,
      group_key TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  // Add new columns to existing bot_tasks table if they don't exist yet (migration)
  try { getDB().prepare('ALTER TABLE bot_tasks ADD COLUMN recurring INTEGER DEFAULT 0').run(); } catch (_) {}
  try { getDB().prepare('ALTER TABLE bot_tasks ADD COLUMN interval_ms INTEGER DEFAULT 0').run(); } catch (_) {}
  try { getDB().prepare('ALTER TABLE bot_tasks ADD COLUMN time_of_day TEXT DEFAULT NULL').run(); } catch (_) {}
  try { getDB().prepare('ALTER TABLE bot_tasks ADD COLUMN stop_on_confirm INTEGER DEFAULT 0').run(); } catch (_) {}
  try { getDB().prepare('ALTER TABLE bot_tasks ADD COLUMN group_key TEXT DEFAULT NULL').run(); } catch (_) {}
  try { getDB().prepare('ALTER TABLE bot_tasks ADD COLUMN target_phone TEXT').run(); } catch (_) {}
  try { getDB().prepare("ALTER TABLE bot_tasks ADD COLUMN task_type TEXT DEFAULT 'check_in'").run(); } catch (_) {}
  try { getDB().prepare('ALTER TABLE bot_tasks ADD COLUMN retry_count INTEGER DEFAULT 0').run(); } catch (_) {}


  // Capability requests — new features requested via chat, pending development
  db.exec(`
    CREATE TABLE IF NOT EXISTS capability_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      spec_json TEXT,
      status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );
  `);

  // Persistent pending group questions (survives restarts)
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_group_questions (
      msg_id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  // Notices — family-relevant info extracted from monitored groups, with resolved relevance dates
  db.exec(`
    CREATE TABLE IF NOT EXISTS notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_name TEXT NOT NULL,
      content TEXT NOT NULL,
      relevance_date TEXT,
      relevance_time TEXT,
      source_timestamp INTEGER NOT NULL,
      dismissed INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  // Safe migration for existing DBs
  try { getDB().prepare('ALTER TABLE notices ADD COLUMN relevance_time TEXT').run(); } catch (_) {}
  try { getDB().prepare('ALTER TABLE notices ADD COLUMN row_type TEXT DEFAULT \'original\'').run(); } catch (_) {}
  try { getDB().prepare('ALTER TABLE notices ADD COLUMN sources TEXT').run(); } catch (_) {}
  // Backfill sources for existing rows that don't have it yet
  try {
    getDB().prepare(`UPDATE notices SET row_type='original', sources=json_array(group_name) WHERE sources IS NULL`).run();
  } catch (_) {}

  // Phase 1: Conversation history (per user, rolling window)
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conv_user ON conversation_history(user_id, timestamp);
  `);

  // Phase 3: Pending actions awaiting confirmation or clarification
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_actions (
      user_id TEXT PRIMARY KEY,
      action_type TEXT NOT NULL,
      params TEXT NOT NULL,
      missing_params TEXT,
      confirmation_text TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);

  // Family members registry
  db.exec(`
    CREATE TABLE IF NOT EXISTS family_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_he TEXT NOT NULL,
      name_en TEXT,
      nicknames TEXT,
      role TEXT,
      calendar_id TEXT,
      notes TEXT
    );
  `);

  // Seed family members if table is empty
  const memberCount = db.prepare('SELECT COUNT(*) as c FROM family_members').get();
  if (memberCount.c === 0) {
    const seedPath = require('path').join(__dirname, '../config/family-seed.json');
    if (require('fs').existsSync(seedPath)) {
      const seed = JSON.parse(require('fs').readFileSync(seedPath, 'utf8'));
      const config = require('./config');
      const insert = db.prepare('INSERT INTO family_members (name_he, name_en, nicknames, role, calendar_id, notes) VALUES (?, ?, ?, ?, ?, ?)');
      for (const m of seed.members) {
        const calId = m.role === 'parent' && !m.calendar_id
          ? (insert.run.length === 0 ? config.AVIV_CALENDAR_ID : config.LIAT_CALENDAR_ID)
          : (m.calendar_id || null);
        insert.run(m.name_he, m.name_en, JSON.stringify(m.nicknames || []), m.role, calId, m.notes || '');
      }
      console.log('[DB] Seeded family_members from config/family-seed.json');
    } else {
      console.warn('[DB] No config/family-seed.json found — family_members table is empty. Copy config/family-seed.example.json to get started.');
    }
  }

  // ── Homework tracking ──────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS homework (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      child_name   TEXT NOT NULL,
      subject      TEXT,
      description  TEXT NOT NULL,
      due_date     TEXT,
      source_group TEXT,
      message_id   INTEGER,
      done         INTEGER DEFAULT 0,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hw_child_due ON homework(child_name, due_date, done);
    CREATE INDEX IF NOT EXISTS idx_hw_due       ON homework(due_date, done);
  `);

  // ── Homework & groups safe migrations ─────────────────────────────────────
  try { db.exec('ALTER TABLE homework ADD COLUMN updated_at INTEGER'); } catch (_) {}
  try { db.exec('ALTER TABLE groups ADD COLUMN primary_child TEXT'); } catch (_) {}

  // Create UNIQUE dedup index on homework (idempotent)
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_hw_unique ON homework(child_name, COALESCE(due_date,\'\'), COALESCE(subject,\'\'), SUBSTR(description,1,80))');
  } catch (_) {}

  // Populate primary_child from known group names
  try {
    const seedPath = require('path').join(__dirname, '../config/family-seed.json');
    if (require('fs').existsSync(seedPath)) {
      const seed = JSON.parse(require('fs').readFileSync(seedPath, 'utf8'));
      const upd = db.prepare("UPDATE groups SET primary_child=? WHERE name=? AND primary_child IS NULL");
      for (const cg of (seed.childGroups || [])) upd.run(cg.child_name_he || cg.child_name_en, cg.group_name);
    }
  } catch (_) {}

  // OAuth tokens table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      user_id       TEXT PRIMARY KEY,
      email         TEXT,
      access_token  TEXT,
      refresh_token TEXT,
      expiry_date   INTEGER,
      scope         TEXT,
      token_type    TEXT,
      created_at    INTEGER DEFAULT (unixepoch() * 1000),
      updated_at    INTEGER DEFAULT (unixepoch() * 1000),
      last_error    TEXT,
      last_error_at INTEGER
    );
  `);

  // ── Calendar Intent Queue (Step 6 — cross-source dedup & conflict tracking) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_intents (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source       TEXT NOT NULL,        -- 'cron' | 'realtime' | 'manual'
      event_title  TEXT NOT NULL,
      event_date   TEXT,                 -- YYYY-MM-DD
      event_start  TEXT,                 -- ISO datetime or null
      event_end    TEXT,
      raw_message  TEXT,
      status       TEXT DEFAULT 'pending', -- 'pending' | 'applied' | 'superseded' | 'failed'
      calendar_event_id TEXT,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cal_intents_date ON calendar_intents(event_date, status);
  `);

  // Migrations — add columns that may not exist in older DBs
  try { db.exec("ALTER TABLE reminders ADD COLUMN owner TEXT DEFAULT 'both'"); } catch (_) {}
  try { db.exec("ALTER TABLE groups ADD COLUMN description TEXT"); } catch (_) {}

  // ── Phase 1: Notice Pipeline Migration ──────────────────────────────────────

  // New tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_buffer (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id          TEXT UNIQUE NOT NULL,
      group_jid           TEXT NOT NULL,
      group_name          TEXT NOT NULL,
      sender_name         TEXT,
      content             TEXT NOT NULL,
      message_timestamp   INTEGER NOT NULL,
      received_at         INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      extracted           INTEGER NOT NULL DEFAULT 0,
      extraction_batch_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_msgbuf_extracted ON message_buffer(extracted);
    CREATE INDEX IF NOT EXISTS idx_msgbuf_received  ON message_buffer(received_at);
    CREATE INDEX IF NOT EXISTS idx_msgbuf_group     ON message_buffer(group_jid, extracted);

    CREATE TABLE IF NOT EXISTS extraction_runs (
      id                  TEXT PRIMARY KEY,
      started_at          INTEGER NOT NULL,
      completed_at        INTEGER,
      messages_processed  INTEGER DEFAULT 0,
      notices_created     INTEGER DEFAULT 0,
      status              TEXT DEFAULT 'running',
      error_message       TEXT
    );

    CREATE TABLE IF NOT EXISTS delivery_runs (
      id                  TEXT PRIMARY KEY,
      started_at          INTEGER NOT NULL,
      completed_at        INTEGER,
      notices_delivered   INTEGER DEFAULT 0,
      notices_failed      INTEGER DEFAULT 0,
      status              TEXT DEFAULT 'running'
    );
  `);

  // New columns on notices (safe migrations)
  try { db.exec("ALTER TABLE notices ADD COLUMN tier TEXT DEFAULT 'informational'"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN delivery_attempts INTEGER DEFAULT 0"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN last_attempt_at INTEGER"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN extraction_batch_id TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN source_message_ids TEXT"); } catch (_) {}
  // Full schema migration — adds all columns missing from original CREATE TABLE
  // (safe on existing DBs — try/catch skips if already present)
  try { db.exec("ALTER TABLE notices ADD COLUMN urgency_hint TEXT DEFAULT 'routine'"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN relevant_datetime INTEGER"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN delivery_status TEXT DEFAULT 'pending'"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN delivered_at INTEGER"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN batch_id TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN posted_to_master INTEGER DEFAULT 0"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN sent_to_master INTEGER DEFAULT 0"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN send_attempted_at TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN is_backlog INTEGER DEFAULT 0"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN message_timestamp INTEGER"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN triage_decision TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN triage_reason TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN triaged_at INTEGER"); } catch (_) {}

  // Notice threads — topic continuity across multiple messages
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notice_threads (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_key       TEXT    UNIQUE NOT NULL,
        description      TEXT,
        source_group     TEXT,
        first_noticed_at INTEGER NOT NULL,
        last_delivered_at INTEGER,
        dismissed        INTEGER DEFAULT 0,
        dismissed_at     INTEGER,
        dismissed_reason TEXT
      )
    `);
  } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN thread_id INTEGER"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN thread_key TEXT"); } catch (_) {}

  // Backfill tier from urgency_hint for existing rows
  try {
    db.exec(`
      UPDATE notices SET tier =
        CASE urgency_hint
          WHEN 'immediate'      THEN 'critical'
          WHEN 'time_sensitive' THEN 'actionable'
          ELSE 'informational'
        END
      WHERE tier IS NULL OR tier = 'informational' AND urgency_hint IN ('immediate','time_sensitive')
    `);
  } catch (_) {}

  // topic_dismissals — stores user "stop sending about X" commands
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS topic_dismissals (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        dismissed_by TEXT NOT NULL,
        scope_type   TEXT NOT NULL,     -- 'topic_key' | 'source_group' | 'all'
        scope_value  TEXT,              -- topic_key, group name fragment, or NULL for 'all'
        dismissed_at INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,  -- epoch ms; default +48h
        raw_command  TEXT               -- original message for audit
      )
    `);
  } catch (_) {}

  // New columns on sent_messages (safe migrations)
  try { db.exec('ALTER TABLE sent_messages ADD COLUMN group_name TEXT'); } catch (_) {}

  // ISSUE-015: unique index to prevent duplicate messages regardless of call path
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedup ON messages(group_id, timestamp, body)`);
  } catch (_) {}

  console.log('[DB] Initialized at', DB_PATH);
  return db;
}

function getDB() {
  if (!db) throw new Error('DB not initialized. Call initDB() first.');
  return db;
}

function saveMessage({ group_id, sender, body, timestamp }) {
  const ts = timestamp || Date.now();
  const stmt = getDB().prepare(
    'INSERT OR IGNORE INTO messages (group_id, sender, body, timestamp, processed) VALUES (?, ?, ?, ?, 0)'
  );
  const result = stmt.run(group_id, sender, body, ts);
  if (result.changes > 0) return result.lastInsertRowid;
  // Already existed — return the existing row id
  const existing = getDB().prepare(
    'SELECT id FROM messages WHERE group_id=? AND timestamp=? AND body=? LIMIT 1'
  ).get(group_id, ts, body);
  return existing?.id ?? null;
}

function markMessageProcessed(id) {
  getDB().prepare('UPDATE messages SET processed = 1 WHERE id = ?').run(id);
}

/**
 * Fetch recent messages from a monitored group for context.
 * Returns up to `limit` messages ordered oldest-first.
 */
function getRecentGroupMessages(groupId, limit = 20) {
  return getDB().prepare(
    'SELECT sender, body, timestamp FROM messages WHERE group_id=? ORDER BY timestamp DESC LIMIT ?'
  ).all(groupId, limit).reverse();
}

// Hebrew stop words for notice clustering
const NOTICE_STOP_WORDS = new Set(['\u05e9\u05dc', '\u05e2\u05dd', '\u05d0\u05ea', '\u05e2\u05dc', '\u05dc\u05d0', '\u05d9\u05e9', '\u05d4\u05d9\u05d5\u05dd', '\u05de\u05d7\u05e8', '\u05d1\u05e9\u05e2\u05d4', '\u05d2\u05e0\u05d9', '\u05d4\u05d5\u05e8\u05d9', '\u05db\u05d9\u05ea\u05d4', '\u05d9\u05dc\u05d3\u05d9']);

function _extractNoticeKeywords(text) {
  return [...new Set((text || '').split(/\s+/).filter(w => w.length >= 4 && !NOTICE_STOP_WORDS.has(w)))];
}

function _extractNoticeTimes(text) {
  return (text || '').match(/\b\d{1,2}:\d{2}\b/g) || [];
}

function saveNotice({ group_name, content, relevance_date, relevance_time, source_timestamp, urgency_hint, relevant_datetime, message_timestamp, delivery_status }) {
  // Deduplicate: same group + same content snippet + same relevance_date
  const snippet = (content || '').substring(0, 80);
  const existing = getDB().prepare(
    'SELECT id FROM notices WHERE group_name=? AND substr(content,1,80)=? AND relevance_date IS ? AND dismissed=0 LIMIT 1'
  ).get(group_name, snippet, relevance_date || null);
  if (existing) return existing.id;
  const result = getDB().prepare(
    `INSERT INTO notices
      (group_name, content, relevance_date, relevance_time, source_timestamp, dismissed, created_at, row_type, sources,
       urgency_hint, relevant_datetime, message_timestamp, delivery_status)
     VALUES (?, ?, ?, ?, ?, 0, ?, 'original', ?, ?, ?, ?, ?)`
  ).run(
    group_name, content, relevance_date || null, relevance_time || null,
    source_timestamp || Date.now(), Date.now(), JSON.stringify([group_name]),
    urgency_hint || 'routine', relevant_datetime || null,
    message_timestamp || source_timestamp || Date.now(),
    delivery_status || 'pending'
  );
  return result.lastInsertRowid;
}

function getActiveNotices(todayStr) {
  // Returns notices whose relevance_date is today or future, or undated ones
  return getDB().prepare(
    `SELECT id, group_name, content, relevance_date, relevance_time, source_timestamp
     FROM notices
     WHERE dismissed = 0
       AND (relevance_date IS NULL OR relevance_date >= ?)
     ORDER BY relevance_date ASC NULLS LAST, source_timestamp DESC
     LIMIT 20`
  ).all(todayStr);
}

function saveEvent({ message_id, title, start_time, end_time, location, calendar_owner }) {
  const stmt = getDB().prepare(
    'INSERT INTO events (message_id, title, start_time, end_time, location, added_to_calendar, calendar_owner) VALUES (?, ?, ?, ?, ?, 0, ?)'
  );
  const result = stmt.run(message_id, title, start_time, end_time, location, calendar_owner);
  return result.lastInsertRowid;
}

function markEventAdded(id) {
  getDB().prepare('UPDATE events SET added_to_calendar = 1 WHERE id = ?').run(id);
}

function saveActionItem({ message_id, description, due_date }) {
  // Dedup: skip if a non-done task with same first 60 chars already exists
  const prefix = (description || '').trim().substring(0, 60);
  const existing = getDB().prepare(
    'SELECT id FROM action_items WHERE done=0 AND substr(description,1,60)=? LIMIT 1'
  ).get(prefix);
  if (existing) {
    console.log(`[DB] Skipped duplicate task (matches id=${existing.id})`);
    return existing.id;
  }
  const stmt = getDB().prepare(
    'INSERT INTO action_items (message_id, description, due_date, done) VALUES (?, ?, ?, 0)'
  );
  const result = stmt.run(message_id, description, due_date || null);
  return result.lastInsertRowid;
}

function saveClarification({ message_id, question }) {
  const stmt = getDB().prepare(
    'INSERT INTO clarifications (message_id, question, answered, answer) VALUES (?, ?, 0, NULL)'
  );
  const result = stmt.run(message_id, question);
  return result.lastInsertRowid;
}

function getPendingActionItems() {
  return getDB().prepare('SELECT * FROM action_items WHERE done = 0 ORDER BY due_date ASC').all();
}

function getUnansweredClarifications() {
  return getDB().prepare('SELECT * FROM clarifications WHERE answered = 0').all();
}

// ── Groups ────────────────────────────────────────────────────────────────────

function saveGroup(id, name) {
  getDB()
    .prepare('INSERT OR IGNORE INTO groups (id, name, added_at, configured) VALUES (?, ?, ?, 0)')
    .run(id, name, Date.now());
}

function setGroupRelatedTo(id, relatedTo) {
  getDB()
    .prepare('UPDATE groups SET related_to = ?, configured = 1 WHERE id = ?')
    .run(relatedTo, id);
}

function setGroupDescription(id, description) {
  getDB()
    .prepare('UPDATE groups SET description = ? WHERE id = ?')
    .run(description, id);
}

// ── Persistent pending group questions ────────────────────────────────────────
function savePendingGroupQuestion(msgId, groupId) {
  getDB().prepare('INSERT OR REPLACE INTO pending_group_questions (msg_id, group_id, created_at) VALUES (?, ?, ?)').run(msgId, groupId, Date.now());
}

function getPendingGroupQuestion(msgId) {
  const row = getDB().prepare('SELECT group_id FROM pending_group_questions WHERE msg_id = ?').get(msgId);
  return row ? row.group_id : null;
}

function deletePendingGroupQuestion(msgId) {
  getDB().prepare('DELETE FROM pending_group_questions WHERE msg_id = ?').run(msgId);
}

function getAllPendingGroupQuestions() {
  return getDB().prepare('SELECT * FROM pending_group_questions').all();
}

function getGroup(id) {
  return getDB().prepare('SELECT * FROM groups WHERE id = ?').get(id);
}

function getUnconfiguredGroups() {
  return getDB().prepare('SELECT * FROM groups WHERE configured = 0').all();
}

function getMonitoredGroupsWithoutDescription() {
  // Only ask about groups added in the last 7 days — avoid spamming about long-known groups
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return getDB().prepare(
    "SELECT * FROM groups WHERE related_to = 'monitored' AND (description IS NULL OR description = '') AND added_at > ?"
  ).all(sevenDaysAgo);
}

// ── Processed message dedup ───────────────────────────────────────────────────

function isMessageProcessed(msgId) {
  return !!getDB().prepare('SELECT 1 FROM processed_msgs WHERE msg_id = ?').get(msgId);
}

function markMsgProcessed(msgId) {
  getDB().prepare('INSERT OR IGNORE INTO processed_msgs (msg_id, processed_at) VALUES (?, ?)').run(msgId, Date.now());
}

// ── Reminders ─────────────────────────────────────────────────────────────────

function saveReminder({ event_id, event_title, event_start, remind_at, label, owner = 'both' }) {
  // Primary dedup: same event_id + label
  const byId = getDB().prepare('SELECT id FROM reminders WHERE event_id = ? AND label = ?').get(event_id, label);
  if (byId) return byId.id;
  // Secondary dedup: same title + remind_at (catches same event on multiple calendars with different IDs)
  const byTitle = getDB().prepare('SELECT id FROM reminders WHERE event_title = ? AND remind_at = ? AND label = ?').get(event_title, remind_at, label);
  if (byTitle) return byTitle.id;

  const result = getDB().prepare(
    'INSERT INTO reminders (event_id, event_title, event_start, remind_at, label, owner, sent, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)'
  ).run(event_id, event_title, event_start, remind_at, label, owner, Date.now());
  return result.lastInsertRowid;
}

/**
 * Mark all unsent reminders for a given calendar event ID as cancelled (sent=1).
 * Call this when an event is deleted from the calendar.
 */
function cancelRemindersForEvent(eventId) {
  const result = getDB().prepare('UPDATE reminders SET sent = 1 WHERE event_id = ? AND sent = 0').run(eventId);
  return result.changes;
}

function getPendingReminders() {
  return getDB().prepare('SELECT * FROM reminders WHERE sent = 0 ORDER BY remind_at ASC').all();
}

function markReminderSent(id) {
  getDB().prepare('UPDATE reminders SET sent = 1 WHERE id = ?').run(id);
}

// ── Follow-ups ────────────────────────────────────────────────────────────────

function saveFollowUp({ event_id, event_title, event_start, owner, ask_at }) {
  // Upsert: if pending follow-up exists for this event, update ask_at (fixes duplicate-timer bug).
  // If status != pending (already sent/cancelled), do nothing.
  const existing = getDB().prepare('SELECT id, status FROM follow_ups WHERE event_id = ?').get(event_id);
  if (existing) {
    if (existing.status === 'pending') {
      getDB().prepare('UPDATE follow_ups SET ask_at=?, event_title=?, event_start=?, owner=? WHERE id=?')
        .run(ask_at, event_title, event_start, owner, existing.id);
    }
    return existing.id;
  }
  const result = getDB().prepare(
    'INSERT INTO follow_ups (event_id, event_title, event_start, owner, ask_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(event_id, event_title, event_start, owner, ask_at, 'pending', Date.now());
  return result.lastInsertRowid;
}

function getPendingFollowUps() {
  return getDB().prepare("SELECT * FROM follow_ups WHERE status = 'pending' ORDER BY ask_at ASC").all();
}

function claimFollowUp(id) {
  const result = getDB().prepare("UPDATE follow_ups SET status = 'asked' WHERE id = ? AND status = 'pending'").run(id);
  return result.changes > 0;
}

function setFollowUpBotMsgId(id, botMsgId) {
  getDB().prepare('UPDATE follow_ups SET bot_msg_id = ? WHERE id = ?').run(botMsgId, id);
}

function getFollowUpByBotMsgId(botMsgId) {
  return getDB().prepare('SELECT * FROM follow_ups WHERE bot_msg_id = ?').get(botMsgId);
}

// ── Bot Tasks ─────────────────────────────────────────────────────────────────

// ── Capability Requests ───────────────────────────────────────────────────────

function saveCapabilityRequest({ title, description, spec_json }) {
  const result = getDB().prepare(
    'INSERT INTO capability_requests (title, description, spec_json, status, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(title, description, spec_json ? JSON.stringify(spec_json) : null, 'pending', Date.now());
  return result.lastInsertRowid;
}

function getPendingCapabilityRequests() {
  return getDB().prepare("SELECT * FROM capability_requests WHERE status = 'pending' ORDER BY created_at DESC").all();
}

// ── Bot Tasks ─────────────────────────────────────────────────────────────────

function saveBotTask({ description, check_in_message, run_at, recurring = 0, interval_ms = 0, time_of_day = null, stop_on_confirm = 0, group_key = null, target_phone = null, task_type = 'check_in' }) {
  const result = getDB().prepare(
    'INSERT INTO bot_tasks (description, check_in_message, run_at, status, recurring, interval_ms, time_of_day, stop_on_confirm, group_key, target_phone, task_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(description, check_in_message, run_at, 'pending', recurring ? 1 : 0, interval_ms, time_of_day, stop_on_confirm ? 1 : 0, group_key, target_phone, task_type, Date.now());
  return result.lastInsertRowid;
}

function getPendingBotTasks() {
  return getDB().prepare('SELECT * FROM bot_tasks WHERE status = ? ORDER BY run_at ASC').all('pending');
}

function claimBotTask(id) {
  const result = getDB().prepare("UPDATE bot_tasks SET status = 'done' WHERE id = ? AND status = 'pending'").run(id);
  return result.changes > 0;
}

/** Cancel all pending tasks in a recurring group */
function cancelRecurringGroup(group_key) {
  const result = getDB().prepare("UPDATE bot_tasks SET status = 'cancelled' WHERE group_key = ? AND status = 'pending'").run(group_key);
  return result.changes;
}

/** Check if a recurring group has been confirmed/cancelled */
function isRecurringGroupActive(group_key) {
  const row = getDB().prepare("SELECT id FROM bot_tasks WHERE group_key = ? AND status = 'pending' LIMIT 1").get(group_key);
  return !!row;
}

function cancelFollowUpsForEvent(eventId) {
  const result = getDB().prepare(
    "UPDATE follow_ups SET status = 'cancelled' WHERE event_id = ? AND status IN ('pending', 'asked')"
  ).run(eventId);
  return result.changes;
}

function updateFollowUpStatus(id, status) {
  getDB().prepare('UPDATE follow_ups SET status = ? WHERE id = ?').run(status, id);
}

/**
 * Check if any reminders exist for a given Google Calendar event ID.
 */
function hasReminder(eventId) {
  return !!getDB().prepare('SELECT 1 FROM reminders WHERE event_id = ? LIMIT 1').get(eventId);
}

/**
 * Atomically claim a reminder for sending.
 * Returns true if this caller "won" the claim (sent was 0 and is now 1).
 * Returns false if already sent — used to prevent double-fire across instances/timeouts.
 */
function claimReminder(id) {
  const result = getDB().prepare('UPDATE reminders SET sent = 1 WHERE id = ? AND sent = 0').run(id);
  return result.changes > 0;
}

/**
 * Atomically claim the morning digest for today.
 * Returns true if this caller "won" (digest not yet sent today).
 * Returns false if already sent — prevents duplicate digests across instances.
 * @param {string} date — YYYY-MM-DD in local timezone
 */
function claimDigestToday(date) {
  const result = getDB().prepare('INSERT OR IGNORE INTO digest_log (date, sent_at) VALUES (?, ?)').run(date, Date.now());
  return result.changes > 0;
}

// ── Conversation history ───────────────────────────────────────────────────────
function addToConversationHistory(userId, role, content) {
  getDB().prepare('INSERT INTO conversation_history (user_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(userId, role, content, Date.now());
  // Keep only last 50 per user to avoid unbounded growth
  getDB().prepare('DELETE FROM conversation_history WHERE user_id = ? AND id NOT IN (SELECT id FROM conversation_history WHERE user_id = ? ORDER BY timestamp DESC LIMIT 50)').run(userId, userId);
}

function getConversationHistory(userId, limit = 10) {
  return getDB().prepare('SELECT role, content, timestamp FROM conversation_history WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?').all(userId, limit).reverse();
}

// ── Pending actions ────────────────────────────────────────────────────────────
function setPendingAction(userId, actionType, params, missingParams, confirmationText, expiresInMs = 10 * 60 * 1000) {
  const now = Date.now();
  getDB().prepare('INSERT OR REPLACE INTO pending_actions (user_id, action_type, params, missing_params, confirmation_text, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(userId, actionType, JSON.stringify(params), JSON.stringify(missingParams || []), confirmationText || '', now, now + expiresInMs);
}

function getPendingAction(userId) {
  const row = getDB().prepare('SELECT * FROM pending_actions WHERE user_id = ? AND expires_at > ?').get(userId, Date.now());
  if (!row) return null;
  return { ...row, params: JSON.parse(row.params), missing_params: JSON.parse(row.missing_params || '[]') };
}

function clearPendingAction(userId) {
  getDB().prepare('DELETE FROM pending_actions WHERE user_id = ?').run(userId);
}

function clearExpiredPendingActions() {
  return getDB().prepare('DELETE FROM pending_actions WHERE expires_at < ?').run(Date.now()).changes;
}

// ── OAuth tokens ──────────────────────────────────────────────────────────────
function getToken(userId) {
  return getDB().prepare('SELECT * FROM tokens WHERE user_id = ?').get(userId);
}

function saveToken(userId, email, tokens) {
  const existing = getToken(userId);
  const merged = {
    access_token:  tokens.access_token  || existing?.access_token,
    refresh_token: tokens.refresh_token || existing?.refresh_token,
    expiry_date:   tokens.expiry_date   ?? existing?.expiry_date,
    scope:         tokens.scope         || existing?.scope,
    token_type:    tokens.token_type    || existing?.token_type,
  };
  getDB().prepare(`
    INSERT INTO tokens (user_id, email, access_token, refresh_token, expiry_date, scope, token_type, updated_at)
    VALUES (@user_id, @email, @access_token, @refresh_token, @expiry_date, @scope, @token_type, @updated_at)
    ON CONFLICT(user_id) DO UPDATE SET
      email         = excluded.email,
      access_token  = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expiry_date   = excluded.expiry_date,
      scope         = excluded.scope,
      token_type    = excluded.token_type,
      updated_at    = excluded.updated_at,
      last_error    = NULL,
      last_error_at = NULL
  `).run({ user_id: userId, email: email || existing?.email || '', ...merged, updated_at: Date.now() });
}

function setTokenError(userId, errorMsg) {
  getDB().prepare('UPDATE tokens SET last_error = ?, last_error_at = ? WHERE user_id = ?')
    .run(errorMsg, Date.now(), userId);
}

function migrateTokenFromFile(userId, email, filePath) {
  try {
    const existing = getToken(userId);
    if (existing && existing.refresh_token) return; // already migrated
    const fsLocal = require('fs');
    if (!fsLocal.existsSync(filePath)) return;
    const t = JSON.parse(fsLocal.readFileSync(filePath, 'utf8'));
    if (t.refresh_token) {
      saveToken(userId, email, t);
      console.log(`[DB] Migrated token for ${userId} from ${filePath}`);
    }
  } catch (e) {
    console.warn(`[DB] Token migration failed for ${userId}:`, e.message);
  }
}

// ── Calendar Intent Queue ─────────────────────────────────────────────────────

/** Log a calendar intent before writing to Google Calendar. Returns inserted row id. */
function logCalendarIntent({ source, event_title, event_date, event_start, event_end, raw_message }) {
  const result = getDB().prepare(
    `INSERT INTO calendar_intents (source, event_title, event_date, event_start, event_end, raw_message, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(source || 'unknown', event_title, event_date || null, event_start || null, event_end || null, raw_message || null, Date.now());
  return result.lastInsertRowid;
}

/** Find pending intents on a given date (YYYY-MM-DD) from the last 24h. */
function findPendingIntentsForDate(eventDate) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return getDB().prepare(
    `SELECT * FROM calendar_intents WHERE event_date = ? AND status = 'pending' AND created_at > ? ORDER BY created_at DESC`
  ).all(eventDate, cutoff);
}

/** Update status and optionally set Google Calendar event ID. */
function updateCalendarIntentStatus(id, status, calendarEventId) {
  getDB().prepare('UPDATE calendar_intents SET status = ?, calendar_event_id = ? WHERE id = ?')
    .run(status, calendarEventId || null, id);
}

// ── Family members ─────────────────────────────────────────────────────────────
function getAllFamilyMembers() {
  return getDB().prepare('SELECT * FROM family_members ORDER BY id').all();
}

function getFamilyMemberByNameExact(nameOrAlias) {
  const db = getDB();
  const lower = nameOrAlias.toLowerCase();
  const all = db.prepare('SELECT * FROM family_members').all();
  for (const m of all) {
    if (m.name_he === nameOrAlias || (m.name_en || '').toLowerCase() === lower) return m;
    try {
      const nicknames = JSON.parse(m.nicknames || '[]');
      if (nicknames.some(n => n.toLowerCase() === lower)) return m;
    } catch (_) {}
  }
  return null;
}

// ── Homework ─────────────────────────────────────────────────────────────────

/**
 * Save a homework assignment. Deduplicates by child + due_date + description prefix.
 */
function saveHomework({ child_name, subject, description, due_date, source_group, message_id }) {
  const prefix = (description || '').trim().substring(0, 60);
  const existing = getDB().prepare(
    `SELECT id FROM homework
     WHERE done=0 AND child_name=? AND (due_date IS ? OR due_date=?) AND substr(description,1,60)=?
     LIMIT 1`
  ).get(child_name, due_date || null, due_date || null, prefix);
  if (existing) {
    console.log(`[DB] Skipped duplicate homework (matches id=${existing.id})`);
    return existing.id;
  }
  const result = getDB().prepare(
    `INSERT INTO homework (child_name, subject, description, due_date, source_group, message_id, done, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    child_name,
    subject      || null,
    description,
    due_date     || null,
    source_group || null,
    message_id   || null,
    Date.now()
  );
  return result.lastInsertRowid;
}

/**
 * Fetch all pending (not done) homework with due_date >= todayStr or undated.
 * @param {string} todayStr  YYYY-MM-DD in local timezone
 */
function getPendingHomework(todayStr) {
  return getDB().prepare(
    `SELECT id, child_name, subject, description, due_date
     FROM homework
     WHERE done=0 AND (due_date IS NULL OR due_date >= ?)
     ORDER BY due_date ASC NULLS LAST, child_name ASC
     LIMIT 30`
  ).all(todayStr);
}

// ── Phase 1: message_buffer helpers ────────────────────────────────────────

/**
 * Buffer a raw incoming message for later extraction.
 * Silently ignores if message_id already exists (idempotent).
 */
function bufferMessage({ message_id, group_jid, group_name, sender_name, content, message_timestamp }) {
  try {
    const result = getDB().prepare(`
      INSERT OR IGNORE INTO message_buffer
        (message_id, group_jid, group_name, sender_name, content, message_timestamp, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(message_id, group_jid, group_name, sender_name || '', content, message_timestamp, Date.now());
    return result.changes > 0; // true = new row, false = already existed
  } catch (e) {
    console.error('[DB] bufferMessage error:', e.message);
    return false;
  }
}

/**
 * Fetch unextracted messages older than minAgeMs (default 15 min), grouped by group.
 * Returns an array of { group_jid, group_name, messages: [...] }
 */
function getUnextractedMessageGroups(minAgeMs = 15 * 60 * 1000) {
  const cutoff = Date.now() - minAgeMs;
  const rows = getDB().prepare(`
    SELECT * FROM message_buffer
    WHERE extracted = 0 AND received_at < ?
    ORDER BY group_jid, message_timestamp ASC
  `).all(cutoff);

  const byGroup = {};
  for (const row of rows) {
    if (!byGroup[row.group_jid]) {
      byGroup[row.group_jid] = { group_jid: row.group_jid, group_name: row.group_name, messages: [] };
    }
    byGroup[row.group_jid].messages.push(row);
  }
  return Object.values(byGroup);
}

/**
 * Mark messages as extracted, linking them to an extraction_batch_id.
 */
function markMessagesExtracted(messageIds, batchId) {
  if (!messageIds.length) return;
  const placeholders = messageIds.map(() => '?').join(',');
  getDB().prepare(
    `UPDATE message_buffer SET extracted = 1, extraction_batch_id = ? WHERE message_id IN (${placeholders})`
  ).run(batchId, ...messageIds);
}

/**
 * Log the start of an extraction run. Returns the run ID.
 */
function startExtractionRun(id) {
  getDB().prepare(
    'INSERT INTO extraction_runs (id, started_at, status) VALUES (?, ?, \'running\')'
  ).run(id, Date.now());
  return id;
}

function finishExtractionRun(id, { messagesProcessed, noticesCreated, error } = {}) {
  getDB().prepare(`
    UPDATE extraction_runs
    SET completed_at=?, messages_processed=?, notices_created=?, status=?, error_message=?
    WHERE id=?
  `).run(Date.now(), messagesProcessed || 0, noticesCreated || 0, error ? 'failed' : 'completed', error || null, id);
}

/**
 * Log the start/end of a delivery run.
 */
function startDeliveryRun(id) {
  getDB().prepare(
    'INSERT INTO delivery_runs (id, started_at, status) VALUES (?, ?, \'running\')'
  ).run(id, Date.now());
}

function finishDeliveryRun(id, { delivered, failed } = {}) {
  getDB().prepare(`
    UPDATE delivery_runs
    SET completed_at=?, notices_delivered=?, notices_failed=?, status=?
    WHERE id=?
  `).run(Date.now(), delivered || 0, failed || 0, 'completed', id);
}

/**
 * Increment delivery_attempts and record last_attempt_at for a notice.
 */
function recordDeliveryAttempt(noticeId, errorMsg = null) {
  getDB().prepare(`
    UPDATE notices
    SET delivery_attempts = delivery_attempts + 1,
        last_attempt_at = ?,
        delivery_status = CASE WHEN delivery_attempts + 1 >= 3 THEN 'failed' ELSE delivery_status END
    WHERE id = ?
  `).run(Date.now(), noticeId);
}

// ── Notice thread helpers ────────────────────────────────────────────────────

/**
 * Find or create a notice thread. Returns the thread record.
 */
function saveOrGetThread(threadKey, description, sourceGroup) {
  if (!threadKey) return null;
  try {
    const existing = getDB().prepare('SELECT * FROM notice_threads WHERE thread_key = ?').get(threadKey);
    if (existing) {
      // Update description if we now have one and didn't before
      if (description && !existing.description) {
        getDB().prepare('UPDATE notice_threads SET description = ? WHERE thread_key = ?').run(description, threadKey);
        existing.description = description;
      }
      return existing;
    }
    getDB().prepare(
      'INSERT INTO notice_threads (thread_key, description, source_group, first_noticed_at) VALUES (?, ?, ?, ?)'
    ).run(threadKey, description || null, sourceGroup || null, Date.now());
    return getDB().prepare('SELECT * FROM notice_threads WHERE thread_key = ?').get(threadKey);
  } catch (e) {
    console.error('[DB] saveOrGetThread error:', e.message);
    return null;
  }
}

/**
 * Mark a thread as dismissed (user asked to stop receiving updates about it).
 */
function dismissThread(threadKey, reason) {
  if (!threadKey) return false;
  try {
    getDB().prepare(
      'UPDATE notice_threads SET dismissed=1, dismissed_at=?, dismissed_reason=? WHERE thread_key=?'
    ).run(Date.now(), reason || 'user_request', threadKey);
    return true;
  } catch (e) {
    console.error('[DB] dismissThread error:', e.message);
    return false;
  }
}

/**
 * Link a notice to a thread by thread_key.
 */
function linkNoticeToThread(noticeId, threadKey, threadId) {
  if (!noticeId || !threadKey) return;
  try {
    getDB().prepare('UPDATE notices SET thread_key=?, thread_id=? WHERE id=?').run(threadKey, threadId || null, noticeId);
  } catch (e) {
    console.error('[DB] linkNoticeToThread error:', e.message);
  }
}

/**
 * Get the most recently delivered non-dismissed thread.
 */
function getMostRecentDeliveredThread() {
  try {
    return getDB().prepare(
      'SELECT * FROM notice_threads WHERE dismissed=0 AND last_delivered_at IS NOT NULL ORDER BY last_delivered_at DESC LIMIT 1'
    ).get();
  } catch (e) {
    return null;
  }
}

module.exports = {
  initDB,
  getDB,
  saveMessage,
  getRecentGroupMessages,
  markMessageProcessed,
  saveNotice,
  getActiveNotices,
  saveEvent,
  markEventAdded,
  saveActionItem,
  saveClarification,
  getPendingActionItems,
  getUnansweredClarifications,
  saveGroup,
  setGroupRelatedTo,
  setGroupDescription,
  getGroup,
  getMonitoredGroupsWithoutDescription,
  getUnconfiguredGroups,
  savePendingGroupQuestion,
  getPendingGroupQuestion,
  deletePendingGroupQuestion,
  getAllPendingGroupQuestions,
  saveReminder,
  cancelRemindersForEvent,
  getPendingReminders,
  markReminderSent,
  claimReminder,
  claimDigestToday,
  hasReminder,
  saveFollowUp,
  getPendingFollowUps,
  claimFollowUp,
  setFollowUpBotMsgId,
  getFollowUpByBotMsgId,
  saveCapabilityRequest,
  getPendingCapabilityRequests,
  saveBotTask,
  getPendingBotTasks,
  claimBotTask,
  cancelRecurringGroup,
  isRecurringGroupActive,
  saveOrGetThread,
  dismissThread,
  linkNoticeToThread,
  getMostRecentDeliveredThread,
  cancelFollowUpsForEvent,
  updateFollowUpStatus,
  isMessageProcessed,
  markMsgProcessed,
  // Conversation history
  addToConversationHistory,
  getConversationHistory,
  // Pending actions
  setPendingAction,
  getPendingAction,
  clearPendingAction,
  clearExpiredPendingActions,
  // Family members
  getAllFamilyMembers,
  getFamilyMemberByNameExact,
  // Calendar Intent Queue
  logCalendarIntent,
  findPendingIntentsForDate,
  updateCalendarIntentStatus,
  // OAuth tokens
  getToken,
  saveToken,
  setTokenError,
  migrateTokenFromFile,
  // Homework
  saveHomework,
  getPendingHomework,
  // Phase 1: message buffer + extraction/delivery run tracking
  bufferMessage,
  getUnextractedMessageGroups,
  markMessagesExtracted,
  startExtractionRun,
  finishExtractionRun,
  startDeliveryRun,
  finishDeliveryRun,
  recordDeliveryAttempt,
};
