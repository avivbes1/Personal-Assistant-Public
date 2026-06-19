const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'besinsky.db');

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

  // Persistent pending group questions (survives restarts)
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_group_questions (
      msg_id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

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
    const insert = db.prepare('INSERT INTO family_members (name_he, name_en, nicknames, role, calendar_id, notes) VALUES (?, ?, ?, ?, ?, ?)');
    const config = require('./config');
    const members = [
      ['אביב', 'Aviv',   JSON.stringify(['aviv', 'dad', 'אבא']),                  'parent', config.AVIV_CALENDAR_ID, 'Dad'],
      ['ליאת', 'Liat',   JSON.stringify(['liat', 'mom', 'אמא', 'אמי']),            'parent', config.LIAT_CALENDAR_ID, 'Mom'],
      ['שגב',  'Segev',  JSON.stringify(['segev', 'שגב׳ה', 'שגבי']),              'kid',    null, 'Oldest kid'],
      ['נבו',  'Nevo',   JSON.stringify(['nevo', 'נבו׳ה', 'נבוש']),               'kid',    null, 'Second kid'],
      ['נטע',  'Neta',   JSON.stringify(['neta', 'נטע׳לה', 'נטע׳ה']),             'kid',    null, 'Third kid'],
      ['ירדן', 'Yarden', JSON.stringify(['yarden', 'ירדן׳ה', 'ירד']),              'kid',    null, 'Youngest kid'],
    ];
    for (const m of members) insert.run(...m);
    console.log('[DB] Seeded family_members table');
  }

  // Migrations — add columns that may not exist in older DBs
  try { db.exec("ALTER TABLE reminders ADD COLUMN owner TEXT DEFAULT 'both'"); } catch (_) {}
  try { db.exec("ALTER TABLE groups ADD COLUMN description TEXT"); } catch (_) {}

  console.log('[DB] Initialized at', DB_PATH);
  return db;
}

function getDB() {
  if (!db) throw new Error('DB not initialized. Call initDB() first.');
  return db;
}

function saveMessage({ group_id, sender, body, timestamp }) {
  const stmt = getDB().prepare(
    'INSERT INTO messages (group_id, sender, body, timestamp, processed) VALUES (?, ?, ?, ?, 0)'
  );
  const result = stmt.run(group_id, sender, body, timestamp || Date.now());
  return result.lastInsertRowid;
}

function markMessageProcessed(id) {
  getDB().prepare('UPDATE messages SET processed = 1 WHERE id = ?').run(id);
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
  // Avoid duplicates for same event
  const existing = getDB().prepare('SELECT id FROM follow_ups WHERE event_id = ? AND status = ?').get(event_id, 'pending');
  if (existing) return existing.id;
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

module.exports = {
  initDB,
  getDB,
  saveMessage,
  markMessageProcessed,
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
};
