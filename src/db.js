const Database = require('better-sqlite3');
const path = require('path');
const { normalizeText } = require('./notice-dedup');

// FAMILYBOT_DB_PATH lets tests point at an isolated DB instead of the live one.
const DB_PATH = process.env.FAMILYBOT_DB_PATH || path.join(__dirname, '..', 'data', 'family.db');

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
      stanza_id TEXT,
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
  // M4: artifact promise tracking
  try { getDB().prepare('ALTER TABLE bot_tasks ADD COLUMN artifact_path TEXT DEFAULT NULL').run(); } catch (_) {}
  try { getDB().prepare('ALTER TABLE bot_tasks ADD COLUMN delivered_at INTEGER DEFAULT NULL').run(); } catch (_) {}
  try { getDB().prepare('ALTER TABLE bot_tasks ADD COLUMN acknowledged_at INTEGER DEFAULT NULL').run(); } catch (_) {}


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
      stanza_id TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  // ── Migration 006 (ISSUE-023 / H1): stanza_id for reply-based lookups ──────
  // The serialized msg_id depends on JID-format details that differ between the
  // sent-message and quoted-reply directions; stanza_id is stable in both.
  try { db.exec('ALTER TABLE pending_group_questions ADD COLUMN stanza_id TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE follow_ups ADD COLUMN stanza_id TEXT'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_pgq_stanza ON pending_group_questions(stanza_id)'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_followups_stanza ON follow_ups(stanza_id)'); } catch (_) {}

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
  // F2: aliases holds a JSON array of a group's previous (prior-school-year) names
  // so a renamed group can inherit last year's child link. Safe migration.
  try { db.exec('ALTER TABLE groups ADD COLUMN aliases TEXT'); } catch (_) {}

  // ── Migration 007 (B7): Dedicated monitored column for groups ──────────────
  // related_to was overloaded as both type enum and free-text child name.
  // Now: `monitored` INTEGER (0/1) is the sole flag; `related_to` holds the
  // relationship context (child name, 'master', 'ignored', or NULL).
  try { db.exec('ALTER TABLE groups ADD COLUMN monitored INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
  // Backfill: groups that were related_to='monitored' → set monitored=1, clear related_to
  try { db.exec("UPDATE groups SET monitored = 1 WHERE related_to = 'monitored'"); } catch (_) {}
  try { db.exec("UPDATE groups SET related_to = NULL WHERE related_to = 'monitored'"); } catch (_) {}
  // 'unmonitored' was ad-hoc opt-out → monitored=0, clear related_to
  try { db.exec("UPDATE groups SET monitored = 0, related_to = NULL WHERE related_to = 'unmonitored'"); } catch (_) {}

  // Create UNIQUE dedup index on homework (idempotent)
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_hw_unique ON homework(child_name, COALESCE(due_date,\'\'), COALESCE(subject,\'\'), SUBSTR(description,1,80))');
  } catch (_) {}

  // F1: Populate primary_child from config/family-context.json.
  // Was reading config/family-seed.json (which never existed → dead code path),
  // leaving new school-year group names unlinked. family-context.json lists each
  // child's group names under members[child].groups; we link every monitored
  // group that still has a NULL primary_child. Idempotent: the IS NULL guard
  // never overwrites an existing link, and unknown names simply match nothing.
  try {
    const ctxPath = require('path').join(__dirname, '../config/family-context.json');
    if (require('fs').existsSync(ctxPath)) {
      const ctx = JSON.parse(require('fs').readFileSync(ctxPath, 'utf8'));
      const upd = db.prepare("UPDATE groups SET primary_child=? WHERE name=? AND primary_child IS NULL");
      let linked = 0;
      for (const [child, member] of Object.entries(ctx.members || {})) {
        for (const groupName of (member.groups || [])) {
          const r = upd.run(child, groupName);
          linked += r.changes;
        }
      }
      if (linked > 0) console.log(`[DB] F1: linked ${linked} group(s) to a child from family-context.json`);
    }
  } catch (e) { console.warn('[DB] F1 primary_child population failed:', e.message); }

  // F2: seed known school-year rename aliases so a promoted/renamed group can be
  // matched back to last year's link. Keyed by the *current* name; each value is
  // the JSON array of prior names. No-op for groups not present in this DB yet.
  try {
    const aliasMap = {
      'הורים מרכזון ג-ד 26-27🦋': ['הורים מרכזון ג-ד 25-26🦋'],
      'כיתה ד׳3 תשפ״ז 🌸': ['ג׳3 תשפ״ו 🧡🩵💜'],
      'רשפים שכבה א׳ רימון תשפ"ז': ['רשפים שכבה א\' תשפ"ז'],
    };
    const updAlias = db.prepare('UPDATE groups SET aliases=? WHERE name=? AND aliases IS NULL');
    for (const [name, prior] of Object.entries(aliasMap)) {
      updAlias.run(JSON.stringify(prior), name);
    }
  } catch (e) { console.warn('[DB] F2 alias seeding failed:', e.message); }

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

  // calendar_intents outbox columns used by calendar-bridge.js. These were added
  // to production out-of-band and never captured in the original CREATE TABLE, so
  // a fresh checkout / CI DB lacked them and the bridge INSERT crashed. Safe
  // migrations — no-op when the column already exists.
  try { db.exec('ALTER TABLE calendar_intents ADD COLUMN notice_id INTEGER'); } catch (_) {}
  try { db.exec('ALTER TABLE calendar_intents ADD COLUMN fingerprint TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE calendar_intents ADD COLUMN event_location TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE calendar_intents ADD COLUMN attempts INTEGER DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE calendar_intents ADD COLUMN last_error TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE calendar_intents ADD COLUMN updated_at INTEGER'); } catch (_) {}
  // K3: date-known / time-unknown notices become all-day events. time_status
  // records why a time is absent — 'known' (has time), 'unknown' (not yet
  // published), or 'updated' (a time arrived later and the event was patched).
  try { db.exec("ALTER TABLE calendar_intents ADD COLUMN time_status TEXT DEFAULT 'known'"); } catch (_) {}
  // H5: time provenance tracking
  try { db.exec("ALTER TABLE calendar_intents ADD COLUMN time_source TEXT DEFAULT 'absent'"); } catch (_) {}

  // Migrations — add columns that may not exist in older DBs
  try { db.exec("ALTER TABLE reminders ADD COLUMN owner TEXT DEFAULT 'both'"); } catch (_) {}
  // TASK 0.3: audit column recording when a reserved reminder was confirmed sent.
  try { db.exec("ALTER TABLE reminders ADD COLUMN confirmed_at INTEGER"); } catch (_) {}
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
  // B2: index the daily-group-cap / cross-day-dedup lookups that key on
  // (group_name, sent_at) now that group matching uses a real column instead of
  // an 8-char message-text substring.
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_sent_group ON sent_messages(group_name, sent_at)'); } catch (_) {}
  // D1: record the WhatsApp id of each bot send so a later family reaction — which
  // carries only the target message's stanza id — maps back to the source notices.
  // stanza_id is the stable WA message id; msg_id is the serialized whatsapp-web.js id.
  try { db.exec('ALTER TABLE sent_messages ADD COLUMN stanza_id TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE sent_messages ADD COLUMN msg_id TEXT'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_sent_stanza ON sent_messages(stanza_id)'); } catch (_) {}
  // B2: backfill group_name on historical rows from the notices referenced by
  // source_notice_ids, so pre-migration sends still count toward the group cap.
  // Bounded per-run and idempotent (only touches NULL group_name rows).
  try {
    const rows = db.prepare(
      "SELECT id, source_notice_ids FROM sent_messages WHERE group_name IS NULL AND source_notice_ids IS NOT NULL LIMIT 2000"
    ).all();
    if (rows.length > 0) {
      const noticeGroup = db.prepare('SELECT group_name FROM notices WHERE id = ?');
      const upd = db.prepare('UPDATE sent_messages SET group_name = ? WHERE id = ?');
      let filled = 0;
      const tx = db.transaction((list) => {
        for (const r of list) {
          let ids;
          try { ids = JSON.parse(r.source_notice_ids); } catch (_) { continue; }
          if (!Array.isArray(ids)) continue;
          for (const nid of ids) {
            const n = noticeGroup.get(nid);
            if (n && n.group_name) { upd.run(n.group_name, r.id); filled++; break; }
          }
        }
      });
      tx(rows);
      if (filled > 0) console.log(`[DB] Backfilled group_name for ${filled} sent_messages row(s)`);
    }
  } catch (_) {}

  // Notice pipeline fix — Phase 0+1
  try { db.exec("ALTER TABLE notices ADD COLUMN message_sent_at INTEGER"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN normalized_content TEXT"); } catch (_) {}
  // Phase 2.2: backfill normalized_content for existing notices so semantic dedup
  // can rely on it. Bounded per-run (2000 rows) to keep startup fast; repeats
  // across restarts until fully populated. normalizeText is JS, so we loop in a tx.
  try {
    const pending = db.prepare(
      "SELECT id, content FROM notices WHERE normalized_content IS NULL AND content IS NOT NULL LIMIT 2000"
    ).all();
    if (pending.length > 0) {
      const upd = db.prepare('UPDATE notices SET normalized_content=? WHERE id=?');
      const tx = db.transaction((rows) => {
        for (const r of rows) upd.run(normalizeText(r.content), r.id);
      });
      tx(pending);
      console.log(`[DB] Backfilled normalized_content for ${pending.length} notice(s)`);
    }
  } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN valid_until TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN digest_shown_at INTEGER"); } catch (_) {}
  // Day/date mismatch detection (Phase 1) — warn-only, never mutates source
  try { db.exec("ALTER TABLE notices ADD COLUMN weekday_mismatch INTEGER DEFAULT 0"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN validation_notes TEXT"); } catch (_) {}
  // D1: provenance of relevance_date — 'explicit' | 'inferred' | 'weekday_corrected'.
  // relevance_date_raw preserves the pre-correction cited date when a weekday name
  // overrode a contradicting digit date (see agent.js weekday-correction flow).
  try { db.exec("ALTER TABLE notices ADD COLUMN relevance_date_source TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN relevance_date_raw TEXT"); } catch (_) {}
  // B4: which computeUrgencyHint rule set this notice's urgency
  // ('keyword' | 'datetime' | 'date_with_signal' | 'default'). Lets the triage
  // quiet-hours gate distinguish datetime-grounded immediates from keyword ones.
  try { db.exec("ALTER TABLE notices ADD COLUMN urgency_source TEXT"); } catch (_) {}
  // RC-2/RC-3 fix: query_visible for schedule queries, group_alerts for unknown group tracking
  try { db.exec("ALTER TABLE notices ADD COLUMN query_visible INTEGER DEFAULT 1"); } catch (_) {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS group_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_name TEXT NOT NULL,
    alert_type TEXT NOT NULL DEFAULT 'unknown_group',
    alerted_at INTEGER NOT NULL
  )`); } catch (_) {}
  // query_visible — whether this notice may surface in user-facing queries/digests.
  // Defaults to 1 so existing rows remain visible.
  try { db.exec("ALTER TABLE notices ADD COLUMN query_visible INTEGER DEFAULT 1"); } catch (_) {}

  // K1: calendar-bridge columns. These existed in the prod DB (added out-of-band)
  // but were never in a migration, so fresh checkouts / CI test DBs lacked them —
  // saveNotice() now writes calendar_worthy/event_type and calendar-bridge.js
  // reads/writes the rest, so make them exist everywhere.
  try { db.exec("ALTER TABLE notices ADD COLUMN calendar_worthy INTEGER DEFAULT 0"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN event_type TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN calendar_status TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN calendar_event_id TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN calendar_attempts INTEGER DEFAULT 0"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN calendar_error TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN fingerprint TEXT"); } catch (_) {}

  // Q2: primary_child on notices — links a notice to the child whose class group
  // it came from, even when the message body never names the child. The link
  // lives on the group (groups.primary_child); saveNotice() copies it onto each
  // new notice and this backfill populates historical rows.
  try { db.exec("ALTER TABLE notices ADD COLUMN primary_child TEXT"); } catch (_) {}
  try {
    db.exec(`
      UPDATE notices SET primary_child = (
        SELECT primary_child FROM groups WHERE groups.name = notices.group_name
      )
      WHERE primary_child IS NULL
    `);
  } catch (_) {}

  // O8: link the archived media artifact to the notice it produced, so the UI can
  // show "the letter" alongside the notice text. saveNotice() copies these from the
  // source message on insert; backfillNoticeMedia() (below) populates historical rows.
  // Idempotent ALTER — silently no-ops if the column already exists.
  try { db.exec("ALTER TABLE notices ADD COLUMN media_path TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE notices ADD COLUMN media_type TEXT"); } catch (_) {}

  // group_alerts — one row per "I joined a new/unknown group" alert we sent to
  // the master group, so batched triage doesn't re-alert about the same group.
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS group_alerts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      group_jid    TEXT,
      group_name   TEXT,
      action       TEXT,
      alerted_at   INTEGER NOT NULL
    )`);
  } catch (_) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_group_alerts_jid ON group_alerts(group_jid)"); } catch (_) {}
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS parse_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_input TEXT NOT NULL,
      parsed_output TEXT,
      validation_errors TEXT,
      created_at INTEGER NOT NULL
    )`);
  } catch (_) {}
  // Backfill valid_until from relevance_date for existing notices
  try { db.exec("UPDATE notices SET valid_until = relevance_date WHERE valid_until IS NULL AND relevance_date IS NOT NULL"); } catch (_) {}

  // Phase 1: notice_event child table for multi-event notices
  try { db.exec(`CREATE TABLE IF NOT EXISTS notice_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    notice_id INTEGER NOT NULL,
    event_date TEXT NOT NULL,
    event_time TEXT,
    event_title TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (notice_id) REFERENCES notices(id) ON DELETE CASCADE
  )`); } catch (_) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_notice_event_date ON notice_event(event_date)"); } catch (_) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_notice_event_expires ON notice_event(expires_at)"); } catch (_) {}
  // J2: mirror the notice-level weekday-correction provenance onto events.
  // event_date_source ∈ {null,'weekday_corrected'}; event_date_raw preserves the
  // literal date the message cited before the corrector snapped it to a weekday.
  try { db.exec('ALTER TABLE notice_event ADD COLUMN event_date_source TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE notice_event ADD COLUMN event_date_raw TEXT'); } catch (_) {}

  // K1: Job heartbeats — dead-man's-switch for scheduled jobs (P-021).
  // Every scheduled entry point writes here on completion. Absence of a heartbeat
  // is the alert — catches "job was never scheduled" which error monitoring cannot see.
  try { db.exec(`CREATE TABLE IF NOT EXISTS job_runs (
    job_name TEXT PRIMARY KEY,
    last_success_ms INTEGER NOT NULL,
    last_result TEXT,
    consecutive_empty INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`); } catch (_) {}

  // ISSUE-015: unique index to prevent duplicate messages regardless of call path
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedup ON messages(group_id, timestamp, body)`);
  } catch (_) {}

  // ── Media archive & retry tracking (safe migrations) ────────────────────────
  // Every media attachment is archived to disk and tracked here so extraction
  // failures can be retried later (see media-archive.js + /media/retry).
  try { db.exec('ALTER TABLE messages ADD COLUMN media_type TEXT'); } catch (_) {}
  try { db.exec("ALTER TABLE messages ADD COLUMN media_status TEXT CHECK(media_status IN ('pending','processed','failed','retry'))"); } catch (_) {}
  try { db.exec('ALTER TABLE messages ADD COLUMN media_path TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE messages ADD COLUMN media_error TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE messages ADD COLUMN media_retry_count INTEGER DEFAULT 0'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_messages_media_status ON messages(media_status, media_retry_count)'); } catch (_) {}

  // ── Pipeline-state columns (migration 004, applied inline) ──────────────────
  // These originally lived only in migrations/004_pipeline_state.sql, which no
  // runner executes — so fresh checkouts and isolated test DBs never got them and
  // any pipeline_state query crashed. Adding them here (idempotent) keeps the live
  // DB unchanged while making a from-scratch initDB() self-sufficient.
  try { db.exec("ALTER TABLE messages ADD COLUMN pipeline_state TEXT DEFAULT 'RECEIVED'"); } catch (_) {}
  try { db.exec('ALTER TABLE messages ADD COLUMN pipeline_error TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE messages ADD COLUMN processing_started_at INTEGER'); } catch (_) {}
  try { db.exec('ALTER TABLE messages ADD COLUMN processing_completed_at INTEGER'); } catch (_) {}
  try { db.exec('ALTER TABLE messages ADD COLUMN notice_id INTEGER'); } catch (_) {}
  try { db.exec('ALTER TABLE messages ADD COLUMN retry_count INTEGER DEFAULT 0'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_messages_pipeline_state ON messages(pipeline_state, processing_started_at)'); } catch (_) {}

  // ── Q6: query_misses ──────────────────────────────────────────────────────
  try { db.exec(`CREATE TABLE IF NOT EXISTS query_misses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    reply TEXT,
    tool_called INTEGER DEFAULT 0,
    data_existed INTEGER DEFAULT NULL,
    created_at INTEGER NOT NULL
  )`); } catch (_) {}

  // ── E1: message-edit capture (messages.update) ──────────────────────────────
  // stanza_id is the stable WhatsApp message id (rawMsg.key.id); edits arrive
  // keyed on it. body_history keeps prior bodies so an edit is auditable; the old
  // body is never silently lost. updated_at records the last edit time.
  try { db.exec('ALTER TABLE messages ADD COLUMN stanza_id TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE messages ADD COLUMN body_history TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE messages ADD COLUMN updated_at INTEGER'); } catch (_) {}
  // Non-unique index for edit lookups by (group_id, stanza_id). The legacy dedup
  // UNIQUE index on (group_id, timestamp, body) is intentionally left in place —
  // switching dedup to (group_id, stanza_id) waits until stanza_id is fully
  // backfilled on historical rows.
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_messages_stanza ON messages(group_id, stanza_id)'); } catch (_) {}

  // Phase 2.3: notice feedback — thumbs up/down + "missed" reports for triage tuning
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notice_feedback (
        id         INTEGER PRIMARY KEY,
        notice_id  INTEGER,
        thread_key TEXT,
        feedback   TEXT CHECK(feedback IN ('good','bad','missed')),
        comment    TEXT,
        created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
        FOREIGN KEY (notice_id) REFERENCES notices(id)
      )
    `);
  } catch (_) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_notice_feedback_notice ON notice_feedback(notice_id)"); } catch (_) {}

  // ── LID → phone-number mapping cache (H5) ───────────────────────────────────
  // Baileys hands us "@lid" participant JIDs for privacy-mode groups. These never
  // match phone-based identity lookups (FAMILY_PHONES, the myJid quoted-reply
  // check that ISSUE-023 depended on). baileys-client.js resolves LID→PN via the
  // signal repository once and caches the result here so resolution survives
  // restarts and avoids repeated lookups.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lid_map (
        lid        TEXT PRIMARY KEY,
        pn         TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  } catch (_) {}

  // ── E3: grounding_misses — fabrication candidate log ───────────────────────
  // Every field a grounding gate BLOCKS (a claimed date/time/amount/summary that
  // was absent from its source notice) is recorded here so the fabrication rate
  // is measurable over time. See logGroundingMiss() and GET /api/grounding-misses.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS grounding_misses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT,          -- 'query_response' | 'calendar_write' | 'notice_delivery'
        field_name TEXT,      -- 'time' | 'date' | 'amount' | 'summary'
        claimed_value TEXT,   -- what was stated/written
        source_notice_id INTEGER,
        context TEXT,         -- brief context
        created_at INTEGER DEFAULT (unixepoch() * 1000)
      )
    `);
  } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_grounding_misses_created ON grounding_misses(created_at)'); } catch (_) {}

  // ── Phase G (Proactivity) ──────────────────────────────────────────────────
  // G1: proactive_prompts — one row per proactive nudge the bot decides to raise
  // about a notice (currently 'missing_time'). status drives the send-once
  // lifecycle: pending → sent, and pending/sent → resolved once the gap is filled.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS proactive_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        notice_id INTEGER NOT NULL,
        prompt_type TEXT NOT NULL,          -- 'missing_time' | 'obligation_nudge'
        status TEXT DEFAULT 'pending',      -- 'pending' | 'sent' | 'resolved' | 'expired'
        message_text TEXT,
        sent_at INTEGER,
        resolved_at INTEGER,
        resolved_value TEXT,                -- the time that was eventually found
        created_at INTEGER DEFAULT (unixepoch() * 1000)
      )
    `);
  } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_proactive_prompts_status ON proactive_prompts(prompt_type, status)'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_proactive_prompts_notice ON proactive_prompts(notice_id)'); } catch (_) {}

  // G3/Q2: obligation_nudges — one T-24h reminder before an explicit deadline,
  // deduped by OBLIGATION rather than by notice. Three notices about the same
  // task (different notice_ids, even different thread_keys) collapse to one nudge
  // via UNIQUE(obligation_key, deadline_date). notice_id keeps the first source
  // for traceability; notice_ids holds the JSON array of all contributors.
  // deadline_source records how the deadline was resolved (Q1). A pending→sent
  // status transition guarantees at most one nudge ever fires per obligation.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS obligation_nudges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        notice_id INTEGER NOT NULL,         -- first contributing notice
        notice_ids TEXT,                    -- JSON array of all contributing notice ids
        obligation_key TEXT,                -- thread_key or sha1(child|deadline|text)
        deadline_date TEXT NOT NULL,        -- YYYY-MM-DD
        deadline_source TEXT,               -- how the deadline was resolved (Q1)
        child_name TEXT,
        obligation_text TEXT,               -- short description of what's due
        status TEXT DEFAULT 'pending',      -- 'pending' | 'sent' | 'skipped' | 'missed'
        sent_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch() * 1000),
        UNIQUE(obligation_key, deadline_date)
      )
    `);
  } catch (_) {}
  // Q2: migrate a pre-existing old-schema table (UNIQUE(notice_id, deadline_date),
  // no obligation_key) to the new obligation-keyed schema.
  migrateObligationNudgesSchema(db);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_obligation_nudges_due ON obligation_nudges(deadline_date, status)'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_obligation_nudges_key ON obligation_nudges(obligation_key, deadline_date)'); } catch (_) {}

  // Q5: backfill deadlines/keys on existing pending nudges using the canonical
  // resolver, cancelling any whose corrected deadline is already past.
  backfillObligationNudges(db);

  // S1: corrections — self-improvement lessons captured as a tool call instead
  // of by convention in /home/ubuntu/self-improving/corrections.md. Each row is
  // one correction; when a pattern accumulates 3+ entries it's promotion-due
  // (should be lifted into memory.md / PRINCIPLES.md). The markdown file is now
  // a regenerated view of this table, not the source of truth.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS corrections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER DEFAULT (unixepoch() * 1000),
        context TEXT NOT NULL,
        correction TEXT NOT NULL,
        lesson TEXT,
        pattern TEXT,                -- capability-exists-unused, silent-absence, etc.
        status TEXT DEFAULT 'open',  -- open | promoted | archived
        source_message_id TEXT,
        promoted_at INTEGER,
        promoted_to TEXT             -- e.g. 'memory.md' or 'PRINCIPLES.md'
      )
    `);
  } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_corrections_pattern ON corrections(pattern, status)'); } catch (_) {}
  // Idempotent one-time import of the legacy markdown log into the table.
  migrateCorrectionsFromMarkdown(db);

  // O8: populate media_path/media_type on historical notices from their sources.
  backfillNoticeMedia();

  // ── Instinct Bridge (one-way event export) ──────────────────────────────────
  // Purely additive tables (P-026). bridge_outbox is the durable delivery queue;
  // bridge_notice_sources links a notice to the message(s) that produced it;
  // bridge_inbox is a placeholder for a future reply/command channel.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_outbox (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id            TEXT UNIQUE NOT NULL,
        event_type          TEXT NOT NULL,
        stream              TEXT NOT NULL,
        payload_json        TEXT NOT NULL,
        payload_hash        TEXT,
        status              TEXT NOT NULL DEFAULT 'pending',  -- pending | claimed | delivered | dead
        attempts            INTEGER NOT NULL DEFAULT 0,
        available_at        INTEGER NOT NULL,
        claimed_at          INTEGER,
        delivered_at        INTEGER,
        provider_message_id TEXT,
        last_error          TEXT,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      )
    `);
  } catch (_) {}
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_notice_sources (
        notice_id  INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (notice_id, message_id)
      )
    `);
  } catch (_) {}
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_inbox (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        inbound_message_id    TEXT UNIQUE NOT NULL,
        in_reply_to_delivery_id TEXT,
        command_type          TEXT,
        payload_json          TEXT,
        status                TEXT NOT NULL DEFAULT 'received',  -- received | reviewed | executed | rejected
        reviewed_at           INTEGER,
        executed_at           INTEGER,
        last_error            TEXT,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL
      )
    `);
  } catch (_) {}
  // bridge_inbound_log records every inbound command email seen by the inbound
  // poller (src/bridge/inbound.js), keyed by its IMAP UID so the same message is
  // never processed twice. Kept in sync with ensureTable() there; from_addr
  // avoids the SQL reserved word `from`.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_inbound_log (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        gmail_uid         TEXT NOT NULL,
        gmail_message_id  TEXT,
        from_addr         TEXT,
        subject           TEXT,
        command           TEXT,
        response_summary  TEXT,
        processed_at      INTEGER NOT NULL,
        status            TEXT NOT NULL DEFAULT 'ok'  -- ok | auth_failed | empty | reply_failed | error
      )
    `);
  } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_bridge_inbound_uid ON bridge_inbound_log (gmail_uid)'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_bridge_outbox_delivery ON bridge_outbox(status, available_at, created_at)'); } catch (_) {}
  // Additive columns on notices for bridge export versioning.
  try { db.exec('ALTER TABLE notices ADD COLUMN export_version INTEGER NOT NULL DEFAULT 1'); } catch (_) {}
  try { db.exec('ALTER TABLE notices ADD COLUMN updated_at INTEGER'); } catch (_) {}

  console.log('[DB] Initialized at', DB_PATH);
  return db;
}

function getDB() {
  if (!db) throw new Error('DB not initialized. Call initDB() first.');
  return db;
}

// ── LID → phone-number mapping cache (H5) ─────────────────────────────────────

/**
 * Look up a cached phone JID for a LID JID. Returns the PN string or null.
 */
function getLidMapping(lid) {
  if (!lid) return null;
  const row = getDB().prepare('SELECT pn FROM lid_map WHERE lid = ?').get(lid);
  return row ? row.pn : null;
}

/**
 * Persist a LID → phone JID mapping so resolution survives restarts.
 */
function saveLidMapping(lid, pn) {
  if (!lid || !pn) return;
  getDB().prepare(
    'INSERT INTO lid_map (lid, pn, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn, updated_at = excluded.updated_at'
  ).run(lid, pn, Date.now());
}

// ── B7: Startup assertion for group monitoring state ────────────────────────
/**
 * Assert that no group has an unexpected `monitored` value.
 * Call at startup to catch schema drift early.
 */
function assertGroupMonitoringIntegrity() {
  const db = getDB();
  // Check for monitored values outside {0, 1}
  const bad = db.prepare(
    'SELECT id, name, monitored FROM groups WHERE monitored NOT IN (0, 1)'
  ).all();
  if (bad.length > 0) {
    const msg = `[DB] INTEGRITY: ${bad.length} group(s) with unknown monitored value: ` +
      bad.map(g => `${g.name}(${g.monitored})`).join(', ');
    console.error(msg);
    // Don't throw — log loudly so the health system catches it
  }
  return bad;
}

// ── B8: Nightly integrity check for enum-column sanity ──────────────────────
/**
 * Check all enum-like columns across key tables for out-of-vocabulary values.
 * Returns an array of violation descriptions. Empty = healthy.
 */
function checkEnumIntegrity() {
  const db = getDB();
  const violations = [];

  // 1. groups.monitored must be 0 or 1
  const badMonitored = db.prepare(
    'SELECT id, name, monitored FROM groups WHERE monitored NOT IN (0, 1)'
  ).all();
  for (const g of badMonitored) {
    violations.push(`groups: ${g.name} (${g.id}) has monitored=${g.monitored}`);
  }

  // 2. notices.delivery_status vocabulary
  const VALID_DELIVERY_STATUS = ['pending', 'skipped', 'delivered_immediate', 'delivered_batch', 'dead_letter', 'dismissed', 'superseded'];
  try {
    const badDelivery = db.prepare(
      `SELECT id, delivery_status, group_name FROM notices WHERE delivery_status IS NOT NULL AND delivery_status NOT IN (${VALID_DELIVERY_STATUS.map(() => '?').join(',')})` 
    ).all(...VALID_DELIVERY_STATUS);
    for (const n of badDelivery) {
      violations.push(`notices: id=${n.id} group=${n.group_name} has delivery_status='${n.delivery_status}'`);
    }
  } catch (_) {} // Column may not exist in test DBs

  // 3. notices.triage_decision vocabulary
  const VALID_TRIAGE = ['send_now', 'send_update', 'defer', 'skip', 'archive'];
  try {
    const badTriage = db.prepare(
      `SELECT id, triage_decision, group_name FROM notices WHERE triage_decision IS NOT NULL AND triage_decision NOT IN (${VALID_TRIAGE.map(() => '?').join(',')})` 
    ).all(...VALID_TRIAGE);
    for (const n of badTriage) {
      violations.push(`notices: id=${n.id} group=${n.group_name} has triage_decision='${n.triage_decision}'`);
    }
  } catch (_) {}

  // 4. messages.pipeline_state vocabulary
  const VALID_PIPELINE = ['RECEIVED', 'PROCESSING', 'NOT_ACTIONABLE', 'NOTICE_CREATED', 'FAILED'];
  try {
    const badPipeline = db.prepare(
      `SELECT id, pipeline_state, group_id FROM messages WHERE pipeline_state IS NOT NULL AND pipeline_state NOT IN (${VALID_PIPELINE.map(() => '?').join(',')})` 
    ).all(...VALID_PIPELINE);
    for (const m of badPipeline) {
      violations.push(`messages: id=${m.id} group=${m.group_id} has pipeline_state='${m.pipeline_state}'`);
    }
  } catch (_) {}

  if (violations.length > 0) {
    console.error(`[DB] ENUM INTEGRITY: ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  - ${v}`);
  }

  return violations;
}

// ── Instinct Bridge hooks (P-026: additive, must never break core) ───────────
// Every hook below is wrapped in try/catch and only runs when the bridge is
// enabled and the group is allowlisted. A failure here logs and returns —
// message/notice persistence is never affected. Bridge modules are required
// lazily so a broken bridge file can't break db.js at load time.

/** Enqueue a message.created / message.updated event for a stored message row. */
function _bridgeEnqueueMessageById(messageId, eventType) {
  try {
    const bridgeConfig = require('./bridge/config');
    if (!bridgeConfig.enabled || !messageId) return;
    const row = getDB().prepare(
      'SELECT id, group_id, sender, body, timestamp, stanza_id FROM messages WHERE id = ?'
    ).get(messageId);
    if (!row) return;
    const policy = require('./bridge/policy');
    if (!policy.isGroupAllowed(row.group_id)) return;
    const { buildMessageRecord, computePayloadHash } = require('./bridge/envelope');
    const grp = getDB().prepare('SELECT name FROM groups WHERE id = ?').get(row.group_id);
    const record = buildMessageRecord(row, { jid: row.group_id, name: grp ? grp.name : null });
    // message.created is once-per-message; message.updated keys on the body hash
    // so each distinct edit is a distinct event.
    const suffix = eventType === 'message.updated'
      ? computePayloadHash(row.body || '').slice(0, 12)
      : 'v1';
    const eventId = `${eventType}:${row.id}:${suffix}`;
    require('./bridge/outboxRepository').enqueueEvent(eventId, eventType, bridgeConfig.stream, record);
  } catch (e) {
    console.warn('[Bridge] message enqueue failed (non-fatal):', e.message);
  }
}

/** Enqueue a notice.upserted event, recording its source-message linkage. */
function _bridgeEnqueueNotice(noticeId) {
  try {
    const bridgeConfig = require('./bridge/config');
    if (!bridgeConfig.enabled || !noticeId) return;
    const notice = getDB().prepare('SELECT * FROM notices WHERE id = ?').get(noticeId);
    if (!notice) return;
    const policy = require('./bridge/policy');
    if (!policy.filterExportableNotice(notice)) return;
    // Resolve the group JID from its name so the allowlist applies to notices too.
    const grp = getDB().prepare('SELECT id FROM groups WHERE name = ? LIMIT 1').get(notice.group_name);
    const jid = grp ? grp.id : null;
    if (!jid || !policy.isGroupAllowed(jid)) return;

    // Best-effort source-message linkage: the message(s) at the same group +
    // timestamp that produced this notice (same pair saveNotice's media lookup uses).
    const sourceIds = _bridgeLinkNoticeSources(notice);

    const { buildNoticeRecord } = require('./bridge/envelope');
    const record = buildNoticeRecord(notice, sourceIds);
    const eventId = `notice.upserted:${notice.id}:v${notice.export_version || 1}`;
    require('./bridge/outboxRepository').enqueueEvent(eventId, 'notice.upserted', bridgeConfig.stream, record);
  } catch (e) {
    console.warn('[Bridge] notice enqueue failed (non-fatal):', e.message);
  }
}

/**
 * Record (and return) the message ids that produced a notice, into
 * bridge_notice_sources. Returns [] when none can be resolved.
 */
function _bridgeLinkNoticeSources(notice) {
  const ids = [];
  try {
    const srcTs = notice.message_timestamp || notice.source_timestamp;
    if (!srcTs) return ids;
    const rows = getDB().prepare(
      `SELECT m.id
         FROM messages m JOIN groups g ON g.id = m.group_id
        WHERE g.name = ? AND m.timestamp = ?
        ORDER BY m.id ASC`
    ).all(notice.group_name, srcTs);
    const link = getDB().prepare(
      'INSERT OR IGNORE INTO bridge_notice_sources (notice_id, message_id, created_at) VALUES (?, ?, ?)'
    );
    const now = Date.now();
    for (const r of rows) {
      link.run(notice.id, r.id, now);
      ids.push(r.id);
    }
  } catch (_) { /* best-effort */ }
  return ids;
}

function saveMessage({ group_id, sender, body, timestamp, stanza_id }) {
  const ts = timestamp || Date.now();
  const stmt = getDB().prepare(
    'INSERT OR IGNORE INTO messages (group_id, sender, body, timestamp, processed, stanza_id) VALUES (?, ?, ?, ?, 0, ?)'
  );
  const result = stmt.run(group_id, sender, body, ts, stanza_id || null);
  if (result.changes > 0) {
    const newId = result.lastInsertRowid;
    _bridgeEnqueueMessageById(newId, 'message.created');
    return newId;
  }
  // Already existed — return the existing row id
  const existing = getDB().prepare(
    'SELECT id, stanza_id FROM messages WHERE group_id=? AND timestamp=? AND body=? LIMIT 1'
  ).get(group_id, ts, body);
  // Backfill stanza_id on rows saved before we started capturing it, so a later
  // edit (keyed on stanza_id) can still find this row.
  if (existing && stanza_id && !existing.stanza_id) {
    getDB().prepare('UPDATE messages SET stanza_id=? WHERE id=?').run(stanza_id, existing.id);
  }
  return existing?.id ?? null;
}

function markMessageProcessed(id) {
  getDB().prepare('UPDATE messages SET processed = 1 WHERE id = ?').run(id);
}

// --- Pipeline state helpers (ISSUE-019 / P-008) ---

function markMessageProcessing(id) {
  getDB().prepare(
    'UPDATE messages SET pipeline_state=\'PROCESSING\', processing_started_at=? WHERE id=?'
  ).run(Date.now(), id);
}

function markMessageTerminal(id, state, error, noticeId) {
  getDB().prepare(
    'UPDATE messages SET pipeline_state=?, pipeline_error=?, notice_id=?, processing_completed_at=? WHERE id=?'
  ).run(state, error || null, noticeId || null, Date.now(), id);
}

function markMessageFailed(id, errorJson) {
  getDB().prepare(
    'UPDATE messages SET pipeline_state=\'FAILED\', pipeline_error=?, processing_completed_at=?, retry_count=retry_count+1 WHERE id=?'
  ).run(errorJson || null, Date.now(), id);
}

// --- Media archive / retry tracking ---

/** Record media archive info + processing status on a message row. */
function updateMessageMedia(id, { media_type, media_path, media_status, media_error } = {}) {
  if (!id) return;
  getDB().prepare(
    'UPDATE messages SET media_type=?, media_path=?, media_status=?, media_error=? WHERE id=?'
  ).run(media_type || null, media_path || null, media_status || null, media_error || null, id);
}

/** Update only the media processing status (+ optional error) of a message. */
function setMediaStatus(id, status, error) {
  if (!id) return;
  getDB().prepare('UPDATE messages SET media_status=?, media_error=? WHERE id=?')
    .run(status, error || null, id);
}

/** Bump the retry counter after a failed re-processing attempt. */
function incrementMediaRetry(id) {
  if (!id) return;
  getDB().prepare('UPDATE messages SET media_retry_count = media_retry_count + 1 WHERE id=?').run(id);
}

/** Update a message body after successful (re)extraction. */
function updateMessageBody(id, body) {
  if (!id) return;
  getDB().prepare('UPDATE messages SET body=? WHERE id=?').run(body, id);
}

/**
 * E1: Apply a WhatsApp message edit, keyed on stanza_id.
 *
 * Finds the message by (stanza_id, group_id), archives the previous body into
 * body_history, writes the new body, and resets pipeline state so the next
 * extraction cycle re-processes the edited content. Returns the row id, or null
 * if no matching message exists (an edit for something we never saw).
 *
 * Named distinctly from updateMessageBody(id, body) — that one is the media
 * re-extraction path (keyed on the numeric row id) and must not change.
 */
function updateMessageBodyByStanza(stanzaId, groupId, newBody) {
  if (!stanzaId || !groupId) return null;
  const msg = getDB().prepare(
    'SELECT id, body, body_history FROM messages WHERE stanza_id=? AND group_id=?'
  ).get(stanzaId, groupId);
  if (!msg) return null;

  // No-op if the body didn't actually change (WhatsApp can redeliver updates).
  if (msg.body === newBody) return msg.id;

  const history = msg.body_history ? JSON.parse(msg.body_history) : [];
  history.push({ body: msg.body, replaced_at: Date.now() });

  getDB().prepare(
    "UPDATE messages SET body=?, body_history=?, processed=0, pipeline_state='RECEIVED', updated_at=? WHERE id=?"
  ).run(newBody, JSON.stringify(history), Date.now(), msg.id);

  // Instinct Bridge: enqueue message.updated (best-effort, never blocks the edit).
  _bridgeEnqueueMessageById(msg.id, 'message.updated');

  return msg.id;
}

/**
 * Failed media attachments still eligible for a retry (< 3 attempts).
 * Ordered oldest-first so the backlog is worked in arrival order.
 */
function getFailedMedia(limit = 20) {
  return getDB().prepare(
    `SELECT id, group_id, sender, body, timestamp, media_type, media_path, media_error, media_retry_count
     FROM messages
     WHERE media_status='failed' AND media_retry_count < 3 AND media_path IS NOT NULL
     ORDER BY timestamp ASC
     LIMIT ?`
  ).all(limit);
}

function getStuckMessages(thresholdMs) {
  const cutoff = Date.now() - (thresholdMs || 300000);
  return getDB().prepare(
    "SELECT id, group_id, body, processing_started_at FROM messages WHERE pipeline_state='PROCESSING' AND processing_started_at < ? ORDER BY processing_started_at ASC"
  ).all(cutoff);
}

function getPipelineStats(windowMs) {
  const cutoff = Date.now() - (windowMs || 3600000);
  return getDB().prepare(
    "SELECT pipeline_state, COUNT(*) as cnt FROM messages WHERE timestamp > ? GROUP BY pipeline_state"
  ).all(cutoff);
}

// --- Config helpers ---

function getConfigValue(key) {
  const row = getDB().prepare('SELECT value, value_type FROM bot_config WHERE key=?').get(key);
  if (!row) return null;
  return row.value_type === 'integer' ? parseInt(row.value, 10) : row.value;
}

function setConfigValue(key, newValue, reason, proposedBy) {
  const row = getDB().prepare('SELECT * FROM bot_config WHERE key=?').get(key);
  if (!row) return { ok: false, error: 'unknown key' };
  const min = row.min_value != null ? Number(row.min_value) : null;
  const max = row.max_value != null ? Number(row.max_value) : null;
  const num = Number(newValue);
  if (min != null && num < min) return { ok: false, error: `below min ${min}` };
  if (max != null && num > max) return { ok: false, error: `above max ${max}` };
  const oldValue = row.value;
  getDB().prepare('UPDATE bot_config SET value=?, modified_at=?, modified_by=? WHERE key=?').run(
    String(newValue), Date.now(), proposedBy || 'lipa', key
  );
  const result = getDB().prepare(
    'INSERT INTO config_change_log (key, old_value, new_value, reason, proposed_by, applied_at) VALUES (?,?,?,?,?,?)'
  ).run(key, oldValue, String(newValue), reason || '', proposedBy || 'lipa', Date.now());
  return { ok: true, oldValue, newValue: String(newValue), changeId: result.lastInsertRowid };
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

function saveNotice({ group_name, content, relevance_date, relevance_time, source_timestamp, urgency_hint, urgency_source, relevant_datetime, message_timestamp, delivery_status, message_sent_at, valid_until, weekday_mismatch, validation_notes, calendar_worthy, event_type, relevance_date_source, relevance_date_raw }) {
  // Deduplicate: same group + same content snippet + same relevance_date
  const snippet = (content || '').substring(0, 80);
  const existing = getDB().prepare(
    'SELECT id FROM notices WHERE group_name=? AND substr(content,1,80)=? AND relevance_date IS ? AND dismissed=0 LIMIT 1'
  ).get(group_name, snippet, relevance_date || null);
  if (existing) return existing.id;
  // valid_until defaults to relevance_date if not provided
  const validUntil = valid_until || relevance_date || null;
  // Phase 2.2: precompute normalized content so future dedup passes are cheaper.
  const normalized = normalizeText(content);
  // Q2: copy the source group's primary_child onto the notice so child-scoped
  // queries work even when the message body never names the child.
  let primaryChild = null;
  try {
    const grp = getDB().prepare('SELECT primary_child FROM groups WHERE name = ? LIMIT 1').get(group_name);
    primaryChild = grp ? grp.primary_child : null;
  } catch (_) {}
  const result = getDB().prepare(
    `INSERT INTO notices
      (group_name, content, relevance_date, relevance_time, source_timestamp, dismissed, created_at, row_type, sources,
       urgency_hint, urgency_source, relevant_datetime, message_timestamp, delivery_status, message_sent_at, valid_until,
       weekday_mismatch, validation_notes, normalized_content, calendar_worthy, event_type, primary_child,
       relevance_date_source, relevance_date_raw)
     VALUES (?, ?, ?, ?, ?, 0, ?, 'original', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    group_name, content, relevance_date || null, relevance_time || null,
    source_timestamp || Date.now(), Date.now(), JSON.stringify([group_name]),
    urgency_hint || 'routine', urgency_source || 'default', relevant_datetime || null,
    message_timestamp || source_timestamp || Date.now(),
    delivery_status || 'pending',
    message_sent_at || null,
    validUntil,
    weekday_mismatch ? 1 : 0,
    validation_notes || null,
    normalized,
    calendar_worthy ? 1 : 0,
    event_type || null,
    primaryChild,
    relevance_date_source || null,
    relevance_date_raw || null
  );

  // O8: if the source message carried a media artifact (archived attachment), copy
  // its path/type onto the new notice. The source message is identified by group +
  // timestamp, the same pair the image-notice UPDATE path (whatsapp.js) matches on.
  try {
    const srcTs = message_timestamp || source_timestamp;
    if (srcTs) {
      const media = getDB().prepare(
        `SELECT m.media_path, m.media_type
           FROM messages m JOIN groups g ON g.id = m.group_id
          WHERE g.name = ? AND m.timestamp = ? AND m.media_path IS NOT NULL
          ORDER BY m.id DESC LIMIT 1`
      ).get(group_name, srcTs);
      if (media && media.media_path) {
        getDB().prepare('UPDATE notices SET media_path = ?, media_type = ? WHERE id = ?')
          .run(media.media_path, media.media_type || null, result.lastInsertRowid);
      }
    }
  } catch (_) {}

  // Instinct Bridge: enqueue notice.upserted (best-effort, never blocks saving).
  _bridgeEnqueueNotice(result.lastInsertRowid);

  return result.lastInsertRowid;
}

