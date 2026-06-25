-- Migration 004: Add pipeline state tracking to messages table
-- ISSUE-019: Every message must reach a terminal pipeline state (P-008)

ALTER TABLE messages ADD COLUMN pipeline_state TEXT DEFAULT 'RECEIVED';
ALTER TABLE messages ADD COLUMN pipeline_error TEXT;
ALTER TABLE messages ADD COLUMN processing_started_at INTEGER;
ALTER TABLE messages ADD COLUMN processing_completed_at INTEGER;
ALTER TABLE messages ADD COLUMN notice_id INTEGER REFERENCES notices(id);
ALTER TABLE messages ADD COLUMN retry_count INTEGER DEFAULT 0;

-- Backfill: existing messages are already done, mark as NOT_ACTIONABLE (we don't know which created notices)
UPDATE messages SET pipeline_state = 'NOT_ACTIONABLE', processing_completed_at = timestamp WHERE pipeline_state IS 'RECEIVED';

-- Index for stuck-message scanner
CREATE INDEX IF NOT EXISTS idx_messages_pipeline_state ON messages(pipeline_state, processing_started_at);
