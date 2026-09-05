/**
 * Regression: 2026-09-04 — D1 feedback loop: reactions → gold rows.
 *
 * Reactions on the bot's own master-group messages were dropped: messages.upsert
 * skipped reactionMessage payloads, and sent_messages had no way to map a reacted
 * message back to its source notices. D1 adds:
 *   - baileys-client emits `message_reaction` for reactionMessage payloads
 *   - sent_messages.stanza_id / msg_id record each bot send
 *   - a whatsapp.js handler that maps a family 👍/👎 to saveFeedback per notice
 *
 * The reaction-parse, emoji-map, and resolution logic are inlined here to mirror
 * baileys-client.js / whatsapp.js exactly — those modules can't be required in the
 * public build (they pull in @whiskeysockets/baileys and voice-server side effects).
 *
 * UC-1: a reactionMessage payload parses to { emoji, targetStanzaId, targetFromMe, reactorJid }.
 * UC-2: getSentMessageByStanzaId maps a stanza id → source_notice_ids (msgId fallback too).
 * UC-3: a family 👎 on a bot message writes 'bad' feedback for every linked notice.
 * UC-4: the handler gates ignore non-bot targets, non-family reactors, and unmapped emoji.
 */

const Database = require('better-sqlite3');

// ── Mirror of baileys-client.js reaction detection ────────────────────────────
// (the block added before the `!rawMsg.message` skip in messages.upsert)
function parseReaction(rawMsg) {
  if (rawMsg.key && rawMsg.key.fromMe) return null; // bot's own reaction — skipped upstream
  const reaction = rawMsg.message && rawMsg.message.reactionMessage;
  if (!reaction) return null;
  const targetKey = reaction.key || {};
  return {
    emoji: reaction.text || '',
    targetStanzaId: targetKey.id || null,
    targetGroupId: targetKey.remoteJid || rawMsg.key.remoteJid,
    targetFromMe: !!targetKey.fromMe,
    reactorJid: rawMsg.key.participant || rawMsg.key.remoteJid,
  };
}

// ── Mirror of whatsapp.js buildEmojiFeedbackMap (defaults) ────────────────────
function buildEmojiFeedbackMap(env = {}) {
  const parse = (v, dflt) => (v || dflt).split(',').map(s => s.trim()).filter(Boolean);
  const map = {};
  for (const e of parse(env.FEEDBACK_EMOJI_GOOD, '👍,❤️,✅')) map[e] = 'good';
  for (const e of parse(env.FEEDBACK_EMOJI_BAD, '👎,❌')) map[e] = 'bad';
  return map;
}

// ── Mirror of db.js getSentMessageByStanzaId ──────────────────────────────────
function getSentMessageByStanzaId(db, stanzaId, msgId) {
  if (!stanzaId && !msgId) return null;
  let row = null;
  if (stanzaId) {
    row = db.prepare('SELECT id, source_notice_ids, message_text FROM sent_messages WHERE stanza_id = ? ORDER BY id DESC LIMIT 1').get(stanzaId);
  }
  if (!row && msgId) {
    row = db.prepare('SELECT id, source_notice_ids, message_text FROM sent_messages WHERE msg_id = ? ORDER BY id DESC LIMIT 1').get(msgId);
  }
  return row || null;
}

// ── Mirror of whatsapp.js message_reaction handler core ───────────────────────
// Returns the list of notice ids that received feedback (empty = ignored).
function handleReaction(db, evt, { emojiMap, familyDigits }) {
  if (!evt.targetFromMe) return [];
  const feedback = emojiMap[evt.emoji];
  if (!feedback) return [];
  const reactorUser = String(evt.reactorJid || '').split('@')[0].replace(/\D/g, '');
  if (!reactorUser || !familyDigits.has(reactorUser)) return []; // (LID resolution path omitted in this unit)
  if (!evt.targetStanzaId) return [];
  const sent = getSentMessageByStanzaId(db, evt.targetStanzaId);
  if (!sent || !sent.source_notice_ids) return [];
  let noticeIds;
  try { noticeIds = JSON.parse(sent.source_notice_ids); } catch (_) { return []; }
  if (!Array.isArray(noticeIds) || noticeIds.length === 0) return [];
  const stmt = db.prepare("INSERT INTO notice_feedback (notice_id, feedback, comment) VALUES (?, ?, ?)");
  for (const nid of noticeIds) stmt.run(nid, feedback, `reaction:${evt.emoji}`);
  return noticeIds;
}

