/**
 * Regression: 2026-09-04 — Capture WhatsApp message edits (E1)
 *
 * Only messages.upsert was subscribed, so messages.update (where Baileys
 * delivers edits) was never processed: an edited message left its original
 * notice stale. E1 adds stanza_id capture on insert, a messages.update handler
 * that emits message_edit, and updateMessageBodyByStanza() which rewrites the
 * stored body, archives the old body, and resets the row for re-extraction.
 *
 * UC-1: an edit rewrites body, archives the prior body to body_history, and
 *       resets processed=0 / pipeline_state='RECEIVED' / updated_at.
 * UC-2: an edit for an unknown stanza returns null (no crash, no row touched).
 * UC-3: a redelivered edit with identical body is a no-op (no duplicate history).
 * UC-4: the existing updateMessageBody(id, body) media path is unaffected.
 */

const {
  initDB,
  getDB,
  saveMessage,
  updateMessageBodyByStanza,
  updateMessageBody,
} = require('../../src/db');

const GROUP_JID = 'e1-test-group@g.us';
const STANZA = 'E1_STANZA_TEST_001';

module.exports = {
  async run() {
    const errors = [];
    initDB();
    const db = getDB();

    // Clean any residue from a prior aborted run.
    db.prepare('DELETE FROM messages WHERE group_id=?').run(GROUP_JID);

    try {
      // ── seed: a message with a stanza_id ──────────────────────────────────
      const msgId = saveMessage({
        group_id: GROUP_JID,
        sender: 'teacher',
        body: 'מחר טיול בשעה 8',
        timestamp: 1757000000000,
        stanza_id: STANZA,
      });
      if (!msgId) errors.push('setup: saveMessage returned no id');

      const seeded = db.prepare('SELECT stanza_id FROM messages WHERE id=?').get(msgId);
      if (!seeded || seeded.stanza_id !== STANZA) {
        errors.push(`setup: stanza_id not persisted (got ${seeded && seeded.stanza_id})`);
      }

      // ── UC-1: apply an edit ───────────────────────────────────────────────
      const editedId = updateMessageBodyByStanza(STANZA, GROUP_JID, 'מחר טיול בשעה 9');
      if (editedId !== msgId) errors.push(`UC-1: edit returned id ${editedId}, expected ${msgId}`);

      const row = db.prepare('SELECT body, body_history, processed, pipeline_state, updated_at FROM messages WHERE id=?').get(msgId);
      if (row.body !== 'מחר טיול בשעה 9') errors.push(`UC-1: body not updated (got "${row.body}")`);
      if (row.processed !== 0) errors.push(`UC-1: processed not reset (got ${row.processed})`);
      if (row.pipeline_state !== 'RECEIVED') errors.push(`UC-1: pipeline_state not reset (got ${row.pipeline_state})`);
      if (!row.updated_at) errors.push('UC-1: updated_at not set');
      let history;
      try { history = JSON.parse(row.body_history); } catch (_) { history = null; }
      if (!Array.isArray(history) || history.length !== 1) {
        errors.push(`UC-1: body_history should have 1 entry (got ${row.body_history})`);
      } else if (history[0].body !== 'מחר טיול בשעה 8') {
        errors.push(`UC-1: archived old body wrong (got "${history[0].body}")`);
      }

      // ── UC-2: edit for an unknown stanza ──────────────────────────────────
      const unknown = updateMessageBodyByStanza('NO_SUCH_STANZA', GROUP_JID, 'whatever');
      if (unknown !== null) errors.push(`UC-2: unknown stanza should return null (got ${unknown})`);

      // ── UC-3: redelivered identical edit is a no-op ───────────────────────
      const again = updateMessageBodyByStanza(STANZA, GROUP_JID, 'מחר טיול בשעה 9');
      if (again !== msgId) errors.push(`UC-3: identical edit should return id ${msgId} (got ${again})`);
      const row3 = db.prepare('SELECT body_history FROM messages WHERE id=?').get(msgId);
      const hist3 = JSON.parse(row3.body_history);
      if (hist3.length !== 1) errors.push(`UC-3: identical edit must not append history (len=${hist3.length})`);

      // ── UC-4: legacy media-path updateMessageBody(id, body) still works ────
      updateMessageBody(msgId, 'extracted media text');
      const row4 = db.prepare('SELECT body FROM messages WHERE id=?').get(msgId);
      if (row4.body !== 'extracted media text') {
        errors.push(`UC-4: updateMessageBody(id, body) broke (got "${row4.body}")`);
      }
    } finally {
      db.prepare('DELETE FROM messages WHERE group_id=?').run(GROUP_JID);
    }

    return errors.length === 0
      ? { pass: true, message: 'Message edits update body, archive history, and re-queue for extraction.' }
      : { pass: false, message: errors.join('\n         ') };
  },
};
