-- Migration 005: Config management + change log for autonomous Lipa fixes
-- ISSUE-019: Lipa can adjust bounded config values autonomously

CREATE TABLE IF NOT EXISTS bot_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  value_type TEXT DEFAULT 'integer',
  min_value TEXT,
  max_value TEXT,
  description TEXT,
  modified_at INTEGER DEFAULT (strftime('%s','now') * 1000),
  modified_by TEXT DEFAULT 'system'
);

CREATE TABLE IF NOT EXISTS config_change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reason TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  applied_at INTEGER DEFAULT (strftime('%s','now') * 1000),
  metrics_before TEXT,
  metrics_after TEXT,
  reverted_at INTEGER,
  revert_reason TEXT
);

-- Seed initial config values
INSERT OR IGNORE INTO bot_config (key, value, value_type, min_value, max_value, description) VALUES
  ('haiku_max_tokens', '2048', 'integer', '512', '4096', 'Max tokens for Haiku extraction calls in handleGroupEvent'),
  ('message_processing_timeout_ms', '300000', 'integer', '60000', '1800000', 'Max ms before a PROCESSING message is declared stuck'),
  ('retry_max_attempts', '3', 'integer', '1', '5', 'Max retry attempts for FAILED messages');
