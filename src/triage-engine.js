'use strict';
/**
 * triage-engine.js — Reasoning-based notice triage (15-min window)
 *
 * Architecture (two-step per Anthropic best practices):
 *   Step 1: Classification call → JSON (send_now / defer / skip / send_update)
 *   Step 2: Synthesis call per merge_group → Hebrew WhatsApp message
 *
 * Shadow mode: SHADOW_MODE=true logs decisions without sending.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getFamilyContext } = require('./family-profiles');
const config = require('./config');

const { initDB, getDB } = require('./db');
const https = require('https');
const fs = require('fs');
const path = require('path');
// P-012: triage is the SINGLE master-group sender. Prefer the production
// voice-client (lib/voice-client, ships on the prod box); fall back to a direct
// HTTP POST to the local voice-server (:3001) — the exact contract the delivery
// launchers used — when that artifact is absent, so the sole sender is never
// dark just because the client wrapper is missing.
function _httpVoiceSend(jid, text) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const body = JSON.stringify({ to: jid, text });
    const req = http.request({
      hostname: 'localhost', port: 3001, path: '/send-message',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(JSON.parse(data || '{}'));
        else reject(new Error(`send-message returned ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('send-message timeout')); });
    req.end(body);
  });
}
let voiceSend;
try {
  voiceSend = require('../lib/voice-client').sendMessage;
} catch (_) {
  console.warn('[Triage] lib/voice-client not found — using direct voice-server HTTP fallback');
  voiceSend = _httpVoiceSend;
}
const { traceCall } = require('./llm-trace');
const { findDuplicates } = require('./notice-dedup');

const GROUP_JID = process.env.MASTER_GROUP_JID; // set MASTER_GROUP_JID in .env
const BUDGET_MS = 80_000; // 80s wall-clock budget for synthesis phase
const SHADOW_MODE = process.env.TRIAGE_SHADOW !== 'false'; // default: shadow on
const SHADOW_LOG = path.join(__dirname, '..', 'data', 'triage-shadow-log.jsonl');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ISRAEL_TZ = 'Asia/Jerusalem';

// Health metrics for staleness counter (B3)
const healthFs = require('fs');
const HEALTH_METRICS_PATH = path.join(__dirname, '..', 'data', 'health-metrics.jsonl');
let _staleAtSendCount = 0;
function emitStaleMetric(noticeId, deadline, now) {
  _staleAtSendCount++;
  const row = { ts: now, check: 'stale_at_send', ok: false, notice_id: noticeId, deadline: deadline.toISOString(), stale_at_send_total: _staleAtSendCount };
  try {
    healthFs.mkdirSync(path.dirname(HEALTH_METRICS_PATH), { recursive: true });
    healthFs.appendFileSync(HEALTH_METRICS_PATH, JSON.stringify(row) + '\n');
  } catch (_) {}
}

// ── Schema validation (P-007) ─────────────────────────────────────────────────
const Ajv = require('ajv');
const _ajv = new Ajv();
const _classificationSchema = {
  type: 'object',
  required: ['decisions'],
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['notice_id', 'action', 'reason'],
        properties: {
          notice_id: { type: 'number' },
          action: { enum: ['send_now', 'defer', 'skip', 'send_update'] },
          merge_group: { type: ['string', 'null'] },
          reason: { type: 'string' },
          material_change: { type: 'boolean' },
          // Phase 2.1: optional per-decision confidence (0.0-1.0). Absent = treated as high-confidence.
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        }
      }
    }
  }
};
const _validateClassification = _ajv.compile(_classificationSchema);

// Normalize LLM decisions: auto-generate merge_group fallback for send_now with null (P-007)
function normalizeDecisions(decisions, noticesById) {
  const normalized = [];
  for (const d of decisions) {
    if (!Number.isInteger(d.notice_id) || !noticesById[d.notice_id]) {
      console.error(`[Triage] Rejected decision with invalid notice_id: ${JSON.stringify(d)}`);
      continue;
    }
    if ((d.action === 'send_now' || d.action === 'send_update') && !d.merge_group) {
      console.warn(`[Triage] Auto-generated merge_group for #${d.notice_id} (LLM returned null merge_group)`);
      d.merge_group = `auto-${d.notice_id}`;
    }
    normalized.push(d);
  }
  return normalized;
}

// ── Anthropic API ────────────────────────────────────────────────────────────

function callHaiku(system, user, jsonMode = false, temperature = 1) {
  return new Promise((resolve, reject) => {
    const bodyObj = {
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: user }],
    };
    if (temperature !== 1) bodyObj.temperature = temperature;
    const body = JSON.stringify(bodyObj);

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          const text = r.content?.[0]?.text;
          if (!text) return reject(new Error('Empty Haiku response: ' + data.substring(0, 200)));
          resolve(text.trim());
        } catch (e) { reject(new Error('Haiku parse error: ' + e.message)); }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Haiku timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Sonnet variant for low-confidence escalation (Phase 2.1). Mirrors callHaiku but
// uses the stronger model and returns token usage so escalations can be traced.
// Resolves to { text, inputTokens, outputTokens } (callHaiku resolves to a bare string).
function callSonnet(system, user, temperature = 0) {
  return new Promise((resolve, reject) => {
    const bodyObj = {
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: user }],
    };
    if (temperature !== 1) bodyObj.temperature = temperature;
    const body = JSON.stringify(bodyObj);

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          const text = r.content?.[0]?.text;
          if (!text) return reject(new Error('Empty Sonnet response: ' + data.substring(0, 200)));
          resolve({
            text: text.trim(),
            inputTokens: r.usage?.input_tokens,
            outputTokens: r.usage?.output_tokens,
          });
        } catch (e) { reject(new Error('Sonnet parse error: ' + e.message)); }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Sonnet timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Phase 2.3: Quiet hours ─────────────────────────────────────────────────────
// Returns true during 22:00–07:00 Israel time (nightly no-ping window).
// Uses hourCycle 'h23' so midnight reads as 0, never 24.
function isQuietHours(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ISRAEL_TZ, hour: 'numeric', hourCycle: 'h23',
  }).formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  return hour >= 22 || hour < 7;
}

// ── DB helpers ───────────────────────────────────────────────────────────────

function getPendingNotices(db) {
  // No created_at time-window filter — it caused notice limbo when triage timed out.
  // LIMIT 50 bounds worst-case runtime.
  // send_attempted_at guard: prevents two concurrent triage runs from double-processing.
  //   A notice claimed <5 min ago is considered in-flight by another instance.
  // B3: Staleness filtering moved to JS with proper Israel TZ conversion.
  //   The old SQL `date('now','-1 day')` fudge kept all of yesterday eligible
  //   regardless of actual time in Israel. Now we compute today's date in
  //   Asia/Jerusalem and filter in JS after the query.
  // P-001: triage is the SOLE actor on this queue.
  const rows = db.prepare(`
    SELECT id, group_name, content, urgency_hint, urgency_source,
           relevance_date, relevance_time, relevant_datetime, created_at
    FROM notices
    WHERE dismissed = 0
      AND posted_to_master = 0
      AND triage_decision IS NULL
      AND (send_attempted_at IS NULL OR send_attempted_at < datetime('now', '-5 minutes'))
      AND (thread_key IS NULL OR thread_key NOT IN (
        SELECT thread_key FROM notice_threads WHERE dismissed = 1
      ))
    ORDER BY created_at ASC
    LIMIT 50
  `).all();

  // B3: Filter stale notices using Israel timezone, not UTC.
  // A notice is stale if its deadline (computed from relevance fields) has passed.
  // NULL relevance_date = undated/evergreen notice, always included.
  const now = new Date();
  return rows.filter(n => {
    if (!n.relevance_date) return true; // undated/evergreen
    const deadline = computeDeadline(n, now);
    return deadline > now;
  });
}

/**
 * B3: Compute the absolute deadline (Date) for a notice, after which it's stale.
 *
 * Priority:
 *   1. relevant_datetime (epoch ms or ISO string) — use directly
 *   2. relevance_date + relevance_time — combine in Israel TZ
 *   3. relevance_date only — end-of-day (23:59:59) in Israel TZ
 *   4. No date fields — returns far-future (never stale)
 */