/**
 * O8: backfill media_path/media_type onto historical notices from their source
 * messages. A notice's source_message_ids stores the contributing message id(s);
 * for each notice still missing media, copy the first source message that has an
 * archived artifact. Idempotent — only touches notices where media_path IS NULL.
 */
function backfillNoticeMedia() {
  try {
    getDB().exec(`
      UPDATE notices SET media_path = m.media_path, media_type = m.media_type
      FROM messages m
      WHERE notices.source_message_ids LIKE '%' || m.id || '%'
        AND m.media_path IS NOT NULL AND notices.media_path IS NULL
    `);
  } catch (_) {}
}

/**
 * Q2: migrate obligation_nudges from the old per-notice schema
 * (UNIQUE(notice_id, deadline_date), no obligation_key) to the obligation-keyed
 * schema. No-op when the table already has obligation_key (fresh DBs get the new
 * schema straight from CREATE TABLE above). Existing rows get an obligation_key
 * computed and duplicates collapse to the earliest row, whose notice_ids array
 * absorbs the collapsed notice ids.
 */
function migrateObligationNudgesSchema(db) {
  try {
    const cols = db.prepare('PRAGMA table_info(obligation_nudges)').all();
    if (!cols.length) return;                                  // table absent
    if (cols.some(c => c.name === 'obligation_key')) return;   // already migrated

    const { computeObligationKey } = require('./proactive');
    const oldRows = db.prepare('SELECT * FROM obligation_nudges ORDER BY created_at ASC, id ASC').all();

    const tx = db.transaction(() => {
      db.exec(`
        CREATE TABLE obligation_nudges_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          notice_id INTEGER NOT NULL,
          notice_ids TEXT,
          obligation_key TEXT,
          deadline_date TEXT NOT NULL,
          deadline_source TEXT,
          child_name TEXT,
          obligation_text TEXT,
          status TEXT DEFAULT 'pending',
          sent_at INTEGER,
          created_at INTEGER DEFAULT (unixepoch() * 1000),
          UNIQUE(obligation_key, deadline_date)
        )
      `);

      const insert = db.prepare(
        `INSERT OR IGNORE INTO obligation_nudges_new
           (notice_id, notice_ids, obligation_key, deadline_date, deadline_source,
            child_name, obligation_text, status, sent_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const findKept = db.prepare(
        'SELECT id, notice_ids FROM obligation_nudges_new WHERE obligation_key = ? AND deadline_date = ?'
      );
      const appendIds = db.prepare('UPDATE obligation_nudges_new SET notice_ids=? WHERE id=?');

      let collapsed = 0;
      for (const r of oldRows) {
        let threadKey = null;
        try { threadKey = db.prepare('SELECT thread_key FROM notices WHERE id=?').get(r.notice_id)?.thread_key || null; } catch (_) {}
        const key = computeObligationKey({
          threadKey, childName: r.child_name, deadlineDate: r.deadline_date, obligationText: r.obligation_text,
        });
        const res = insert.run(
          r.notice_id, JSON.stringify([r.notice_id]), key, r.deadline_date, null,
          r.child_name || null, r.obligation_text || null, r.status || 'pending', r.sent_at || null, r.created_at
        );
        if (res.changes === 0) {
          // Duplicate obligation+deadline — fold this notice into the kept row.
          collapsed++;
          const kept = findKept.get(key, r.deadline_date);
          if (kept) {
            let ids = [];
            try { ids = JSON.parse(kept.notice_ids || '[]'); } catch (_) { ids = []; }
            if (!ids.includes(r.notice_id)) { ids.push(r.notice_id); appendIds.run(JSON.stringify(ids), kept.id); }
          }
        }
      }

      db.exec('DROP TABLE obligation_nudges');
      db.exec('ALTER TABLE obligation_nudges_new RENAME TO obligation_nudges');
      console.log(`[DB] Migrated obligation_nudges to obligation-keyed schema (${oldRows.length} row(s), ${collapsed} collapsed)`);
    });
    tx();
  } catch (e) {
    console.warn('[DB] obligation_nudges schema migration failed (non-fatal):', e.message);
  }
}

/**
 * Q5: backfill existing pending obligation nudges. Recomputes each deadline from
 * the notice's current state via the canonical resolver, fills any missing
 * obligation_key, and cancels nudges whose corrected deadline has already passed.
 * Reports the changes it makes before applying them. Idempotent — a fully
 * up-to-date table produces no changes and stays quiet.
 */
function backfillObligationNudges(db) {
  try {
    const cols = db.prepare('PRAGMA table_info(obligation_nudges)').all();
    if (!cols.some(c => c.name === 'obligation_key')) return;  // pre-migration

    const rows = db.prepare("SELECT * FROM obligation_nudges WHERE status = 'pending'").all();
    if (!rows.length) return;   // nothing to do — skip loading the resolver chain

    const { resolveNoticeDate } = require('./date-parse');
    const { computeObligationKey } = require('./proactive');
    const { israelDateIso } = require('./timeUtils');
    const today = israelDateIso();
    const plan = [];   // collected before applying so we can report first
    for (const r of rows) {
      const notice = db.prepare('SELECT * FROM notices WHERE id = ?').get(r.notice_id);

      // Recompute deadline from resolver (structured signals only; content
      // fallback is the ingest path's job, not a backfill's).
      let newDeadline = r.deadline_date, newSource = r.deadline_source;
      if (notice) {
        const resolved = resolveNoticeDate(notice);
        if (resolved && resolved.iso && resolved.iso !== r.deadline_date) {
          newDeadline = resolved.iso;
          newSource = resolved.source;
        }
      }

      // Fill obligation_key if absent.
      let newKey = r.obligation_key;
      if (!newKey) {
        let threadKey = notice ? notice.thread_key : null;
        newKey = computeObligationKey({
          threadKey, childName: r.child_name, deadlineDate: newDeadline, obligationText: r.obligation_text,
        });
      }

      const cancel = newDeadline < today;
      if (newDeadline !== r.deadline_date || newKey !== r.obligation_key || cancel) {
        plan.push({ id: r.id, newDeadline, newSource, newKey, cancel, from: r.deadline_date });
      }
    }

    if (!plan.length) return;

    console.log(`[DB] Q5 obligation-nudge backfill: ${plan.length} pending row(s) need changes:`);
    for (const p of plan) {
      const bits = [];
      if (p.newDeadline !== p.from) bits.push(`deadline ${p.from}→${p.newDeadline}`);
      if (p.cancel) bits.push('cancel (past)');
      console.log(`   nudge #${p.id}: ${bits.join(', ') || 'key backfill'}`);
    }

    const upd = db.prepare(
      "UPDATE obligation_nudges SET deadline_date=?, deadline_source=?, obligation_key=?, status=? WHERE id=?"
    );
    const tx = db.transaction(() => {
      for (const p of plan) {
        upd.run(p.newDeadline, p.newSource || null, p.newKey, p.cancel ? 'missed' : 'pending', p.id);
      }
    });
    tx();
    console.log(`[DB] Q5 obligation-nudge backfill applied (${plan.filter(p => p.cancel).length} cancelled).`);
  } catch (e) {
    console.warn('[DB] obligation_nudges backfill failed (non-fatal):', e.message);
  }
}

// ── S1: corrections (self-improvement lessons) ────────────────────────────────

const CORRECTIONS_MD_PATH = '/home/ubuntu/self-improving/corrections.md';

/**
 * S1: one-time, idempotent import of the legacy markdown corrections log into the
 * corrections table. Parses each `## ...` section, extracts the YYYY-MM-DD date
 * from the header (headers may be prefixed, e.g. `## ISSUE-2026-07-22 — ...`),
 * and inserts the CONTEXT/CORRECTION/LESSON/PATTERN/STATUS fields. Existing rows
 * are matched by context text so re-runs (and mixed old+new state) never
 * duplicate. created_at is derived from the header date so ordering survives.
 */
function migrateCorrectionsFromMarkdown(db) {
  try {
    const fs = require('fs');
    if (!fs.existsSync(CORRECTIONS_MD_PATH)) return;
    const raw = fs.readFileSync(CORRECTIONS_MD_PATH, 'utf8');

    // Split into `## ` sections, keeping the header with its body.
    const sections = raw.split(/^## /m).slice(1);
    if (!sections.length) return;

    const exists = db.prepare('SELECT 1 FROM corrections WHERE context = ? LIMIT 1');
    const insert = db.prepare(
      `INSERT INTO corrections (created_at, context, correction, lesson, pattern, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    const field = (block, key) => {
      const m = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
      return m ? m[1].trim() : null;
    };

    let imported = 0;
    const tx = db.transaction(() => {
      for (const sec of sections) {
        const header = sec.split('\n', 1)[0] || '';
        const dateMatch = header.match(/(\d{4}-\d{2}-\d{2})/);
        const context = field(sec, 'CONTEXT');
        const correction = field(sec, 'CORRECTION');
        // Both are NOT NULL in the schema; skip malformed sections.
        if (!context || !correction) continue;
        if (exists.get(context)) continue;

        const createdAt = dateMatch ? Date.parse(`${dateMatch[1]}T00:00:00Z`) : null;
        insert.run(
          createdAt || (Date.now()),
          context,
          correction,
          field(sec, 'LESSON'),
          field(sec, 'PATTERN'),
          field(sec, 'STATUS') || 'open'
        );
        imported++;
      }
    });
    tx();
    if (imported) console.log(`[DB] S1 imported ${imported} correction(s) from markdown`);
  } catch (e) {
    console.warn('[DB] corrections markdown import failed (non-fatal):', e.message);
  }
}

/**
 * S1: insert a correction. Returns { id, total_for_pattern } where the count is
 * the number of rows sharing this pattern (used to decide promotion-due at 3+).
 */
function saveCorrection({ context, correction, lesson, pattern, source_message_id }) {
  const d = getDB();
  const info = d.prepare(
    `INSERT INTO corrections (context, correction, lesson, pattern, source_message_id)
     VALUES (?, ?, ?, ?, ?)`
  ).run(context, correction, lesson || null, pattern || null, source_message_id || null);
  let total_for_pattern = 0;
  if (pattern) {
    total_for_pattern = d.prepare(
      "SELECT COUNT(*) AS n FROM corrections WHERE pattern = ? AND status != 'archived'"
    ).get(pattern).n;
  }
  return { id: info.lastInsertRowid, total_for_pattern };
}

/**
 * S1: list corrections newest-first with optional since/pattern/status filters.
 */
function getCorrections({ since, pattern, status } = {}) {
  const d = getDB();
  const clauses = [];
  const params = [];
  if (since != null) { clauses.push('created_at >= ?'); params.push(Number(since)); }
  if (pattern) { clauses.push('pattern = ?'); params.push(pattern); }
  if (status) { clauses.push('status = ?'); params.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return d.prepare(`SELECT * FROM corrections ${where} ORDER BY created_at DESC, id DESC`).all(...params);
}

/**
 * S1: regenerate the markdown log from the table (a view, not the source of
 * truth). Returns { ok, count, path }.
 */
function regenerateCorrectionsMarkdown() {
  const fs = require('fs');
  const rows = getCorrections();
  const header = '# Corrections Log — regenerated from DB (newest first)\n'
    + '# Format: CONTEXT / CORRECTION / LESSON / PATTERN / STATUS\n';
  const body = rows.map(r => {
    const date = new Date(r.created_at).toISOString().slice(0, 10);
    const firstLine = String(r.correction).split('\n')[0];
    return `## ${date} — ${firstLine}\n`
      + `CONTEXT: ${r.context}\n`
      + `CORRECTION: ${r.correction}\n`
      + `LESSON: ${r.lesson || ''}\n`
      + `PATTERN: ${r.pattern || ''}\n`
      + `STATUS: ${r.status || ''}`;
  }).join('\n\n');
  const out = `${header}\n${body}${body ? '\n' : ''}`;
  fs.writeFileSync(CORRECTIONS_MD_PATH, out);
  return { ok: true, count: rows.length, path: CORRECTIONS_MD_PATH };
}

/**
 * K4: enrich a prior notice from a follow-up in the same thread.
 *
 * When a later message adds structured info the earlier notice lacked (e.g. a
 * teacher first announces "parent meeting on 9.9", then two days later posts the
 * time), that follow-up otherwise lands as a separate notice. This fills the
 * ORIGINAL notice's gaps instead — strictly gap-filling, never overwriting a
 * value that is already set.
 *
 * Matches the most recent OTHER notice sharing `threadKey` within 14 days
 * (undismissed). Only genuinely-empty (NULL/'') fields are filled; the sole
 * exception is calendar_worthy, which is promoted 0→1 (never demoted). The new
 * notice's group is appended to the target's `sources` array. created_at is
 * never touched. If the target has a linked calendar_intent whose time was
 * 'unknown' and we just supplied a time, its time_status flips to 'updated'.
 *
 * @param {number} newNoticeId  id of the just-saved follow-up (excluded from match)
 * @param {string} threadKey    thread to match on (exact)
 * @param {object} fields       candidate values from the follow-up
 * @param {string} newSource    group_name of the follow-up, appended to sources
 * @returns {{enriched:boolean, oldId?:number, fields?:string[]}} audit summary
 */
function enrichNoticeByThreadKey(newNoticeId, threadKey, fields, newSource) {
  if (!threadKey) return { enriched: false };
  try {
    const db = getDB();
    const since = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const old = db.prepare(
      `SELECT * FROM notices
        WHERE thread_key = ? AND id != ? AND dismissed = 0 AND created_at >= ?
        ORDER BY created_at DESC LIMIT 1`
    ).get(threadKey, newNoticeId, since);
    if (!old) return { enriched: false };

    // Gap-fill: only columns the target genuinely lacks (NULL or '').
    const GAP_FIELDS = ['relevance_time', 'relevance_date', 'relevant_datetime', 'valid_until', 'event_type'];
    const setClauses = [];
    const values = [];
    const enrichedFields = [];
    for (const f of GAP_FIELDS) {
      const oldVal = old[f];
      const newVal = fields[f];
      const oldEmpty = oldVal === null || oldVal === undefined || oldVal === '';
      const newHas = newVal !== null && newVal !== undefined && newVal !== '';
      if (oldEmpty && newHas) {
        setClauses.push(`${f} = ?`);
        values.push(newVal);
        enrichedFields.push(f);
      }
    }
    // calendar_worthy: promote 0→1 only (a follow-up can reveal an event is
    // calendar-worthy; it must never un-mark one).
    if (!old.calendar_worthy && fields.calendar_worthy) {
      setClauses.push('calendar_worthy = 1');
      enrichedFields.push('calendar_worthy');
    }

    // Append the follow-up's group to sources (dedup, preserve order).
    let sourcesChanged = false;
    if (newSource) {
      let sources = [];
      try { sources = JSON.parse(old.sources || '[]'); } catch (_) { sources = []; }
      if (!Array.isArray(sources)) sources = [];
      if (!sources.includes(newSource)) {
        sources.push(newSource);
        setClauses.push('sources = ?');
        values.push(JSON.stringify(sources));
        sourcesChanged = true;
      }
    }

    if (enrichedFields.length === 0 && !sourcesChanged) return { enriched: false };

    values.push(old.id);
    db.prepare(`UPDATE notices SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

    // Propagate a newly-learned time to a linked calendar intent (K3 all-day
    // events that were waiting on a time). Only touch intents still 'unknown'.
    if (enrichedFields.includes('relevance_time')) {
      try {
        db.prepare(
          `UPDATE calendar_intents
              SET time_status = 'updated', updated_at = ?
            WHERE notice_id = ? AND time_status = 'unknown'`
        ).run(Date.now(), old.id);
      } catch (_) {}
    }

    return { enriched: true, oldId: old.id, fields: enrichedFields };
  } catch (e) {
    console.error('[DB] enrichNoticeByThreadKey error:', e.message);
    return { enriched: false };
  }
}

function saveNoticeEvents(noticeId, events) {
  // events = [{date, time, title, date_source?, date_raw?}]
  // J2: date_source/date_raw carry the weekday-correction provenance the agent
  // attaches when it snaps an event's literal date to its asserted weekday.
  if (!events || events.length === 0) return;
  const stmt = getDB().prepare(
    'INSERT OR IGNORE INTO notice_event (notice_id, event_date, event_time, event_title, expires_at, created_at, event_date_source, event_date_raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const now = Date.now();
  for (const ev of events) {
    if (!ev.date || !ev.title) continue;
    // expires_at = end of that day (23:59 Israel time) in ms
    // If time given, expires 2h after that time
    // J5: use dynamic Israel offset instead of hardcoded +03:00 (UTC+2 in winter)
    const { israelOffsetMs } = require('./timeUtils');
    let expiresAt;
    if (ev.time) {
      const [h, m] = ev.time.split(':').map(Number);
      // Build a UTC date, then shift by the Israel offset for that day
      const utcMs = Date.UTC(
        ...ev.date.split('-').map((v, i) => i === 1 ? Number(v) - 1 : Number(v)),
        h, m, 0
      );
      const offsetMs = israelOffsetMs(new Date(utcMs));
      expiresAt = utcMs - offsetMs + 2 * 3600000;
    } else {
      // End of day in Israel time
      const utcMs = Date.UTC(
        ...ev.date.split('-').map((v, i) => i === 1 ? Number(v) - 1 : Number(v)),
        23, 59, 59
      );
      const offsetMs = israelOffsetMs(new Date(utcMs));
      expiresAt = utcMs - offsetMs;
    }
    stmt.run(noticeId, ev.date, ev.time || null, ev.title, expiresAt, now, ev.date_source || null, ev.date_raw || null);
  }
}

// P-020: notice_event is never queried without joining notices for visibility.
// Every notice_event reader outside voice-server.js used to skip this join, so
// query_visible=0 / dismissed=1 notices still reached reminders, calendar
// enrichment, and the reconciliation scripts. Route them all through here.
//
// Filters: from/to bound event_date inclusively; noticeId scopes to one notice.
// Any combination may be omitted. Returns the common column set the callers use.
function getVisibleNoticeEvents({ from = null, to = null, noticeId = null } = {}) {
  const conds = ['n.query_visible = 1', 'n.dismissed = 0'];
  const params = [];
  if (noticeId != null) { conds.push('ne.notice_id = ?'); params.push(noticeId); }
  if (from != null)     { conds.push('ne.event_date >= ?'); params.push(from); }
  if (to != null)       { conds.push('ne.event_date <= ?'); params.push(to); }
  return getDB().prepare(
    `SELECT ne.id, ne.notice_id, ne.event_date, ne.event_time, ne.event_title
     FROM notice_event ne
     JOIN notices n ON ne.notice_id = n.id
     WHERE ${conds.join(' AND ')}
     ORDER BY ne.event_date ASC`
  ).all(...params);
}

function getActiveNotices(todayStr) {
  // Returns notices that are still relevant and haven't been shown yet (or are due today for re-show)
  const nowMs = Date.now();
  // For notices with notice_event rows: show if any event hasn't expired yet
  // For notices without notice_event rows: fall back to valid_until/relevance_date
  return getDB().prepare(
    `SELECT n.id, n.group_name, n.content, n.relevance_date, n.relevance_time,
            n.source_timestamp, n.valid_until, n.digest_shown_at
     FROM notices n
     WHERE n.dismissed = 0
       AND (
         -- Has notice_event rows with unexpired events
         EXISTS (
           SELECT 1 FROM notice_event ne
           WHERE ne.notice_id = n.id AND ne.expires_at > ?
         )
         OR
         -- No notice_event rows: fall back to valid_until/relevance_date
         (
           NOT EXISTS (SELECT 1 FROM notice_event ne WHERE ne.notice_id = n.id)
           AND (
             COALESCE(n.valid_until, n.relevance_date) IS NULL
             OR COALESCE(n.valid_until, n.relevance_date) >= ?
           )
         )
       )
       AND (
         n.digest_shown_at IS NULL
         OR COALESCE(n.valid_until, n.relevance_date) = ?
         OR EXISTS (
           SELECT 1 FROM notice_event ne
           WHERE ne.notice_id = n.id AND ne.event_date = ?
         )
       )
     ORDER BY COALESCE(n.valid_until, n.relevance_date) ASC NULLS LAST, n.source_timestamp DESC
     LIMIT 20`
  ).all(nowMs, todayStr, todayStr, todayStr);
}

function markNoticesShownInDigest(ids, shownAtMs) {
  if (!ids || ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  getDB().prepare(
    `UPDATE notices SET digest_shown_at = ? WHERE id IN (${placeholders}) AND digest_shown_at IS NULL`
  ).run(shownAtMs, ...ids);
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

/**
 * setGroupMonitoring — single sanctioned writer for group monitoring state (B7).
 *
 * @param {string} id — group JID
 * @param {object} opts
 * @param {boolean} [opts.monitored] — true to monitor, false to stop
 * @param {string|null} [opts.relatedTo] — relationship type ('master','ignored', or null)
 * @param {string|null} [opts.primaryChild] — child name this group is associated with
 * @param {string|null} [opts.description] — free-text description / context
 */
function setGroupMonitoring(id, opts = {}) {
  const db = getDB();
  const existing = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  if (!existing) throw new Error(`setGroupMonitoring: group ${id} not found in DB`);

  const updates = [];
  const params = [];

  if ('monitored' in opts) {
    const val = opts.monitored ? 1 : 0;
    updates.push('monitored = ?');
    params.push(val);
  }
  if ('relatedTo' in opts) {
    // Validate: must be null, 'master', or 'ignored' (or any non-'monitored' string for legacy compat)
    const rt = opts.relatedTo;
    if (rt === 'monitored') {
      throw new Error("setGroupMonitoring: relatedTo='monitored' is no longer valid. Use {monitored: true} instead.");
    }
    updates.push('related_to = ?');
    params.push(rt);
  }
  if ('primaryChild' in opts) {
    updates.push('primary_child = ?');
    params.push(opts.primaryChild);
  }
  if ('description' in opts) {
    updates.push('description = ?');
    params.push(opts.description);
  }

  // Always mark as configured when monitoring state is set
  updates.push('configured = 1');

  if (updates.length === 1) return; // only 'configured = 1', nothing else to do

  params.push(id);
  db.prepare(`UPDATE groups SET ${updates.join(', ')} WHERE id = ?`).run(...params);
}

/**
 * @deprecated Use setGroupMonitoring() instead. Kept for backward compat.
 * Now routes through setGroupMonitoring internally.
 */
function setGroupRelatedTo(id, relatedTo) {
  if (relatedTo === 'monitored') {
    // Old callers that wrote related_to='monitored' now set the dedicated flag
    setGroupMonitoring(id, { monitored: true });
  } else {
    setGroupMonitoring(id, { relatedTo });
  }
}

function setGroupDescription(id, description) {
  setGroupMonitoring(id, { description });
}

// ── Persistent pending group questions ────────────────────────────────────────
function savePendingGroupQuestion(msgId, groupId, stanzaId = null) {
  getDB().prepare('INSERT OR REPLACE INTO pending_group_questions (msg_id, group_id, stanza_id, created_at) VALUES (?, ?, ?, ?)').run(msgId, groupId, stanzaId, Date.now());
}

function getPendingGroupQuestion(msgId) {
  const row = getDB().prepare('SELECT group_id FROM pending_group_questions WHERE msg_id = ?').get(msgId);
  return row ? row.group_id : null;
}

// H1: fall back to stanza_id when the serialized msg_id doesn't match.
function getPendingGroupQuestionByStanza(stanzaId) {
  if (!stanzaId) return null;
  const row = getDB().prepare('SELECT group_id FROM pending_group_questions WHERE stanza_id = ?').get(stanzaId);
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
    "SELECT * FROM groups WHERE monitored = 1 AND (description IS NULL OR description = '') AND added_at > ?"
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

function setFollowUpBotMsgId(id, botMsgId, stanzaId = null) {
  getDB().prepare('UPDATE follow_ups SET bot_msg_id = ?, stanza_id = ? WHERE id = ?').run(botMsgId, stanzaId, id);
}

function getFollowUpByBotMsgId(botMsgId) {
  return getDB().prepare('SELECT * FROM follow_ups WHERE bot_msg_id = ?').get(botMsgId);
}

// H1: fall back to stanza_id when the serialized bot_msg_id doesn't match.
function getFollowUpByStanzaId(stanzaId) {
  if (!stanzaId) return null;
  return getDB().prepare('SELECT * FROM follow_ups WHERE stanza_id = ?').get(stanzaId);
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

// ── M4: Artifact promise tracking ──────────────────────────────────────────────

/**
 * Record an artifact promise (e.g., "I'll fill this PDF for you").
 * task_type = 'artifact_promise'. Status goes pending → delivered → acknowledged.
 */
function saveArtifactPromise({ description, deliverable, target_phone = null }) {
  return saveBotTask({
    description,
    check_in_message: `הבטחתי לך ${deliverable} ולא סיפקתי — רוצה שאנסה שוב?`,
    run_at: Date.now() + 4 * 3600000, // resurface after 4 hours if undelivered
    task_type: 'artifact_promise',
    target_phone,
  });
}

/**
 * Mark an artifact promise as delivered (file sent).
 */
function markArtifactDelivered(taskId, artifactPath) {
  return getDB().prepare(
    "UPDATE bot_tasks SET artifact_path = ?, delivered_at = ?, status = 'delivered' WHERE id = ? AND task_type = 'artifact_promise'"
  ).run(artifactPath, Date.now(), taskId).changes > 0;
}

/**
 * Mark an artifact promise as acknowledged (user confirmed receipt).
 */
function markArtifactAcknowledged(taskId) {
  return getDB().prepare(
    "UPDATE bot_tasks SET acknowledged_at = ?, status = 'done' WHERE id = ? AND task_type = 'artifact_promise'"
  ).run(Date.now(), taskId).changes > 0;
}

/**
 * Get undelivered artifact promises older than `hours` hours.
 */
function getStaleArtifactPromises(hours = 4) {
  const cutoff = Date.now() - hours * 3600000;
  return getDB().prepare(
    "SELECT * FROM bot_tasks WHERE task_type = 'artifact_promise' AND status = 'pending' AND created_at < ? ORDER BY created_at ASC"
  ).all(cutoff);
}

/**
 * Get delivered but unacknowledged artifact promises older than `hours` hours.
 */
function getUnacknowledgedArtifacts(hours = 4) {
  const cutoff = Date.now() - hours * 3600000;
  return getDB().prepare(
    "SELECT * FROM bot_tasks WHERE task_type = 'artifact_promise' AND status = 'delivered' AND delivered_at < ? AND acknowledged_at IS NULL ORDER BY delivered_at ASC"
  ).all(cutoff);
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
 * Atomically reserve a reminder for sending (TASK 0.3).
 * Sets sent=1 only if it was 0, returning true if this caller "won" the reservation.
 * This is a reservation, NOT a confirmation: if the actual WhatsApp send fails,
 * the caller MUST call releaseReminder(id) to allow a retry on the next poll.
 * On successful send, call confirmReminderSent(id) for the audit trail.
 * Returns false if already reserved — prevents double-fire across instances/timeouts.
 */
function reserveReminder(id) {
  const result = getDB().prepare('UPDATE reminders SET sent = 1 WHERE id = ? AND sent = 0').run(id);
  return result.changes > 0;
}

/**
 * Release a previously reserved reminder (sent=1 → sent=0) so it can be retried.
 * Called when the WhatsApp send fails after reserveReminder() succeeded.
 */
function releaseReminder(id) {
  const result = getDB().prepare('UPDATE reminders SET sent = 0 WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Record that a reserved reminder was confirmed delivered (audit trail).
 */
function confirmReminderSent(id) {
  getDB().prepare('UPDATE reminders SET confirmed_at = ? WHERE id = ?').run(Date.now(), id);
}

/**
 * @deprecated Use reserveReminder() + confirmReminderSent()/releaseReminder().
 * Kept as an alias for backward compatibility with any external callers.
 */
function claimReminder(id) {
  return reserveReminder(id);
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

// ── Phase 2.3: Notice feedback ───────────────────────────────────────────────

/**
 * D1: look up a bot-sent message by the WhatsApp stanza id (preferred) or the
 * serialized msg id. A family reaction gives us the reacted message's stanza id;
 * this maps it back to the row that recorded which notices produced that send.
 * Returns { id, source_notice_ids, message_text } or null.
 */
function getSentMessageByStanzaId(stanzaId, msgId) {
  if (!stanzaId && !msgId) return null;
  const db = getDB();
  let row = null;
  if (stanzaId) {
    row = db.prepare(
      'SELECT id, source_notice_ids, message_text FROM sent_messages WHERE stanza_id = ? ORDER BY id DESC LIMIT 1'
    ).get(stanzaId);
  }
  if (!row && msgId) {
    row = db.prepare(
      'SELECT id, source_notice_ids, message_text FROM sent_messages WHERE msg_id = ? ORDER BY id DESC LIMIT 1'
    ).get(msgId);
  }
  return row || null;
}

/**
 * Save user feedback on a notice ('good' | 'bad' | 'missed').
 * Looks up the notice's thread_key (best-effort) so feedback survives even if the
 * notice row is later purged. Returns the inserted row id.
 */
function saveFeedback(noticeId, feedback, comment) {
  let threadKey = null;
  if (noticeId != null) {
    try {
      const row = getDB().prepare('SELECT thread_key FROM notices WHERE id = ?').get(noticeId);
      threadKey = row ? row.thread_key : null;
    } catch (_) {}
  }
  const result = getDB().prepare(
    'INSERT INTO notice_feedback (notice_id, thread_key, feedback, comment) VALUES (?, ?, ?, ?)'
  ).run(noticeId != null ? noticeId : null, threadKey, feedback, comment || null);
  return result.lastInsertRowid;
}

/**
 * Aggregate feedback stats for tuning triage.
 * Returns { total, good, bad, missed, byAction: { send_now, defer, skip } }
 * where each byAction entry is { good, bad } counted by the notice's triage_decision.
 */
function getFeedbackStats() {
  const db = getDB();
  const stats = { total: 0, good: 0, bad: 0, missed: 0 };
  const rows = db.prepare('SELECT feedback, COUNT(*) AS c FROM notice_feedback GROUP BY feedback').all();
  for (const r of rows) {
    stats.total += r.c;
    if (r.feedback === 'good') stats.good = r.c;
    else if (r.feedback === 'bad') stats.bad = r.c;
    else if (r.feedback === 'missed') stats.missed = r.c;
  }

  const byAction = {
    send_now: { good: 0, bad: 0 },
    defer:    { good: 0, bad: 0 },
    skip:     { good: 0, bad: 0 },
  };
  const actionRows = db.prepare(`
    SELECT n.triage_decision AS action, f.feedback AS feedback, COUNT(*) AS c
    FROM notice_feedback f
    JOIN notices n ON n.id = f.notice_id
    WHERE n.triage_decision IN ('send_now','defer','skip')
      AND f.feedback IN ('good','bad')
    GROUP BY n.triage_decision, f.feedback
  `).all();
  for (const r of actionRows) {
    if (byAction[r.action]) byAction[r.action][r.feedback] = r.c;
  }

  return { ...stats, byAction };
}

// ── Q6: log unanswered schedule questions ──────────────────────────────────
function logQueryMiss(question, reply, toolCalled = false) {
  try {
    getDB().prepare(
      'INSERT INTO query_misses (question, reply, tool_called, created_at) VALUES (?, ?, ?, ?)'
    ).run(question, reply || null, toolCalled ? 1 : 0, Date.now());
  } catch (e) {
    console.error('[DB] logQueryMiss error:', e.message);
  }
}

/**
 * E3: record a blocked/ungrounded field as a fabrication candidate.
 * @param {{source?:string, field_name?:string, claimed_value?:*, source_notice_id?:number, context?:string}} m
 * @returns {number|null} inserted row id, or null on failure
 */
function logGroundingMiss({ source, field_name, claimed_value, source_notice_id, context } = {}) {
  try {
    const val = claimed_value == null ? null
      : (typeof claimed_value === 'string' ? claimed_value : JSON.stringify(claimed_value));
    const info = getDB().prepare(
      `INSERT INTO grounding_misses (source, field_name, claimed_value, source_notice_id, context, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(source || null, field_name || null, val, source_notice_id == null ? null : Number(source_notice_id),
          context || null, Date.now());
    return info.lastInsertRowid;
  } catch (e) {
    console.error('[DB] logGroundingMiss error:', e.message);
    return null;
  }
}

/**
 * E3: recent grounding misses for monitoring. Returns rows newer than `days`.
 * @param {number} [days=7]
 * @returns {Array<object>}
 */
function getGroundingMisses(days = 7) {
  try {
    const cutoff = Date.now() - Number(days || 7) * 86400000;
    return getDB().prepare(
      'SELECT * FROM grounding_misses WHERE created_at >= ? ORDER BY created_at DESC'
    ).all(cutoff);
  } catch (e) {
    console.error('[DB] getGroundingMisses error:', e.message);
    return [];
  }
}

/**
 * F1: monitored groups still lacking a primary_child link — used by the health
 * check to surface unlinked groups. Returns [{name}].
 */
function getUnlinkedMonitoredGroups() {
  try {
    return getDB().prepare(
      'SELECT name FROM groups WHERE monitored = 1 AND primary_child IS NULL ORDER BY name'
    ).all();
  } catch (e) {
    console.error('[DB] getUnlinkedMonitoredGroups error:', e.message);
    return [];
  }
}

/**
 * F2: propose a child link for a group via the aliases of already-linked groups.
 * When a new school-year group arrives with no primary_child, an existing group
 * whose aliases include the new name (or vice-versa) implies the same child.
 * Returns the proposed child name or null. Read-only — the caller decides.
 * @param {string} groupName
 * @returns {string|null}
 */
function proposeChildFromAliases(groupName) {
  if (!groupName) return null;
  try {
    const rows = getDB().prepare(
      'SELECT name, primary_child, aliases FROM groups WHERE aliases IS NOT NULL AND primary_child IS NOT NULL'
    ).all();
    for (const r of rows) {
      let list = [];
      try { list = JSON.parse(r.aliases) || []; } catch (_) { continue; }
      if (Array.isArray(list) && list.includes(groupName)) return r.primary_child;
      // Also match the other direction: the incoming name IS a current group whose
      // alias points back at a prior name that shares this child.
      if (r.name === groupName) return r.primary_child;
    }
    return null;
  } catch (e) {
    console.error('[DB] proposeChildFromAliases error:', e.message);
    return null;
  }
}

// K1 / P-021: Job heartbeat writer. Every scheduled entry point calls this.
// result = 'ok' | 'empty' | 'error' | custom string.
function recordJobHeartbeat(jobName, result = 'ok') {
  const now = Date.now();
  const isEmpty = result === 'empty';
  try {
    const existing = getDB().prepare('SELECT consecutive_empty FROM job_runs WHERE job_name = ?').get(jobName);
    const consEmpty = isEmpty ? ((existing?.consecutive_empty || 0) + 1) : 0;
    getDB().prepare(`INSERT INTO job_runs (job_name, last_success_ms, last_result, consecutive_empty, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(job_name) DO UPDATE SET last_success_ms=?, last_result=?, consecutive_empty=?, updated_at=?`
    ).run(jobName, now, result, consEmpty, now, now, result, consEmpty, now);
  } catch (e) {
    console.warn('[DB] recordJobHeartbeat error (non-fatal):', e.message);
  }
}

function getJobHeartbeats() {
  try {
    return getDB().prepare('SELECT * FROM job_runs ORDER BY last_success_ms DESC').all();
  } catch (_) { return []; }
}

module.exports = {
  initDB,
  getDB,
  recordJobHeartbeat,
  getJobHeartbeats,
  saveFeedback,
  getFeedbackStats,
  getSentMessageByStanzaId,
  saveMessage,
  getRecentGroupMessages,
  markMessageProcessed,
  saveNotice,
  backfillNoticeMedia,
  enrichNoticeByThreadKey,
  logQueryMiss,
  logGroundingMiss,
  getGroundingMisses,
  getUnlinkedMonitoredGroups,
  proposeChildFromAliases,
  saveNoticeEvents,
  getVisibleNoticeEvents,
  getActiveNotices,
  markNoticesShownInDigest,
  saveEvent,
  markEventAdded,
  saveActionItem,
  saveClarification,
  getPendingActionItems,
  getUnansweredClarifications,
  saveGroup,
  setGroupRelatedTo,
  setGroupDescription,
  setGroupMonitoring,
  assertGroupMonitoringIntegrity,
  checkEnumIntegrity,
  getGroup,
  getMonitoredGroupsWithoutDescription,
  getUnconfiguredGroups,
  savePendingGroupQuestion,
  getPendingGroupQuestion,
  getPendingGroupQuestionByStanza,
  deletePendingGroupQuestion,
  getAllPendingGroupQuestions,
  saveReminder,
  cancelRemindersForEvent,
  getPendingReminders,
  markReminderSent,
  reserveReminder,
  releaseReminder,
  confirmReminderSent,
  claimReminder,
  claimDigestToday,
  hasReminder,
  saveFollowUp,
  getPendingFollowUps,
  claimFollowUp,
  setFollowUpBotMsgId,
  getFollowUpByBotMsgId,
  getFollowUpByStanzaId,
  saveCapabilityRequest,
  getPendingCapabilityRequests,
  saveBotTask,
  getPendingBotTasks,
  claimBotTask,
  cancelRecurringGroup,
  isRecurringGroupActive,
  // M4: artifact promise tracking
  saveArtifactPromise,
  markArtifactDelivered,
  markArtifactAcknowledged,
  getStaleArtifactPromises,
  getUnacknowledgedArtifacts,
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
  // Pipeline state (ISSUE-019 / P-008)
  markMessageProcessing,
  markMessageTerminal,
  markMessageFailed,
  getStuckMessages,
  getPipelineStats,
  // Media archive / retry tracking
  updateMessageMedia,
  setMediaStatus,
  incrementMediaRetry,
  updateMessageBody,
  updateMessageBodyByStanza,
  getFailedMedia,
  // Config management
  getConfigValue,
  setConfigValue,
  // LID → phone mapping cache (H5)
  getLidMapping,
  saveLidMapping,
  // S1: corrections (self-improvement lessons)
  saveCorrection,
  getCorrections,
  regenerateCorrectionsMarkdown,
};
