/**
 * Regression: 2026-08-30 — Quoted-reply ID reconstruction (ISSUE-023, H1)
 *
 * getQuotedMessage() reconstructed the quoted message's id AFTER the
 * BaileysMessage constructor had already computed id._serialized, and it
 * included a `participant` suffix that the bot's own sent messages never carry.
 * Result: `_ser(quoted.id)` never matched what savePendingGroupQuestion() stored,
 * so every quoted reply in the master group fell through silently.
 *
 * Fix: determine fromMe BEFORE constructing the quoted message, omit participant
 * when fromMe, and fall back to stanza_id (stable in both directions) on lookups.
 *
 * UC-1: a reply quoting a bot-sent group message reconstructs _serialized to
 *       exactly what sendMessage() returned (which is what we store).
 * UC-2: quoted.id.fromMe is true for a bot-quoted message.
 * UC-3: stanzaIdOf() recovers the same stanza from both directions.
 * UC-4: when the serialized id differs (e.g. quoted participant surfaces as a
 *       LID and fromMe can't be proven), the stanza_id DB lookup still succeeds.
 */

const { BaileysMessage, stanzaIdOf } = require('../../src/baileys-client');

const GROUP_JID = '972547860456-1396447584@g.us';
const BOT_JID = '972500000000@s.whatsapp.net';
const MEMBER_JID = '972541112222@s.whatsapp.net';

function makeClient() {
  return { _myJid: BOT_JID };
}

// Simulate what client.sendMessage() returns for a bot message to a group:
// Baileys hands back a key with fromMe:true and NO participant.
function botSentMessage(client, stanzaId, text) {
  return new BaileysMessage(client, {
    key: { remoteJid: GROUP_JID, fromMe: true, id: stanzaId },
    message: { conversation: text },
    messageTimestamp: 0,
  });
}

// Simulate an inbound reply from a family member that quotes the bot message.
function replyQuoting(client, quotedStanzaId, quotedParticipant, quotedText) {
  return new BaileysMessage(client, {
    key: { remoteJid: GROUP_JID, fromMe: false, id: 'REPLY_STANZA', participant: MEMBER_JID },
    message: {
      extendedTextMessage: {
        text: 'שגב',
        contextInfo: {
          stanzaId: quotedStanzaId,
          participant: quotedParticipant,
          quotedMessage: { conversation: quotedText },
        },
      },
    },
    messageTimestamp: 0,
  });
}

module.exports = {
  async run() {
    const errors = [];
    const client = makeClient();
    const _ser = (id) => (id && id._serialized) || undefined;

    // ── UC-1/UC-2/UC-3: round-trip a bot-quoted group message ────────────────
    const sent = botSentMessage(client, 'STANZA_A', '🆕 נוספתי לקבוצה חדשה: ⟦נעורים⟧');
    const storedId = _ser(sent.id);
    const storedStanza = stanzaIdOf(sent.id);

    const reply = replyQuoting(client, 'STANZA_A', BOT_JID, sent.body);
    const quoted = await reply.getQuotedMessage();

    if (_ser(quoted.id) !== storedId) {
      errors.push(`UC-1: reconstructed _serialized "${_ser(quoted.id)}" !== stored "${storedId}"`);
    }
    if (quoted.id.fromMe !== true || quoted.fromMe !== true) {
      errors.push(`UC-2: bot-quoted message should be fromMe=true, got id.fromMe=${quoted.id.fromMe} fromMe=${quoted.fromMe}`);
    }
    if (stanzaIdOf(quoted.id) !== 'STANZA_A' || storedStanza !== 'STANZA_A') {
      errors.push(`UC-3: stanzaIdOf mismatch (quoted=${stanzaIdOf(quoted.id)}, stored=${storedStanza})`);
    }

    // ── UC-4: stanza_id lookup succeeds even when the serialized id diverges ──
    // Simulate the quoted participant surfacing as a LID (fromMe unprovable):
    // the serialized id will NOT match, but stanza_id still does.
    const lidReply = replyQuoting(client, 'STANZA_A', '88887777@lid', sent.body);
    const lidQuoted = await lidReply.getQuotedMessage();
    if (_ser(lidQuoted.id) === storedId) {
      errors.push('UC-4a: expected serialized id to diverge for the LID case, but it matched (test premise broken)');
    }
    if (stanzaIdOf(lidQuoted.id) !== storedStanza) {
      errors.push(`UC-4b: stanza fallback failed — ${stanzaIdOf(lidQuoted.id)} !== ${storedStanza}`);
    }

    // ── UC-5: DB round-trip — msg_id lookup and stanza_id fallback ───────────
    try {
      const { initDB, savePendingGroupQuestion, getPendingGroupQuestion, getPendingGroupQuestionByStanza, deletePendingGroupQuestion } = require('../../src/db');
      initDB();
      const testMsgId = storedId;
      savePendingGroupQuestion(testMsgId, GROUP_JID, storedStanza);
      try {
        if (getPendingGroupQuestion(testMsgId) !== GROUP_JID) {
          errors.push('UC-5a: getPendingGroupQuestion by msg_id failed to return the group');
        }
        // The LID reply's serialized id is not in the DB — only stanza fallback works.
        if (getPendingGroupQuestion(_ser(lidQuoted.id)) === GROUP_JID) {
          errors.push('UC-5b: LID serialized id unexpectedly matched a stored msg_id (test premise broken)');
        }
        if (getPendingGroupQuestionByStanza(stanzaIdOf(lidQuoted.id)) !== GROUP_JID) {
          errors.push('UC-5c: stanza_id fallback lookup failed to return the group');
        }
      } finally {
        deletePendingGroupQuestion(testMsgId);
      }
    } catch (e) {
      errors.push('UC-5: DB round-trip errored — ' + e.message);
    }

    return errors.length === 0
      ? { pass: true, message: 'Quoted-reply id reconstructs correctly; stanza_id fallback works in both directions.' }
      : { pass: false, message: errors.join('\n         ') };
  },
};