function computeDeadline(notice, now = new Date()) {
  // 1. relevant_datetime — most precise
  if (notice.relevant_datetime) {
    const dt = typeof notice.relevant_datetime === 'number'
      ? new Date(notice.relevant_datetime)
      : new Date(notice.relevant_datetime);
    if (!isNaN(dt.getTime())) return dt;
  }

  // 2 & 3. relevance_date (YYYY-MM-DD string)
  if (notice.relevance_date) {
    const dateStr = notice.relevance_date; // e.g. '2026-08-31'
    let timeStr = '23:59:59'; // default: end-of-day
    if (notice.relevance_time) {
      // relevance_time is 'HH:MM' or 'HH:MM:SS'
      timeStr = notice.relevance_time.length <= 5
        ? notice.relevance_time + ':00'
        : notice.relevance_time;
    }
    // Build a date string that we interpret in Israel timezone.
    // Intl trick: format now in Israel to get the UTC offset, then parse.
    const isoInIsrael = `${dateStr}T${timeStr}`;
    const deadline = israelDateToUTC(isoInIsrael);
    if (deadline && !isNaN(deadline.getTime())) return deadline;
  }

  // 4. No date → never stale
  return new Date(now.getTime() + 365 * 24 * 3600000);
}

/**
 * Convert a 'YYYY-MM-DDTHH:MM:SS' string (interpreted in Asia/Jerusalem) to a UTC Date.
 */
