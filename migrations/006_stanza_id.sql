-- Migration 006: stanza_id for reply-based lookups
-- ISSUE-023 (H1): the serialized WhatsApp message id used as the lookup key for
-- quoted replies is reconstructed from JID-format details that differ between the
-- sent-message direction and the quoted-reply direction, so reply lookups miss.
-- stanza_id is the only identifier stable in both directions. We store it at send
-- time and fall back to it when the serialized id doesn't match.
--
-- Applied automatically as a safe migration in src/db.js (ALTER TABLE ... in
-- try/catch); this file documents the change for manual/fresh setups.

ALTER TABLE pending_group_questions ADD COLUMN stanza_id TEXT;
ALTER TABLE follow_ups ADD COLUMN stanza_id TEXT;

CREATE INDEX IF NOT EXISTS idx_pgq_stanza ON pending_group_questions(stanza_id);
CREATE INDEX IF NOT EXISTS idx_followups_stanza ON follow_ups(stanza_id);
