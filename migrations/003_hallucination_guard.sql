-- 003_hallucination_guard.sql
-- Hallucination Guard: proactive outbound messages must be grounded in
-- verifiable DB records. This migration adds the audit + dedup tables the
-- guard relies on.
--
-- blocked_actions: audit trail of every proactive send the guard REFUSED,
--   with the reason. Lets us see what the LLM tried to hallucinate.
-- sent_reminders:  idempotency ledger — one row per (source_type, source_id)
--   that has already been reminded about, so we never double-send.

CREATE TABLE IF NOT EXISTS blocked_actions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  action_type  TEXT,
  payload_json TEXT,
  block_reason TEXT,
  created_at   INTEGER
);

CREATE TABLE IF NOT EXISTS sent_reminders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type  TEXT,
  source_id    INTEGER,
  sent_at      INTEGER,
  message_hash TEXT,
  UNIQUE(source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_blocked_actions_created ON blocked_actions(created_at);
CREATE INDEX IF NOT EXISTS idx_sent_reminders_source   ON sent_reminders(source_type, source_id);