function israelDateToUTC(isoLocal) {
  // Use a two-pass approach: parse as UTC, then adjust by the Israel offset at that time.
  // This handles DST correctly.
  const naive = new Date(isoLocal + 'Z'); // treat as UTC first
  if (isNaN(naive.getTime())) return null;

  // Get the Israel offset at this approximate time
  // Format the naive UTC time in Israel TZ and compare
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: ISRAEL_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(naive);
  const get = (type) => parts.find(p => p.type === type)?.value || '00';
  const israelStr = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`;
  const israelAsUTC = new Date(israelStr);
  // offset = israelAsUTC - naive = how far ahead Israel is from UTC
  const offsetMs = israelAsUTC.getTime() - naive.getTime();
  // The actual UTC time = naive - offset (we want earlier if Israel is ahead)
  return new Date(naive.getTime() - offsetMs);
}

function getSentRecent(db) {
  // 72h lookback (not just today's midnight) — prevents cross-day re-send of
  // the same real-world event discussed across multiple days.
  const cutoff = Date.now() - 72 * 3600000;
  return db.prepare(`
    SELECT topic_key, sent_at, message_text, source_notice_ids, group_name
    FROM sent_messages
    WHERE sent_at >= ?
    ORDER BY sent_at ASC
  `).all(cutoff);
}

function markNoticesTriaged(db, decisions) {
  const stmt = db.prepare(`
    UPDATE notices SET triage_decision=?, triage_reason=?, triaged_at=?
    WHERE id=?
  `);
  const now = Date.now();
  for (const d of decisions) {
    stmt.run(d.action, d.reason, now, d.notice_id);
  }
}

// D1: msgId is the serialized whatsapp-web.js id returned by the sender
// (true_<jid>_<stanzaId>[_participant]); we store both the full id and the parsed
// stanza id so a later family reaction maps back to source_notice_ids. When the
// sender doesn't surface an id, both stay null and reaction feedback degrades
// gracefully (the send still records normally).
function stanzaIdFromMsgId(msgId) {
  if (!msgId) return null;
  const parts = String(msgId).split('_');
  return parts.length >= 3 ? parts[2] : null;
}

function saveSentMessage(db, topicKey, text, noticeIds, groupName = null, msgId = null) {
  db.prepare(`
    INSERT INTO sent_messages (topic_key, sent_at, message_text, source_notice_ids, group_name, stanza_id, msg_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(topicKey, Date.now(), text, JSON.stringify(noticeIds), groupName, stanzaIdFromMsgId(msgId), msgId || null);
}

function markNoticesSent(db, noticeIds) {
  const placeholders = noticeIds.map(() => '?').join(',');
  db.prepare(`UPDATE notices SET posted_to_master=1, sent_to_master=1,
    delivery_status='delivered_immediate', delivered_at=?
    WHERE id IN (${placeholders})`).run(Date.now(), ...noticeIds);
}

// ── Bucketing ─────────────────────────────────────────────────────────────────

function bucketByGroupAndDate(notices) {
  const map = new Map();
  for (const n of notices) {
    const date = n.relevance_date || new Date(n.created_at + 3 * 3600000).toISOString().slice(0, 10);
    const key = `${n.group_name}|||${date}`;
    if (!map.has(key)) map.set(key, { group_name: n.group_name, date, notices: [] });
    map.get(key).notices.push(n);
  }
  return Array.from(map.values());
}

function groupByMergeGroup(decisions, noticesById) {
  const groups = {};
  for (const d of decisions) {
    if (d.action !== 'send_now' && d.action !== 'send_update') continue;
    if (!d.merge_group) {
      console.error(`[Triage] BUG: send_now/send_update without merge_group after normalization: #${d.notice_id}`);
      continue;
    }
    if (!groups[d.merge_group]) groups[d.merge_group] = { notices: [], action: d.action };
    const n = noticesById[d.notice_id];
    if (n) groups[d.merge_group].notices.push(n);
    if (d.action === 'send_update') groups[d.merge_group].action = 'send_update';
  }
  return groups;
}

// ── Classification prompt ─────────────────────────────────────────────────────

// Lazy — evaluated at first call so DB is guaranteed to be initialized
let _classificationSystem = null;
function getClassificationSystem() {
  if (!_classificationSystem) {
    _classificationSystem = `אתה מערכת הניהול של עוזר משפחתי חכם (${config.BOT_NAME}).
בני המשפחה: ${getFamilyContext()}
לכל החלטה הוסף שדה "confidence" — מספר בין 0.0 ל-1.0 שמבטא כמה אתה בטוח בהחלטה.
השתמש בערך גבוה (0.85 ומעלה) כשההחלטה ברורה, ובערך נמוך (מתחת ל-0.6) כשאתה מתלבט או המידע חלקי.`;
  }
  return _classificationSystem;
}
const CLASSIFICATION_SYSTEM = `אתה מערכת הניהול של עוזר משפחתי חכם.
בני המשפחה: טוען בזמן ריצה.
אתה מחליט אילו הודעות שווה לשלוח לקבוצת המשימות עכשיו, מה ניתן לדחות לסיכום הבוקר, ומה כדאי לדלג עליו לחלוטין.

החזר JSON בלבד, ללא הסבר, לפי הסכימה הבאה:
{"decisions":[{"notice_id":NUMBER,"action":"send_now"|"defer"|"skip"|"send_update","merge_group":STRING_OR_NULL,"reason":"SHORT_ENGLISH_REASON","material_change":true|false,"confidence":0.0-1.0}]}

confidence: מספר בין 0.0 ל-1.0 שמבטא כמה אתה בטוח בהחלטה. נמוך מ-0.6 = לא בטוח.

material_change:
- true: new date, price change, registration deadline, decision reached, urgent action added
- false: follow-up to same ongoing discussion, no new actionable info (more parents joining a discussion, survey still pending, same info repeated)

כללים:
- send_now: הודעה שמשפחה צריכה לפעול לפיה היום או מחר (תשלום, אישור, הבאת ציוד, הרשמה דחופה)
- send_update: עדכון משמעותי לאירוע שכבר נשלח היום (משתתף חדש, שינוי שעה)
- defer: הודעה שעשויה להיות שימושית אבל לא דחופה — תיכנס לסיכום הבוקר
- skip: שיחה, תמונות, הגיות, עדכון סטטוס ללא פעולה, בנייה/חפירות
- merge_group: מפתח קצר בפורמט kebab-case (לדוגמה: "movie-kupa-17jun"). שתי הודעות יקבלו SAME merge_group אם הן על אותו נושא כללי (למשל: תיאום סרט לכיתה, גם אם השעות/מחירים שונים — הכל חלק מאותו דיון). הפרד רק אם זה בבירור עניין שונה לגמרי.
CRITICAL: כאשר action הוא "send_now" או "send_update", השדה merge_group חייב להיות מחרוזת kebab-case לא ריקה. אסור להחזיר merge_group: null עבור send_now / send_update. אם אין נושא ברור, השתמש ב-"misc-NOTICE_ID" (החלף NOTICE_ID במספר ה-notice).`;

const FEW_SHOT_EXAMPLES = `
<examples>

<example id="1" description="Merge: same event, multiple notices">
<sent_today></sent_today>
<bucket group="כתה ו׳ רשפים" date="2026-06-17">
<notice id="504">סרט היום עם ליבי ואורי — CHILD מצטרף. מצטרפים גם: אלון, עידן, גולן. עוד 5 מקומות פנויים.</notice>
<notice id="505">סרט בקופה ראשית בעפולה היום בשעה 17:00. CHILD רוצה להצטרף. חובה להזמין כרטיסים מראש: 14.5 ₪. מצטרפים: אלון, CHILD, עידן וגולן.</notice>
<notice id="506">סרט קופה ראשית בעפולה היום 17:05. אורי וליבי נוסעים, יש עוד מקום. כרטיס: 14.5 שח. צריך להזמין מראש.</notice>
</bucket>
<output>{"decisions":[{"notice_id":504,"action":"send_now","merge_group":"movie-kupa-17jun","reason":"event today 17:05, action required","confidence":0.95},{"notice_id":505,"action":"send_now","merge_group":"movie-kupa-17jun","reason":"same movie, adds ticket detail","confidence":0.92},{"notice_id":506,"action":"send_now","merge_group":"movie-kupa-17jun","reason":"same movie, confirms spot","confidence":0.9}]}</output>
</example>

<example id="2" description="Skip: parent coordination noise — gift collections, planner orders, class funds">
<sent_today></sent_today>
<bucket group="הורי ו' בני" date="2026-06-17">
<notice id="510">דיון: מתנה לסייעת של CHILD — עציץ או מגנט עם תמונה, כ-400 שח. שרית תערוך סקר.</notice>
<notice id="488">הזמנת יומנים/מחברות דרך פטיש בית שאן — צריך לאשר עד מחר, מחיר להבהיר. מתעניינים להירשם.</notice>
</bucket>
<output>{"decisions":[{"notice_id":510,"action":"skip","merge_group":null,"reason":"parent group coordination about teacher gift — not family-actionable, social noise","material_change":false,"confidence":0.88},{"notice_id":488,"action":"skip","merge_group":null,"reason":"parent planner order coordination — school admin noise, not family logistics","material_change":false,"confidence":0.82}]}</output>
</example>

<example id="3" description="Skip: chit-chat, photos, videos — no action needed">
<sent_today></sent_today>
<bucket group="ג׳3 תשפ״ו" date="2026-06-16">
<notice id="501">דיקלה שלחה וידאו מ-Scoompa Video. ללא מידע נוסף על תוכן או פעולה נדרשת.</notice>
<notice id="502">[תמונה: ארבע תלמידות בכיתה עומדות ליד שולחן עם חטיפים ואוכל — ביסלי, ממתקים]</notice>
<notice id="503">[תמונה: שלושה ילדים בחולצות אדומות ליד שולחן עם משקאות]</notice>
</bucket>
<output>{"decisions":[{"notice_id":501,"action":"skip","merge_group":null,"reason":"generic video, no action","confidence":0.9},{"notice_id":502,"action":"skip","merge_group":null,"reason":"class party photo, no action","confidence":0.95},{"notice_id":503,"action":"skip","merge_group":null,"reason":"class photo, no action","confidence":0.95}]}</output>
</example>

<example id="4" description="Defer: future event, not urgent today">
<sent_today></sent_today>
<bucket group="הורי גן כוכב" date="2026-07-01">
<notice id="901">פעילויות קייטנת קיץ — הרשמה פתוחה. מועד תחילה: 1 יולי. ניתן להירשם עד 28.6. אין דחיפות היום.</notice>
</bucket>
<output>{"decisions":[{"notice_id":901,"action":"defer","merge_group":null,"reason":"summer camp July, deadline June 28 — not urgent today","confidence":0.8}]}</output>
</example>

<example id="5" description="send_update: new meaningful info about event already sent today">
<sent_today>
<message topic="movie-kupa-17jun" sent_at="14:02">🎬 סרט קופה ראשית בעפולה 17:05 — CHILD, אלון, עידן, גולן מצטרפים. כרטיס 14.5 שח, להזמין מראש.</message>
</sent_today>
<bucket group="כתה ו׳ רשפים" date="2026-06-17">
<notice id="507">בקשה: אריאל רוצה להצטרף לסרט קופה ראשית בעפולה היום ב-17:05. יש מקום אחד פנוי. צריך להזמין כרטיס.</notice>
</bucket>
<output>{"decisions":[{"notice_id":507,"action":"send_update","merge_group":"movie-kupa-17jun","reason":"new participant, one spot left — meaningful update to already-sent event","confidence":0.85}]}</output>
</example>

<example id="6" description="Skip: newsletter / weekly bulletin — informational, no family action">
<sent_today></sent_today>
<bucket group="הורי גן כוכב" date="2026-07-16">
<notice id="601">ניוזלטר שבועי: השבוע התנסינו בפעילות יצירה — מדבקות, ציור, ציפורניים. הילדים נהנו מאוד. שבוע הבא נמשיך עם אותו פורמט. תודה על השתתפותכם.</notice>
<notice id="602">תמונות מפעילות מסיבת תחפושות — שיתפנו גם סרטון. ילדים נהדרים!</notice>
</bucket>
<output>{"decisions":[{"notice_id":601,"action":"skip","merge_group":null,"reason":"weekly newsletter, no actionable item — event recap only, no payment, deadline, or family action needed","material_change":false,"confidence":0.92},{"notice_id":602,"action":"skip","merge_group":null,"reason":"image/video dump from past event — no action required","material_change":false,"confidence":0.9}]}</output>
</example>

<example id="7" description="Skip: photo/video dump from completed past event">
<sent_today></sent_today>
<bucket group="ג׳3 תשפ״ו" date="2026-07-16">
<notice id="701">[תמונה: ילדות לבושות בתחפושות נסיכות בגן — קבוצת תמונות מיום הולדת]</notice>
<notice id="702">[תמונה: שולחן עם חטיפים וממתקים, ילדים סביבו — ללא טקסט]</notice>
<notice id="703">[תמונה: ציור אצבעות, ילדות יוצרות — ללא מידע על מועד או פעולה]</notice>
<notice id="704">וידאו מהאירוע שהסתיים. ללא מועדים, תשלומים, אנשי קשר.</notice>
</bucket>
<output>{"decisions":[{"notice_id":701,"action":"skip","merge_group":null,"reason":"photo dump from completed event, no action","material_change":false,"confidence":0.95},{"notice_id":702,"action":"skip","merge_group":null,"reason":"photo dump, no action","material_change":false,"confidence":0.95},{"notice_id":703,"action":"skip","merge_group":null,"reason":"photo dump, no action","material_change":false,"confidence":0.95},{"notice_id":704,"action":"skip","merge_group":null,"reason":"event video recap, no action","material_change":false,"confidence":0.92}]}</output>
</example>

</examples>`;

function buildClassificationPrompt(bucket, sentToday) {
  const sentXml = sentToday.length > 0
    ? sentToday.map(s => `<message topic="${s.topic_key}" sent_at="${new Date(s.sent_at).toLocaleTimeString('he-IL', { timeZone: ISRAEL_TZ, hour: '2-digit', minute: '2-digit' })}">${s.message_text.substring(0, 200)}</message>`).join('\n')
    : '';

  const noticesXml = bucket.notices.map(n =>
    `<notice id="${n.id}">${n.content}</notice>`
  ).join('\n');

  return `${FEW_SHOT_EXAMPLES}

<sent_today>
${sentXml}
</sent_today>

<bucket group="${bucket.group_name}" date="${bucket.date}">
${noticesXml}
</bucket>

החזר JSON בלבד:`;
}

// ── Phase 2.1: Pre-LLM deterministic rules ──────────────────────────────────────
// Cheap, high-precision rules applied BEFORE the Haiku call. A matched notice
// skips the LLM entirely (saves tokens). Returns a decision-like object
// {action, reason, confidence, source:'rules'} or null if no rule matched.

// Date keywords meaning "today / this evening / tomorrow"
const RULE_DATE_KEYWORDS = ['היום', 'מחר', 'הערב'];
// Actionable verbs/nouns that imply the family must do something soon
const RULE_ACTION_VERBS = ['תשלום', 'הבאת', 'הרשמה', 'חובה', 'אישור'];
// Newsletter / recap markers — informational only, never family-actionable
const RULE_NEWSLETTER_PATTERNS = ['ניוזלטר', 'סיכום שבועי', 'תמונות מ'];
// Pure media reference with no descriptive prose (kept conservative on purpose:
// described media like "[תמונה: טופס הרשמה עד מחר]" is left for the LLM so we
// never auto-skip an actionable image).
const RULE_PURE_MEDIA = /^\s*\[?\s*(תמונה|וידאו|סרטון|גיף|מדבקה|מדיה|image|video|gif|sticker)\s*\]?\s*$/i;

function preTriageRules(notice) {
  const content = (notice.content || '').trim();
  if (!content) {
    // Empty content = nothing to act on
    return { action: 'skip', reason: 'empty content', confidence: 1.0, source: 'rules' };
  }

  // Rule 1: today/tomorrow + actionable verb → send_now
  const hasDate = RULE_DATE_KEYWORDS.some(k => content.includes(k));
  const hasVerb = RULE_ACTION_VERBS.some(v => content.includes(v));
  if (hasDate && hasVerb) {
    return { action: 'send_now', reason: 'rule: date keyword + actionable verb', confidence: 1.0, source: 'rules' };
  }

  // Rule 2: pure media reference with no text → skip
  if (RULE_PURE_MEDIA.test(content)) {
    return { action: 'skip', reason: 'rule: media reference with no text', confidence: 1.0, source: 'rules' };
  }

  // Rule 3: newsletter / weekly recap → skip
  if (RULE_NEWSLETTER_PATTERNS.some(p => content.includes(p))) {
    return { action: 'skip', reason: 'rule: newsletter/recap pattern', confidence: 1.0, source: 'rules' };
  }

  return null;
}

// ── Phase 2.1: Sonnet escalation for low-confidence decisions ────────────────────
// Re-classify only the low-confidence send_now/defer notices with the stronger
// model. Abstention: if Sonnet is still uncertain (<0.5), default to 'defer'
// (safe — the notice goes to the morning digest, never dropped).
const ESCALATION_THRESHOLD = 0.6; // below this → escalate to Sonnet
const ABSTENTION_THRESHOLD = 0.5; // below this even after Sonnet → defer

async function escalateLowConfidence(decisions, bucket, sentToday) {
  const lowConf = decisions.filter(d =>
    typeof d.confidence === 'number' &&
    d.confidence < ESCALATION_THRESHOLD &&
    (d.action === 'send_now' || d.action === 'defer') // skip at low confidence is fine to keep
  );
  if (lowConf.length === 0) return decisions;

  const lowIds = new Set(lowConf.map(d => d.notice_id));
  const escalateNotices = bucket.notices.filter(n => lowIds.has(n.id));
  if (escalateNotices.length === 0) return decisions;

  console.log(`[Triage] Escalating ${escalateNotices.length} low-confidence decision(s) to Sonnet in ${bucket.group_name}: ${[...lowIds].map(id => '#' + id).join(', ')}`);

  const escBucket = { ...bucket, notices: escalateNotices };
  const prompt = buildClassificationPrompt(escBucket, sentToday);
  const startMs = Date.now();
  let sonnetById = {};
  try {
    const res = await callSonnet(getClassificationSystem(), prompt, 0);
    traceCall({
      model: 'claude-sonnet-4-5',
      callSite: 'triage.escalate',
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      durationMs: Date.now() - startMs,
      success: true,
    });
    const jsonMatch = res.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (_validateClassification(parsed)) {
        for (const d of parsed.decisions) sonnetById[d.notice_id] = d;
      } else {
        console.warn('[Triage] Sonnet escalation returned schema-invalid JSON — keeping Haiku decisions');
      }
    }
  } catch (e) {
    traceCall({
      model: 'claude-sonnet-4-5',
      callSite: 'triage.escalate',
      durationMs: Date.now() - startMs,
      success: false,
      error: e.message,
    });
    console.error(`[Triage] Sonnet escalation failed for ${bucket.group_name}:`, e.message);
    // Fall through — keep Haiku decisions, abstention below still applies as a safety net
  }

  return decisions.map(d => {
    if (!lowIds.has(d.notice_id)) return d;
    const s = sonnetById[d.notice_id];
    const resolved = s ? { ...s, source: 'sonnet' } : d;

    // Abstention: even the stronger model is uncertain → default to defer (safe)
    if ((resolved.action === 'send_now' || resolved.action === 'defer') &&
        typeof resolved.confidence === 'number' && resolved.confidence < ABSTENTION_THRESHOLD) {
      console.log(`[Triage] Abstention: #${resolved.notice_id} still uncertain (confidence ${resolved.confidence}) — defaulting to defer`);
      return {
        ...resolved,
        action: 'defer',
        reason: (resolved.reason || 'uncertain') + ' [abstention: low confidence → defer]',
        source: 'abstention',
      };
    }
    return resolved;
  });
}