function freshDB() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_key TEXT NOT NULL DEFAULT 'k',
      sent_at INTEGER NOT NULL,
      message_text TEXT NOT NULL,
      source_notice_ids TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER,
      group_name TEXT,
      stanza_id TEXT,
      msg_id TEXT
    );
    CREATE TABLE notice_feedback (
      id INTEGER PRIMARY KEY,
      notice_id INTEGER,
      thread_key TEXT,
      feedback TEXT CHECK(feedback IN ('good','bad','missed')),
      comment TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    );
  `);
  return db;
}

const AVIV = '15551234567';
const LIAT = '15559876543';
const STRANGER = '972500000000';
const familyDigits = new Set([AVIV, LIAT]);
const GROUP = 'master-group@g.us';

module.exports = {
  async run() {
    const errors = [];
    const emojiMap = buildEmojiFeedbackMap();

    // ── UC-1: reactionMessage payload parses to the emitted shape ──────────────
    const rawReaction = {
      key: { remoteJid: GROUP, fromMe: false, participant: `${AVIV}@s.whatsapp.net`, id: 'REACT_MSG_1' },
      message: {
        reactionMessage: {
          key: { remoteJid: GROUP, fromMe: true, id: 'BOT_STANZA_1' },
          text: '👎',
        },
      },
    };
    const evt = parseReaction(rawReaction);
    if (!evt) errors.push('UC-1: reactionMessage not detected');
    else {
      if (evt.emoji !== '👎') errors.push(`UC-1: emoji wrong (${evt.emoji})`);
      if (evt.targetStanzaId !== 'BOT_STANZA_1') errors.push(`UC-1: targetStanzaId wrong (${evt.targetStanzaId})`);
      if (evt.targetFromMe !== true) errors.push('UC-1: targetFromMe should be true (reaction on bot msg)');
      if (evt.reactorJid !== `${AVIV}@s.whatsapp.net`) errors.push(`UC-1: reactorJid wrong (${evt.reactorJid})`);
    }
    // a non-reaction message parses to null; the bot's own reaction is skipped upstream
    if (parseReaction({ key: {}, message: { conversation: 'hi' } }) !== null) errors.push('UC-1: plain message misdetected as reaction');
    if (parseReaction({ key: { fromMe: true }, message: { reactionMessage: { key: {}, text: '👍' } } }) !== null) {
      errors.push('UC-1: bot-authored reaction should be skipped');
    }

    // ── UC-2: stanza-id → source_notice_ids linkage (+ msgId fallback) ─────────
    const db = freshDB();
    db.prepare('INSERT INTO sent_messages (topic_key, sent_at, message_text, source_notice_ids, group_name, stanza_id, msg_id) VALUES (?,?,?,?,?,?,?)')
      .run('t1', Date.now(), 'digest body', JSON.stringify([101, 102]), 'GroupA', 'BOT_STANZA_1', `true_${GROUP}_BOT_STANZA_1`);
    const byStanza = getSentMessageByStanzaId(db, 'BOT_STANZA_1');
    if (!byStanza || byStanza.source_notice_ids !== '[101,102]') errors.push(`UC-2: stanza lookup wrong (${byStanza && byStanza.source_notice_ids})`);
    const byMsgId = getSentMessageByStanzaId(db, null, `true_${GROUP}_BOT_STANZA_1`);
    if (!byMsgId) errors.push('UC-2: msgId fallback lookup missed');
    if (getSentMessageByStanzaId(db, 'NO_SUCH') !== null) errors.push('UC-2: unknown stanza should return null');

    // ── UC-3: family 👎 writes 'bad' feedback for every linked notice ──────────
    const applied = handleReaction(db, evt, { emojiMap, familyDigits });
    if (applied.length !== 2 || applied[0] !== 101 || applied[1] !== 102) {
      errors.push(`UC-3: expected feedback for [101,102], got [${applied}]`);
    }
    const fbRows = db.prepare("SELECT notice_id, feedback, comment FROM notice_feedback ORDER BY notice_id").all();
    if (fbRows.length !== 2) errors.push(`UC-3: expected 2 feedback rows, got ${fbRows.length}`);
    if (fbRows.some(r => r.feedback !== 'bad')) errors.push('UC-3: feedback value should be bad');
    if (fbRows.some(r => r.comment !== 'reaction:👎')) errors.push('UC-3: comment should record the emoji');

    // ── UC-4: gates reject non-bot target, stranger, and unmapped emoji ────────
    const before = db.prepare('SELECT COUNT(*) c FROM notice_feedback').get().c;

    // (a) reaction on a non-bot message (targetFromMe=false)
    handleReaction(db, { ...evt, targetFromMe: false }, { emojiMap, familyDigits });
    // (b) reaction from a stranger
    handleReaction(db, { ...evt, reactorJid: `${STRANGER}@s.whatsapp.net` }, { emojiMap, familyDigits });
    // (c) unmapped emoji (e.g. 😂)
    handleReaction(db, { ...evt, emoji: '😂' }, { emojiMap, familyDigits });
    // (d) reaction removed (empty emoji string)
    handleReaction(db, { ...evt, emoji: '' }, { emojiMap, familyDigits });

    const after = db.prepare('SELECT COUNT(*) c FROM notice_feedback').get().c;
    if (after !== before) errors.push(`UC-4: gated reactions wrote feedback (${before} → ${after})`);

    // positive control: a family ✅ (good) is accepted
    db.prepare('INSERT INTO sent_messages (topic_key, sent_at, message_text, source_notice_ids, group_name, stanza_id) VALUES (?,?,?,?,?,?)')
      .run('t2', Date.now(), 'another', JSON.stringify([200]), 'GroupB', 'BOT_STANZA_2');
    const good = handleReaction(db, { emoji: '✅', targetStanzaId: 'BOT_STANZA_2', targetFromMe: true, reactorJid: `${LIAT}@s.whatsapp.net` }, { emojiMap, familyDigits });
    if (good.length !== 1) errors.push('UC-4: family ✅ on bot message should record good feedback');
    const goodRow = db.prepare("SELECT feedback FROM notice_feedback WHERE notice_id=200").get();
    if (!goodRow || goodRow.feedback !== 'good') errors.push(`UC-4: ✅ should map to good (got ${goodRow && goodRow.feedback})`);

    return errors.length === 0
      ? { pass: true, message: 'D1: family reactions on bot messages map to per-notice feedback; gates reject non-bot/stranger/unmapped.' }
      : { pass: false, message: errors.join('\n         ') };
  },
};
