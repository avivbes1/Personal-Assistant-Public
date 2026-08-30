/**
 * Regression: 2026-08-30 — B2 group-name column replaces 8-char substring matching.
 *
 * WORKPLAN-V4 B2 acceptance:
 *   - two groups sharing a 10-char Hebrew prefix get INDEPENDENT daily caps
 *     (old substring(0,8) matching cross-suppressed them)
 *   - a synthesized message that omits the group name still counts toward the cap
 *     (old substring matching missed it → cap under-fired)
 *
 * Runs against a throwaway in-memory SQLite DB — no dependency on the live
 * database. saveSentMessage()/getSentRecent() are inlined here to mirror
 * triage-engine.js exactly (that module can't be required in the public build:
 * it pulls in lib/voice-client, which ships only on the production box).
 */

const Database = require('better-sqlite3');

// Mirror of triage-engine.js saveSentMessage() — INSERT threads group_name.
function saveSentMessage(db, topicKey, text, noticeIds, groupName = null) {
  db.prepare(`
    INSERT INTO sent_messages (topic_key, sent_at, message_text, source_notice_ids, group_name)
    VALUES (?, ?, ?, ?, ?)
  `).run(topicKey, Date.now(), text, JSON.stringify(noticeIds), groupName);
}

// Mirror of triage-engine.js getSentRecent() — SELECT includes group_name.
function getSentRecent(db) {
  return db.prepare(`
    SELECT topic_key, sent_at, message_text, source_notice_ids, group_name
    FROM sent_messages ORDER BY sent_at ASC
  `).all();
}

// Two class groups sharing an 11-char prefix ("הורי נעורים"). substring(0,8)
// ("הורי נעו") is identical for both — the exact bug B2 fixes.
const GROUP_A = "הורי נעורים רשפים א'";
const GROUP_B = "הורי נעורים רשפים ב'";
const GROUP_DAILY_CAP = 3;

function freshDB() {
  const db = new Database(':memory:');
  // Mirror the live sent_messages shape, including the B2 group_name column.
  db.exec(`
    CREATE TABLE sent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_key TEXT NOT NULL DEFAULT 'k',
      sent_at INTEGER NOT NULL,
      message_text TEXT NOT NULL,
      source_notice_ids TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER,
      group_name TEXT
    );
  `);
  return db;
}

// The daily-cap predicate as it now lives in triage-engine.js: exact group_name
// equality on the column, not a message-text substring.
function capCount(sent, group) {
  return sent.filter(s => s.group_name && s.group_name === group).length;
}

// The OLD predicate, kept here only to prove the regression is real.
function oldCapCount(sent, group) {
  return sent.filter(s => s.message_text && s.message_text.includes(group.substring(0, 8))).length;
}

module.exports = {
  async run() {
    const errors = [];
    const db = freshDB();

    // Fill group A to its daily cap with realistic synthesized text.
    for (let i = 0; i < GROUP_DAILY_CAP; i++) {
      saveSentMessage(db, `a-${i}`, `‏💡 *${GROUP_A}:*\nהודעה ${i}`, [100 + i], GROUP_A);
    }

    const sent = getSentRecent(db);

    // 1. group_name threaded through save + read.
    if (sent.length !== GROUP_DAILY_CAP) {
      errors.push(`expected ${GROUP_DAILY_CAP} sent rows, got ${sent.length}`);
    }
    if (sent.some(s => s.group_name !== GROUP_A)) {
      errors.push('saveSentMessage/getSentRecent did not round-trip group_name');
    }

    // 2. Group A is at cap; Group B (10-char shared prefix) is independent.
    if (capCount(sent, GROUP_A) !== GROUP_DAILY_CAP) {
      errors.push(`group A count should be ${GROUP_DAILY_CAP}, got ${capCount(sent, GROUP_A)}`);
    }
    if (capCount(sent, GROUP_B) !== 0) {
      errors.push(`group B should be uncapped (0), got ${capCount(sent, GROUP_B)} — cross-group suppression`);
    }

    // 3. Regression proof: the old substring predicate WOULD have suppressed B.
    if (oldCapCount(sent, GROUP_B) === 0) {
      errors.push('old substring predicate no longer conflates the groups — test is no longer meaningful');
    }

    // 4. Under-fire case: a message that omits the group name still counts by column.
    const db2 = freshDB();
    saveSentMessage(db2, 'nogroupname', 'תזכורת: מחר יש חוג', [200], GROUP_A);
    const sent2 = getSentRecent(db2);
    if (capCount(sent2, GROUP_A) !== 1) {
      errors.push('column cap missed a message whose text omits the group name (under-fire)');
    }
    if (oldCapCount(sent2, GROUP_A) !== 0) {
      errors.push('old substring predicate unexpectedly matched name-less text — test invalid');
    }

    if (errors.length > 0) {
      return { pass: false, message: 'Failed:\n  ' + errors.join('\n  ') };
    }
    return {
      pass: true,
      message: 'B2: group_name column gives independent caps for prefix-sharing groups; counts name-less messages',
    };
  },
};