async function classifyBucket(bucket, sentToday) {
  // ── Pre-LLM deterministic rules: matched notices skip the LLM entirely ──
  const ruleDecisions = [];
  let llmNotices = [];
  for (const n of bucket.notices) {
    const rule = preTriageRules(n);
    if (rule) {
      ruleDecisions.push({
        notice_id: n.id,
        action: rule.action,
        reason: rule.reason,
        confidence: rule.confidence,
        merge_group: null,
        source: rule.source,
      });
    } else {
      llmNotices.push(n);
    }
  }
  if (ruleDecisions.length > 0) {
    console.log(`[Triage] ${bucket.group_name}: ${ruleDecisions.length} notice(s) matched pre-LLM rules (${ruleDecisions.map(d => `#${d.notice_id}→${d.action}`).join(', ')})`);
  }

  // ── Phase 2.2: semantic dedup — near-duplicate notices skip the LLM ──
  // Runs AFTER preTriageRules (so rule-handled notices are already out) but
  // BEFORE the LLM call. A duplicate is auto-classified as 'skip' pointing at
  // the earlier notice it repeats, saving both a token and a redundant message.
  const dedupDecisions = [];
  if (llmNotices.length > 1) {
    const dupMap = findDuplicates(llmNotices);
    if (dupMap.size > 0) {
      const remaining = [];
      for (const n of llmNotices) {
        const dup = dupMap.get(n.id);
        if (dup && dup.isDuplicate) {
          dedupDecisions.push({
            notice_id: n.id,
            action: 'skip',
            reason: `semantic dedup: similar to #${dup.originalId} (sim ${dup.similarity.toFixed(2)})`,
            confidence: 1.0,
            merge_group: null,
            source: 'dedup',
          });
        } else {
          remaining.push(n);
        }
      }
      llmNotices = remaining;
      console.log(`[Triage] ${bucket.group_name}: ${dedupDecisions.length} notice(s) deduped (${dedupDecisions.map(d => `#${d.notice_id}`).join(', ')})`);
    }
  }

  // All notices handled by rules + dedup → no LLM call needed
  if (llmNotices.length === 0) return [...ruleDecisions, ...dedupDecisions];

  const llmBucket = { ...bucket, notices: llmNotices };
  console.time(`classify:${bucket.group_name}`);
  const prompt = buildClassificationPrompt(llmBucket, sentToday);
  let raw;
  try {
    raw = await callHaiku(getClassificationSystem(), prompt, false, 0); // temperature=0: deterministic classification
  } finally {
    console.timeEnd(`classify:${bucket.group_name}`);
  }

  // Extract JSON (model may wrap in ```json ... ```)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in classification response: ' + raw.substring(0, 200));

  const parsed = JSON.parse(jsonMatch[0]);
  // P-007: Validate against explicit schema before returning (Ajv, defined at top of file)
  if (!_validateClassification(parsed)) {
    throw new Error('Classification schema validation failed: ' + JSON.stringify(_validateClassification.errors));
  }

  // ── Phase 2.1: escalate low-confidence send_now/defer decisions to Sonnet ──
  const llmDecisions = await escalateLowConfidence(parsed.decisions, llmBucket, sentToday);

  return [...ruleDecisions, ...dedupDecisions, ...llmDecisions];
}

// ── Synthesis prompt ──────────────────────────────────────────────────────────

const SYNTHESIS_SYSTEM = `אתה כותב הודעות לקבוצת WhatsApp משפחתית בעברית.
כתוב הודעה אחת תמציתית וברורה.
כלול את כל פרטי הפעולה — שעות, מחירים, קישורים, מועדים.
אסור להשמיט פרט שדורש פעולה.
פלוט רק את ההודעה, ללא כותרות או הסברים.
העצה: השתמש ב-*טקסט* לדגש (WhatsApp bold) ולא ב-**טקסט**. אין להוסיף # כותרות.`;

async function synthesizeMessage(notices, alreadySent) {
  const isUpdate = !!alreadySent;
  const noticesText = notices.map((n, i) => `${i + 1}. [${n.group_name}] ${n.content}`).join('\n');

  let user;
  if (isUpdate) {
    user = `כבר נשלח היום על הנושא הזה:
"${alreadySent.message_text}"

עדכון חדש:
${noticesText}

כתוב הודעת עדכון קצרה שמתחילה ב"עדכון: " ומוסיפה רק את המידע החדש.`;
  } else {
    user = `כתוב הודעה אחת המסכמת את כל העדכונים הבאים:
${noticesText}`;
  }

  console.time('synthesize');
  try {
    return await callHaiku(SYNTHESIS_SYSTEM, user, false, 0.3);
  } finally {
    console.timeEnd('synthesize');
  }
}

// ── Shadow log ────────────────────────────────────────────────────────────────

function shadowLog(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(SHADOW_LOG, line);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runTriage() {
  initDB();
  const db = getDB();

  console.time('total');
  console.log(`[Triage] Starting${SHADOW_MODE ? ' (SHADOW MODE)' : ''}`);

  // 1. Get pending notices
  console.time('query');
  const pending = getPendingNotices(db);
  console.timeEnd('query');

  if (pending.length === 0) {
    console.log('[Triage] Nothing pending. Done.');
    console.timeEnd('total');
    return;
  }
  console.log(`[Triage] ${pending.length} pending notice(s)`);

  // Claim all pending notices upfront (P-001 / P-002):
  // Set send_attempted_at so a concurrent triage instance skips them.
  // Must happen BEFORE any LLM call to close the race window.
  {
    const ph = pending.map(() => '?').join(',');
    db.prepare(`UPDATE notices SET send_attempted_at = datetime('now') WHERE id IN (${ph})`)
      .run(...pending.map(n => n.id));
  }

  // 2. Get recently sent messages for context (72h window — prevents cross-day re-send)
  const sentToday = getSentRecent(db);
  console.log(`[Triage] ${sentToday.length} sent in last 72h`);

  // Daily group cap: track how many messages sent per source group since Israel midnight
  const GROUP_DAILY_CAP = 3;
  const israelMidnight = (() => {
    const now = new Date(Date.now() + 3 * 3600000);
    now.setUTCHours(0, 0, 0, 0);
    return now.getTime() - 3 * 3600000;
  })();

  // Load active dismissals
  const { getActiveDismissals, isTopicDismissed } = require('./dismissal');
  const activeDismissals = getActiveDismissals();
  if (activeDismissals.length > 0) {
    console.log(`[Triage] ${activeDismissals.length} active dismissal(s)`);
  }

  // Track sent-per-group today (populated as we send during this run)
  const groupSentToday = {};

  // 3. Handle immediate bypass (urgency='immediate') — skip batching, send now
  // NOTE: immediates now check dismissals and recent sent context (no more blind bypass)
  const immediates = pending.filter(n => n.urgency_hint === 'immediate');
  const normal = pending.filter(n => n.urgency_hint !== 'immediate');

  for (const n of immediates) {
    // B4: quiet-hours hole. Immediates send here, BEFORE the quiet-hours check
    // that gates the normal path (~line 920). Keyword/date-signal immediates are
    // not truly time-critical at 3am — only datetime-grounded ones (event ≤3h)
    // justify a night ping. Demote the rest to normal triage so quiet hours
    // defers them to the morning digest.
    if (isQuietHours() && n.urgency_source !== 'datetime') {
      console.log(`[Triage] Immediate #${n.id} (source=${n.urgency_source || 'unknown'}) demoted to normal — quiet hours, non-datetime`);
      normal.push(n);
      continue;
    }
    // Check dismissal — for immediates, topic_key is not stored, so also check
    // content-based keyword matching against topic_key scope_values.
    const immediateContentDismissed = activeDismissals.some(d => {
      if (d.scope_type === 'all') return true;
      if (d.scope_type === 'source_group' && n.group_name && d.scope_value) {
        return n.group_name.includes(d.scope_value) || d.scope_value.includes(n.group_name);
      }
      if (d.scope_type === 'topic_key' && d.scope_value && n.content) {
        // Check if any word from the topic_key slug appears in the notice content
        const keywords = d.scope_value.toLowerCase().split('-').filter(w => w.length > 3);
        const contentLower = n.content.toLowerCase();
        return keywords.some(kw => contentLower.includes(kw));
      }
      return false;
    });
    if (immediateContentDismissed) {
      console.log(`[Triage] Immediate #${n.id} suppressed by active dismissal (content match)`);
      db.prepare(`UPDATE notices SET triage_decision='skip', triage_reason='dismissed by user', triaged_at=?, delivery_status='skipped' WHERE id=?`)
        .run(Date.now(), n.id);
      continue;
    }
    // Cross-day dedup: if this group was already sent recently, demote to normal triage.
    // B2: match on the dedicated group_name column, not an 8-char message-text
    // substring — Hebrew class-group names share long prefixes, so substring
    // matching cross-suppressed unrelated groups.
    const alreadySentForGroup = n.group_name
      ? sentToday.find(s => s.group_name && s.group_name === n.group_name)
      : null;
    if (alreadySentForGroup && n.urgency_hint !== 'critical') {
      // Demote to normal triage so it gets proper dedup with sentToday context
      normal.push(n);
      continue;
    }

    const text = `‏⚡ *${n.group_name}:*\n${n.content}${n.relevance_time ? '\n⏰ ' + n.relevance_time : ''}`;
    if (SHADOW_MODE) {
      console.log(`[Triage] SHADOW immediate: "${text.substring(0, 80)}"`);
      shadowLog({ type: 'immediate', notice_id: n.id, text });
    } else {
      try {
        const sent = await voiceSend(GROUP_JID, text);
        markNoticesSent(db, [n.id]);
        saveSentMessage(db, `immediate-${n.id}`, text, [n.id], n.group_name, sent && sent.msgId);
        console.log(`[Triage] Sent immediate #${n.id}`);
      } catch (e) {
        console.error(`[Triage] Failed immediate #${n.id}:`, e.message);
      }
    }
  }

  // 4. Bucket normal notices by (group, date)
  const buckets = bucketByGroupAndDate(normal);
  console.log(`[Triage] ${buckets.length} bucket(s) to process`);

  // ── Classify ALL buckets in parallel (~30s regardless of bucket count) ──────
  const START_MS = Date.now();
  console.time('classify-all');
  const classifyResults = await Promise.allSettled(
    buckets.map(bucket => classifyBucket(bucket, sentToday))
  );
  console.timeEnd('classify-all');

  // Collect all successful decisions
  const allDecisions = [];
  const noticesById = {};
  for (let i = 0; i < buckets.length; i++) {
    const result = classifyResults[i];
    if (result.status === 'fulfilled') {
      const decisions = result.value;
      console.log(`[Triage] ${buckets[i].group_name}: ${decisions.map(d => `#${d.notice_id}→${d.action}`).join(', ')}`);
      allDecisions.push(...decisions);
    } else {
      console.error(`[Triage] Classification failed for ${buckets[i].group_name}:`, result.reason?.message);
    }
    for (const n of buckets[i].notices) noticesById[n.id] = n;
  }

  // ── Thread continuity: downgrade send_now→skip if thread already delivered + no material change ──
  for (const d of allDecisions) {
    if (d.action !== 'send_now' && d.action !== 'send_update') continue;
    const n = noticesById[d.notice_id];
    if (!n || !n.thread_key) continue;
    try {
      const thread = db.prepare('SELECT last_delivered_at FROM notice_threads WHERE thread_key = ?').get(n.thread_key);
      if (thread && thread.last_delivered_at && d.material_change === false) {
        const hoursSince = (Date.now() - thread.last_delivered_at) / 3600000;
        if (hoursSince < 72) {
          console.log(`[Triage] Thread "${n.thread_key}" already delivered ${hoursSince.toFixed(1)}h ago, no material change — skipping #${d.notice_id}`);
          d.action = 'skip';
          d.reason = 'thread already delivered, no material change';
        }
      }
    } catch (e) {
      console.warn('[Triage] thread continuity check error:', e.message);
    }
  }

  // ── Phase 2.3: Quiet hours (22:00–07:00 Israel) — defer non-immediate send_now ──
  // During quiet hours we don't ping the family at night; send_now decisions are
  // demoted to defer so they land in the morning digest instead. Notices with
  // urgency_hint='immediate' are exempt — truly urgent, send regardless of hour.
  if (isQuietHours()) {
    let suppressed = 0;
    for (const d of allDecisions) {
      if (d.action !== 'send_now') continue;
      const n = noticesById[d.notice_id];
      if (n && n.urgency_hint === 'immediate') continue;
      d.action = 'defer';
      d.reason = (d.reason || '') + ' [quiet hours: send_now→defer]';
      suppressed++;
    }
    if (suppressed > 0) {
      console.log(`[Triage] Quiet hours (22:00–07:00 Israel) — deferred ${suppressed} send_now decision(s) to morning digest`);
    }
  }

  // ── Normalize decisions: auto-generate merge_group fallback for send_now with null (P-007) ──
  const normalizedDecisions = normalizeDecisions(allDecisions, noticesById);

  // ── Build merge groups BEFORE committing — validate state before persisting (P-007) ─────────
  const allMergeGroups = groupByMergeGroup(normalizedDecisions, noticesById);
  const mergeGroupEntries = Object.entries(allMergeGroups);
  console.log(`[Triage] ${mergeGroupEntries.length} merge group(s) to synthesize`);

  // ── Commit ALL decisions to DB NOW — after validation, before synthesis ─────────────
  // This ensures no notice is stuck in limbo if synthesis is interrupted.
  // Unsent send_now decisions will be reset to NULL if budget is exceeded.
  markNoticesTriaged(db, normalizedDecisions);

  // ── Synthesize + send (sequential — sentToday context must stay coherent) ──
  for (let mi = 0; mi < mergeGroupEntries.length; mi++) {
    const [topicKey, { notices: groupNotices, action }] = mergeGroupEntries[mi];

    // Wall-clock budget guard — if we're running long, reset remaining notices
    // so they're re-processed next run (parallel classify will be fast again)
    if (Date.now() - START_MS > BUDGET_MS) {
      const remainingIds = mergeGroupEntries
        .slice(mi)
        .flatMap(([, { notices }]) => notices.map(n => n.id));
      if (remainingIds.length > 0) {
        const ph = remainingIds.map(() => '?').join(',');
        db.prepare(`UPDATE notices SET triage_decision=NULL, triage_reason=NULL, triaged_at=NULL WHERE id IN (${ph})`).run(...remainingIds);
        console.warn(`[Triage] Budget exhausted — reset ${remainingIds.length} notice(s) to queue for next run`);
      }
      break;
    }

    const sourceGroup = groupNotices[0]?.group_name || '';

    // Check dismissal before synthesizing
    if (isTopicDismissed(activeDismissals, topicKey, sourceGroup)) {
      console.log(`[Triage] Skipping [${topicKey}] — dismissed by user`);
      const ids = groupNotices.map(n => n.id);
      const ph = ids.map(() => '?').join(',');
      db.prepare(`UPDATE notices SET triage_decision='skip', triage_reason='dismissed by user', triaged_at=?, posted_to_master=1, delivery_status='skipped' WHERE id IN (${ph})`).run(Date.now(), ...ids);
      continue;
    }

    // Daily group cap: max 3 distinct messages per source group per day.
    // B2: count via the group_name column (exact match), not an 8-char message-text
    // substring. Substring matching both over-fired (Hebrew groups sharing a long
    // prefix suppressed each other) and under-fired (synthesized messages that omit
    // the group name matched nothing).
    const groupSentCount = (groupSentToday[sourceGroup] || 0) +
      sentToday.filter(s => s.sent_at >= israelMidnight && s.group_name && s.group_name === sourceGroup).length;
    if (groupSentCount >= GROUP_DAILY_CAP) {
      console.log(`[Triage] Daily cap reached for "${sourceGroup}" (${groupSentCount}/${GROUP_DAILY_CAP}) — deferring [${topicKey}]`);
      // Mark as deferred so they appear in morning digest instead
      const ids = groupNotices.map(n => n.id);
      if (ids.length > 0) {
        const ph = ids.map(() => '?').join(',');
        db.prepare(`UPDATE notices SET triage_decision='defer', triage_reason='daily group cap reached', triaged_at=? WHERE id IN (${ph})`).run(Date.now(), ...ids);
      }
      continue;
    }

    const alreadySent = sentToday.find(s => s.topic_key === topicKey) || null;

    // ── B3: Send-time staleness gate ──────────────────────────────────────────
    // The query→send gap can be up to 80s of LLM latency. Re-check each notice
    // in this merge group right before sending. If ALL notices are stale, skip
    // the entire group. If only some are stale, remove them but still send.
    {
      const sendTimeNow = new Date();
      const staleIds = [];
      const freshNotices = [];
      for (const n of groupNotices) {
        const deadline = computeDeadline(n, sendTimeNow);
        if (deadline <= sendTimeNow) {
          staleIds.push(n.id);
          console.log(`[Triage] B3 stale at send time: #${n.id} (deadline ${deadline.toISOString()}, now ${sendTimeNow.toISOString()})`);
          emitStaleMetric(n.id, deadline, sendTimeNow.getTime());
          db.prepare(`UPDATE notices SET triage_decision='skip', triage_reason='stale at send time', delivery_status='skipped', posted_to_master=1 WHERE id=?`).run(n.id);
        } else {
          freshNotices.push(n);
        }
      }
      if (freshNotices.length === 0) {
        console.log(`[Triage] All notices in [${topicKey}] stale at send time — skipping`);
        continue;
      }
      if (staleIds.length > 0) {
        // Replace groupNotices with only the fresh ones for synthesis
        groupNotices.length = 0;
        groupNotices.push(...freshNotices);
      }
    }

    let message;
    try {
      message = await synthesizeMessage(groupNotices, alreadySent);
    } catch (e) {
      console.error(`[Triage] Synthesis failed for ${topicKey}:`, e.message);
      // Fallback: bullet list
      message = `‏💡 *${sourceGroup}:*\n` + groupNotices.map(n => `• ${n.content}`).join('\n');
    }

      if (SHADOW_MODE) {
        console.log(`[Triage] SHADOW would send [${topicKey}]:\n${message}\n`);
        shadowLog({ type: action, topic_key: topicKey, notice_ids: groupNotices.map(n => n.id), message });
      } else {
        try {
          const sent = await voiceSend(GROUP_JID, message);
          const noticeIds = groupNotices.map(n => n.id);
          markNoticesSent(db, noticeIds);
          saveSentMessage(db, topicKey, message, noticeIds, sourceGroup, sent && sent.msgId);
          console.log(`[Triage] Sent [${topicKey}]: "${message.substring(0, 60)}"`);
          // Update thread last_delivered_at for topic continuity
          for (const n of groupNotices) {
            if (n.thread_key) {
              try {
                db.prepare('UPDATE notice_threads SET last_delivered_at=? WHERE thread_key=?').run(Date.now(), n.thread_key);
              } catch (_) {}
            }
          }
          // Add to sentToday for subsequent buckets in same run
          sentToday.push({ topic_key: topicKey, sent_at: Date.now(), message_text: message, group_name: sourceGroup });
          // Track daily group cap
          groupSentToday[sourceGroup] = (groupSentToday[sourceGroup] || 0) + 1;
        } catch (e) {
          console.error(`[Triage] Send failed [${topicKey}]:`, e.message);
        }
      }
    }

  // Mark skip decisions as posted_to_master=1 + delivery_status='skipped' (P-009)
  // Setting delivery_status='skipped' ensures noticeDelivery batch never re-picks them up.
  for (const d of allDecisions) {
    if (d.action === 'skip') {
      db.prepare(`UPDATE notices SET posted_to_master=1, delivery_status='skipped' WHERE id=?`).run(d.notice_id);
    }
  }

  console.timeEnd('total');
  console.log('[Triage] Done.');
}

// ── B1 / P-012: Digest drain (07/12/16/20 Israel) ─────────────────────────────
// The daytime digest. triage is the SINGLE process that reads the queue and calls
// voiceSend (P-012). It drains notices triage previously classified as 'defer' —
// it does NOT re-read the 'pending' queue (that second independent reader was the
// B1 bug). deliver-batch.js invokes this via TRIAGE_MODE=digest. The pure
// formatter lives in noticeDelivery.deliverBatch(notices).

function getDeferredNotices(db) {
  // Deferred-but-undelivered notices only. B3: staleness filtering moved to JS
  // with proper Israel TZ conversion (same as getPendingNotices). LIMIT 50.
  const rows = db.prepare(`
    SELECT * FROM notices
    WHERE triage_decision = 'defer'
      AND dismissed = 0
      AND posted_to_master = 0
      AND (delivery_status IS NULL OR delivery_status NOT IN ('delivered_batch','delivered_immediate','skipped','dead_letter'))
    ORDER BY created_at ASC
    LIMIT 50
  `).all();

  // B3: Filter stale notices using Israel timezone
  const now = new Date();
  return rows.filter(n => {
    if (!n.relevance_date) return true;
    const deadline = computeDeadline(n, now);
    return deadline > now;
  });
}

async function runDigest() {
  initDB();
  const db = getDB();
  console.log(`[Triage:digest] Starting${SHADOW_MODE ? ' (SHADOW MODE)' : ''}`);

  // Quiet-hours guard (07/12/16/20 are daytime, but be safe against off-schedule runs).
  if (isQuietHours()) {
    console.log('[Triage:digest] Quiet hours — skipping digest');
    return;
  }

  const deferred = getDeferredNotices(db);
  if (deferred.length === 0) {
    console.log('[Triage:digest] No deferred notices to drain. Done.');
    return;
  }
  console.log(`[Triage:digest] ${deferred.length} deferred notice(s)`);

  // Respect active dismissals at digest time (P-005).
  const { getActiveDismissals } = require('./dismissal');
  const activeDismissals = getActiveDismissals();
  const drainable = deferred.filter(n => !activeDismissals.some(d => {
    if (d.scope_type === 'all') return true;
    if (d.scope_type === 'source_group' && n.group_name && d.scope_value) {
      return n.group_name.includes(d.scope_value) || d.scope_value.includes(n.group_name);
    }
    return false;
  }));

  // Suppressed-by-dismissal notices become skip/skipped so they don't loop back.
  const dismissedIds = deferred.filter(n => !drainable.includes(n)).map(n => n.id);
  if (dismissedIds.length > 0) {
    const ph = dismissedIds.map(() => '?').join(',');
    db.prepare(`UPDATE notices SET triage_decision='skip', triage_reason='dismissed by user', delivery_status='skipped', posted_to_master=1 WHERE id IN (${ph})`).run(...dismissedIds);
    console.log(`[Triage:digest] ${dismissedIds.length} deferred notice(s) suppressed by active dismissal`);
  }

  if (drainable.length === 0) {
    console.log('[Triage:digest] Nothing to drain after dismissals. Done.');
    return;
  }

  // Build the digest via the pure formatter (P-012: deliver-batch is a formatter
  // invoked by triage). Cluster gate OFF — these notices were already triaged to
  // 'defer', so upstream noise filtering already happened.
  const { deliverBatch, afterDeliveryHook } = require('./noticeDelivery');
  const digest = await deliverBatch(drainable, { requireActionable: false });
  if (!digest || !digest.body) {
    console.log('[Triage:digest] Formatter produced nothing — leaving notices deferred');
    return;
  }

  if (SHADOW_MODE) {
    console.log(`[Triage:digest] SHADOW would send digest (${digest.ids.length} notices):\n${digest.body}\n`);
    shadowLog({ type: 'digest', notice_ids: digest.ids, message: digest.body });
    return;
  }

  try {
    const sent = await voiceSend(GROUP_JID, digest.body);
    const batchId = `digest-${Date.now()}`;
    const ph = digest.ids.map(() => '?').join(',');
    db.prepare(`UPDATE notices SET posted_to_master=1, sent_to_master=1, delivery_status='delivered_batch', delivered_at=?, batch_id=? WHERE id IN (${ph})`)
      .run(Date.now(), batchId, ...digest.ids);
    saveSentMessage(db, batchId, digest.body, digest.ids, null, sent && sent.msgId);
    // 'Batch delivered' — kept in this exact form so the OpenClaw launcher's
    // output check (which greps for it) keeps working.
    console.log(`[Triage:digest] Batch delivered: ${digest.ids.length} notices, ${digest.clusterCount} clusters`);
    afterDeliveryHook(digest.ids).catch(() => {});
  } catch (e) {
    console.error('[Triage:digest] Send failed:', e.message);
  }
  console.log('[Triage:digest] Done.');
}

// ── B1 / P-012: Immediate drain (every 5 min) ─────────────────────────────────
// Sends genuinely-urgent notices without waiting for the */15 triage cycle. Same
// single-sender ownership (P-012). deliver-immediate.js invokes this via
// TRIAGE_MODE=immediate. Applies the same claim (P-001) + dismissal + recent-
// context guardrails as the main run's immediate handling.

function getImmediatePending(db) {
  // B3: staleness filtering moved to JS with proper Israel TZ conversion
  const rows = db.prepare(`
    SELECT id, group_name, content, urgency_hint, relevance_date, relevance_time,
           relevant_datetime, created_at
    FROM notices
    WHERE dismissed = 0
      AND posted_to_master = 0
      AND triage_decision IS NULL
      AND urgency_hint IN ('immediate','time_sensitive')
      AND (send_attempted_at IS NULL OR send_attempted_at < datetime('now', '-5 minutes'))
    ORDER BY created_at ASC
    LIMIT 50
  `).all();

  const now = new Date();
  return rows.filter(n => {
    if (!n.relevance_date) return true;
    const deadline = computeDeadline(n, now);
    return deadline > now;
  });
}

async function runImmediate() {
  initDB();
  const db = getDB();
  console.log(`[Triage:immediate] Starting${SHADOW_MODE ? ' (SHADOW MODE)' : ''}`);

  const candidates = getImmediatePending(db);
  const { selectImmediate, deliverImmediate, afterDeliveryHook } = require('./noticeDelivery');
  const urgent = selectImmediate(candidates);
  if (urgent.length === 0) {
    console.log('[Triage:immediate] Nothing urgent. Done.');
    return;
  }

  // Claim upfront (P-001) so the */15 run and a concurrent immediate run can't double-send.
  {
    const ph = urgent.map(() => '?').join(',');
    db.prepare(`UPDATE notices SET send_attempted_at = datetime('now') WHERE id IN (${ph})`).run(...urgent.map(n => n.id));
  }

  const { getActiveDismissals } = require('./dismissal');
  const activeDismissals = getActiveDismissals();
  const sentRecent = getSentRecent(db);

  for (const n of urgent) {
    // Dismissal check (content-based, mirrors the main-run immediate path).
    const dismissed = activeDismissals.some(d => {
      if (d.scope_type === 'all') return true;
      if (d.scope_type === 'source_group' && n.group_name && d.scope_value) {
        return n.group_name.includes(d.scope_value) || d.scope_value.includes(n.group_name);
      }
      if (d.scope_type === 'topic_key' && d.scope_value && n.content) {
        const keywords = d.scope_value.toLowerCase().split('-').filter(w => w.length > 3);
        const contentLower = n.content.toLowerCase();
        return keywords.some(kw => contentLower.includes(kw));
      }
      return false;
    });
    if (dismissed) {
      console.log(`[Triage:immediate] #${n.id} suppressed by active dismissal`);
      db.prepare(`UPDATE notices SET triage_decision='skip', triage_reason='dismissed by user', triaged_at=?, delivery_status='skipped', posted_to_master=1 WHERE id=?`).run(Date.now(), n.id);
      continue;
    }

    // Cross-day dedup: if this group was sent recently and it isn't 'critical',
    // release the claim and leave it for the */15 triage (which has full context).
    const alreadySentForGroup = n.group_name
      ? sentRecent.find(s => s.group_name && s.group_name === n.group_name)
      : null;
    if (alreadySentForGroup && n.urgency_hint !== 'critical') {
      db.prepare(`UPDATE notices SET send_attempted_at=NULL WHERE id=?`).run(n.id);
      console.log(`[Triage:immediate] #${n.id} released to */15 triage (group recently sent)`);
      continue;
    }

    const text = deliverImmediate(n);
    if (SHADOW_MODE) {
      console.log(`[Triage:immediate] SHADOW would send #${n.id}: "${text.substring(0, 80)}"`);
      shadowLog({ type: 'immediate', notice_id: n.id, text });
      continue;
    }
    try {
      const sent = await voiceSend(GROUP_JID, text);
      markNoticesSent(db, [n.id]);
      saveSentMessage(db, `immediate-${n.id}`, text, [n.id], n.group_name, sent && sent.msgId);
      console.log(`[Triage:immediate] Immediate: #${n.id} "${text.substring(0, 50)}"`);
      afterDeliveryHook([n.id]).catch(() => {});
    } catch (e) {
      console.error(`[Triage:immediate] Failed #${n.id}:`, e.message);
      db.prepare(`UPDATE notices SET send_attempted_at=NULL WHERE id=?`).run(n.id);
    }
  }
  console.log('[Triage:immediate] Done.');
}

// Export for test runner
module.exports = { runTriage, runDigest, runImmediate, callHaiku, callSonnet, preTriageRules, escalateLowConfidence, classifyBucket, buildClassificationPrompt, isQuietHours, getDeferredNotices, getImmediatePending, computeDeadline, israelDateToUTC, CLASSIFICATION_SYSTEM, getClassificationSystem, FEW_SHOT_EXAMPLES };

// Run if called directly. TRIAGE_MODE selects which drain to run (P-012: all
// three modes are the same single sender). Default = the */15 full triage.
if (require.main === module) {
  const mode = process.env.TRIAGE_MODE;
  const runner = mode === 'digest' ? runDigest
    : mode === 'immediate' ? runImmediate
    : runTriage;
  runner().catch(e => {
    console.error(`[Triage${mode ? ':' + mode : ''}] Fatal:`, e.message);
    process.exit(1);
  });
}
