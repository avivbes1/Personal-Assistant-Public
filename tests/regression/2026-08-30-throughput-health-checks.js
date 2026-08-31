/**
 * Regression: 2026-08-30 — A4 throughput/integrity health checks.
 *
 * WORKPLAN-V4 A4 acceptance:
 *   - inject a stuck-message batch → terminal-state alert fires
 *   - set a group's related_to to junk → config-integrity alert fires
 *
 * Each check function takes (db, nowMs), so we drive them against a throwaway
 * in-memory SQLite DB — no dependency on the live database, fully deterministic.
 */

const Database = require('better-sqlite3');
const {
  checkIngestionVolume,
  checkTerminalStateRate,
  checkMediaParseRate,
  checkDeliveryDuplicates,
  checkConfigStateIntegrity,
  checkMonitoredGroupSilence,
  getIsraelHour,
} = (() => {
  const ht = require('../../src/health-throughput');
  const { getIsraelHour } = require('../../src/timeUtils');
  return { ...ht, getIsraelHour };
})();

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function freshDB() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      sender TEXT NOT NULL DEFAULT 'x',
      body TEXT NOT NULL DEFAULT '',
      timestamp INTEGER NOT NULL,
      pipeline_state TEXT DEFAULT 'RECEIVED',
      pipeline_error TEXT,
      media_type TEXT,
      media_status TEXT
    );
    CREATE TABLE sent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_key TEXT NOT NULL DEFAULT 'k',
      sent_at INTEGER NOT NULL,
      message_text TEXT NOT NULL,
      source_notice_ids TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE pending_group_questions (
      msg_id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      related_to TEXT,
      added_at INTEGER NOT NULL DEFAULT 0,
      configured INTEGER DEFAULT 0,
      monitored INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

module.exports = {
  async run() {
    const errors = [];
    const now = Date.parse('2026-08-15T09:00:00Z'); // Israel ~12:00 (daytime) in August
    const insMsg = (db, o) => db.prepare(
      'INSERT INTO messages (group_id, timestamp, pipeline_state, pipeline_error, media_type, media_status) VALUES (?,?,?,?,?,?)'
    ).run(o.group_id || 'g1@g.us', o.timestamp, o.pipeline_state || 'NOT_ACTIONABLE', o.pipeline_error || null, o.media_type || null, o.media_status || null);

    // --- 1. Ingestion volume ---
    {
      const db = freshDB();
      // no messages at all during daytime → alert
      const fail = checkIngestionVolume(db, now);
      if (getIsraelHour(now) >= 11 && getIsraelHour(now) < 23) {
        if (!fail) errors.push('ingestion: expected alert when 0 messages in daytime window');
        // now add a recent message → no alert
        insMsg(db, { timestamp: now - HOUR });
        if (checkIngestionVolume(db, now)) errors.push('ingestion: unexpected alert after recent message inserted');
      }
      // master-group traffic must NOT count as ingestion
      const db2 = freshDB();
      insMsg(db2, { group_id: '120363426994367917@g.us', timestamp: now - HOUR });
      if (getIsraelHour(now) >= 11 && getIsraelHour(now) < 23 && !checkIngestionVolume(db2, now)) {
        errors.push('ingestion: master-group message wrongly counted as inbound');
      }
    }

    // --- 2. Terminal-state rate (the stuck-message batch) ---
    {
      const db = freshDB();
      // 18 healthy recent, 2 stuck FAILED older than 30 min → 10% > 5%
      for (let i = 0; i < 18; i++) insMsg(db, { timestamp: now - HOUR });
      insMsg(db, { timestamp: now - 2 * HOUR, pipeline_state: 'FAILED', pipeline_error: JSON.stringify({ code: 'API_ERROR', detail: 'x' }) });
      insMsg(db, { timestamp: now - 2 * HOUR, pipeline_state: 'FAILED', pipeline_error: JSON.stringify({ code: 'API_ERROR', detail: 'y' }) });
      const fail = checkTerminalStateRate(db, now);
      if (!fail) errors.push('terminal-state: expected alert for stuck batch >5%');
      else if (!/API_ERROR/.test(fail)) errors.push('terminal-state: alert missing top failure code');

      // recently-arrived FAILED (< 30 min old) must NOT count as stuck
      const db2 = freshDB();
      for (let i = 0; i < 18; i++) insMsg(db2, { timestamp: now - HOUR });
      insMsg(db2, { timestamp: now - 5 * 60 * 1000, pipeline_state: 'FAILED', pipeline_error: '{"code":"X"}' });
      insMsg(db2, { timestamp: now - 5 * 60 * 1000, pipeline_state: 'FAILED', pipeline_error: '{"code":"X"}' });
      if (checkTerminalStateRate(db2, now)) errors.push('terminal-state: fresh FAILED (<30min) should not count as stuck');

      // healthy DB → no alert
      const db3 = freshDB();
      for (let i = 0; i < 20; i++) insMsg(db3, { timestamp: now - HOUR, pipeline_state: 'NOT_ACTIONABLE' });
      if (checkTerminalStateRate(db3, now)) errors.push('terminal-state: false positive on healthy DB');
    }

    // --- 3. Media parse rate ---
    {
      const db = freshDB();
      // 10 media, 3 failed → 30% > 20%
      for (let i = 0; i < 7; i++) insMsg(db, { timestamp: now - HOUR, media_type: 'image', media_status: 'processed' });
      for (let i = 0; i < 3; i++) insMsg(db, { timestamp: now - HOUR, media_type: 'image', media_status: 'failed' });
      if (!checkMediaParseRate(db, now)) errors.push('media: expected alert for 30% failure rate');

      // below min sample → no alert even if all failed
      const db2 = freshDB();
      insMsg(db2, { timestamp: now - HOUR, media_type: 'image', media_status: 'failed' });
      if (checkMediaParseRate(db2, now)) errors.push('media: should not alert below min sample');

      // healthy → no alert
      const db3 = freshDB();
      for (let i = 0; i < 10; i++) insMsg(db3, { timestamp: now - HOUR, media_type: 'image', media_status: 'processed' });
      if (checkMediaParseRate(db3, now)) errors.push('media: false positive on all-processed');
    }

    // --- 4. Delivery duplicate canary ---
    {
      const db = freshDB();
      const txt = 'תזכורת: מחר יש טיול לכל הכיתה צריך להביא כובע ומים';
      db.prepare('INSERT INTO sent_messages (sent_at, message_text) VALUES (?,?)').run(now - HOUR, txt);
      db.prepare('INSERT INTO sent_messages (sent_at, message_text) VALUES (?,?)').run(now - 2 * HOUR, txt);
      if (!checkDeliveryDuplicates(db, now)) errors.push('duplicate: expected alert for identical sent messages');

      // distinct messages → no alert
      const db2 = freshDB();
      db2.prepare('INSERT INTO sent_messages (sent_at, message_text) VALUES (?,?)').run(now - HOUR, 'מחר טיול לכיתה');
      db2.prepare('INSERT INTO sent_messages (sent_at, message_text) VALUES (?,?)').run(now - HOUR, 'שיעור שחייה ביום חמישי בבוקר בבריכה');
      if (checkDeliveryDuplicates(db2, now)) errors.push('duplicate: false positive on distinct messages');

      // identical but older than 24h → no alert
      const db3 = freshDB();
      db3.prepare('INSERT INTO sent_messages (sent_at, message_text) VALUES (?,?)').run(now - 2 * DAY, txt);
      db3.prepare('INSERT INTO sent_messages (sent_at, message_text) VALUES (?,?)').run(now - 3 * DAY, txt);
      if (checkDeliveryDuplicates(db3, now)) errors.push('duplicate: should ignore pairs older than 24h');
    }

    // --- 5. Config-state integrity (the junk related_to) ---
    {
      const db = freshDB();
      db.prepare('INSERT INTO groups (id, name, related_to, configured) VALUES (?,?,?,1)').run('g1@g.us', 'הורי נעורים רשפים', 'שגב');
      const fail = checkConfigStateIntegrity(db, now);
      if (!fail) errors.push('config: expected alert for junk related_to on configured group');
      else if (!/related_to/.test(fail)) errors.push('config: alert missing related_to detail');

      // stale pending question → alert
      const db2 = freshDB();
      db2.prepare('INSERT INTO pending_group_questions (msg_id, group_id, created_at) VALUES (?,?,?)').run('m1', 'g1@g.us', now - 3 * DAY);
      if (!checkConfigStateIntegrity(db2, now)) errors.push('config: expected alert for pending question >48h');

      // sanctioned values + NULL + recent pending → no alert
      const db3 = freshDB();
      for (const rt of ['monitored', 'master', 'ignored', 'unmonitored', null]) {
        db3.prepare('INSERT INTO groups (id, name, related_to, configured) VALUES (?,?,?,1)').run('id-' + String(rt), 'n', rt);
      }
      db3.prepare('INSERT INTO pending_group_questions (msg_id, group_id, created_at) VALUES (?,?,?)').run('m2', 'g@g.us', now - HOUR);
      if (checkConfigStateIntegrity(db3, now)) errors.push('config: false positive on sanctioned values');
    }

    // --- 6. Monitored-group silence ---
    {
      const db = freshDB();
      db.prepare('INSERT INTO groups (id, name, monitored, configured) VALUES (?,?,?,1)').run('g-silent@g.us', 'קבוצה שקטה', 1);
      insMsg(db, { group_id: 'g-silent@g.us', timestamp: now - 10 * DAY }); // last msg 10 days ago
      if (!checkMonitoredGroupSilence(db, now)) errors.push('silence: expected alert for 7+ day silent monitored group');

      // monitored group with recent traffic → no alert
      const db2 = freshDB();
      db2.prepare('INSERT INTO groups (id, name, monitored, configured) VALUES (?,?,?,1)').run('g-live@g.us', 'קבוצה פעילה', 1);
      insMsg(db2, { group_id: 'g-live@g.us', timestamp: now - 2 * DAY });
      if (checkMonitoredGroupSilence(db2, now)) errors.push('silence: false positive on active monitored group');
    }

    if (errors.length > 0) {
      return { pass: false, message: errors.join('\n         ') };
    }
    return { pass: true, message: 'All 6 A4 throughput/integrity checks behave correctly (stuck batch + junk related_to alert; healthy states quiet)' };
  },
};
