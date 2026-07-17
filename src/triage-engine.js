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
const { sendMessage: voiceSend } = require('../lib/voice-client');

const GROUP_JID = process.env.MASTER_GROUP_JID; // set MASTER_GROUP_JID in .env
const BUDGET_MS = 80_000; // 80s wall-clock budget for synthesis phase
const SHADOW_MODE = process.env.TRIAGE_SHADOW !== 'false'; // default: shadow on
const SHADOW_LOG = path.join(__dirname, '..', 'data', 'triage-shadow-log.jsonl');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ISRAEL_TZ = 'Asia/Jerusalem';

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
          material_change: { type: 'boolean' }
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

// ── DB helpers ───────────────────────────────────────────────────────────────

function getPendingNotices(db) {
  // No created_at time-window filter — it caused notice limbo when triage timed out.
  // LIMIT 50 bounds worst-case runtime.
  // send_attempted_at guard: prevents two concurrent triage runs from double-processing.
  //   A notice claimed <5 min ago is considered in-flight by another instance.
  // relevance_date guard: skip stale past-event notices.
  //   Uses '-1 day' (not 'now') to buffer for UTC→Israel (+3h) timezone offset.
  //   NULL relevance_date = undated/evergreen notice, always included.
  // P-001: triage is the SOLE actor on this queue.
  return db.prepare(`
    SELECT id, group_name, content, urgency_hint,
           relevance_date, relevance_time, relevant_datetime, created_at
    FROM notices
    WHERE dismissed = 0
      AND posted_to_master = 0
      AND triage_decision IS NULL
      AND (send_attempted_at IS NULL OR send_attempted_at < datetime('now', '-5 minutes'))
      AND (relevance_date IS NULL OR relevance_date >= date('now', '-1 day'))
      AND (thread_key IS NULL OR thread_key NOT IN (
        SELECT thread_key FROM notice_threads WHERE dismissed = 1
      ))
    ORDER BY created_at ASC
    LIMIT 50
  `).all();
}

function getSentRecent(db) {
  // 72h lookback (not just today's midnight) — prevents cross-day re-send of
  // the same real-world event discussed across multiple days.
  const cutoff = Date.now() - 72 * 3600000;
  return db.prepare(`
    SELECT topic_key, sent_at, message_text, source_notice_ids
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

function saveSentMessage(db, topicKey, text, noticeIds) {
  db.prepare(`
    INSERT INTO sent_messages (topic_key, sent_at, message_text, source_notice_ids)
    VALUES (?, ?, ?, ?)
  `).run(topicKey, Date.now(), text, JSON.stringify(noticeIds));
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
בני המשפחה: ${getFamilyContext()}`;
  }
  return _classificationSystem;
}
const CLASSIFICATION_SYSTEM = `אתה מערכת הניהול של עוזר משפחתי חכם.
בני המשפחה: טוען בזמן ריצה.
אתה מחליט אילו הודעות שווה לשלוח לקבוצת המשימות עכשיו, מה ניתן לדחות לסיכום הבוקר, ומה כדאי לדלג עליו לחלוטין.

החזר JSON בלבד, ללא הסבר, לפי הסכימה הבאה:
{"decisions":[{"notice_id":NUMBER,"action":"send_now"|"defer"|"skip"|"send_update","merge_group":STRING_OR_NULL,"reason":"SHORT_ENGLISH_REASON","material_change":true|false}]}

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
<output>{"decisions":[{"notice_id":504,"action":"send_now","merge_group":"movie-kupa-17jun","reason":"event today 17:05, action required"},{"notice_id":505,"action":"send_now","merge_group":"movie-kupa-17jun","reason":"same movie, adds ticket detail"},{"notice_id":506,"action":"send_now","merge_group":"movie-kupa-17jun","reason":"same movie, confirms spot"}]}</output>
</example>

<example id="2" description="Skip: parent coordination noise — gift collections, planner orders, class funds">
<sent_today></sent_today>
<bucket group="הורי ו' בני" date="2026-06-17">
<notice id="510">דיון: מתנה לסייעת של CHILD — עציץ או מגנט עם תמונה, כ-400 שח. שרית תערוך סקר.</notice>
<notice id="488">הזמנת יומנים/מחברות דרך פטיש בית שאן — צריך לאשר עד מחר, מחיר להבהיר. מתעניינים להירשם.</notice>
</bucket>
<output>{"decisions":[{"notice_id":510,"action":"skip","merge_group":null,"reason":"parent group coordination about teacher gift — not family-actionable, social noise","material_change":false},{"notice_id":488,"action":"skip","merge_group":null,"reason":"parent planner order coordination — school admin noise, not family logistics","material_change":false}]}</output>
</example>

<example id="3" description="Skip: chit-chat, photos, videos — no action needed">
<sent_today></sent_today>
<bucket group="ג׳3 תשפ״ו" date="2026-06-16">
<notice id="501">דיקלה שלחה וידאו מ-Scoompa Video. ללא מידע נוסף על תוכן או פעולה נדרשת.</notice>
<notice id="502">[תמונה: ארבע תלמידות בכיתה עומדות ליד שולחן עם חטיפים ואוכל — ביסלי, ממתקים]</notice>
<notice id="503">[תמונה: שלושה ילדים בחולצות אדומות ליד שולחן עם משקאות]</notice>
</bucket>
<output>{"decisions":[{"notice_id":501,"action":"skip","merge_group":null,"reason":"generic video, no action"},{"notice_id":502,"action":"skip","merge_group":null,"reason":"class party photo, no action"},{"notice_id":503,"action":"skip","merge_group":null,"reason":"class photo, no action"}]}</output>
</example>

<example id="4" description="Defer: future event, not urgent today">
<sent_today></sent_today>
<bucket group="הורי גן כוכב" date="2026-07-01">
<notice id="901">פעילויות קייטנת קיץ — הרשמה פתוחה. מועד תחילה: 1 יולי. ניתן להירשם עד 28.6. אין דחיפות היום.</notice>
</bucket>
<output>{"decisions":[{"notice_id":901,"action":"defer","merge_group":null,"reason":"summer camp July, deadline June 28 — not urgent today"}]}</output>
</example>

<example id="5" description="send_update: new meaningful info about event already sent today">
<sent_today>
<message topic="movie-kupa-17jun" sent_at="14:02">🎬 סרט קופה ראשית בעפולה 17:05 — CHILD, אלון, עידן, גולן מצטרפים. כרטיס 14.5 שח, להזמין מראש.</message>
</sent_today>
<bucket group="כתה ו׳ רשפים" date="2026-06-17">
<notice id="507">בקשה: אריאל רוצה להצטרף לסרט קופה ראשית בעפולה היום ב-17:05. יש מקום אחד פנוי. צריך להזמין כרטיס.</notice>
</bucket>
<output>{"decisions":[{"notice_id":507,"action":"send_update","merge_group":"movie-kupa-17jun","reason":"new participant, one spot left — meaningful update to already-sent event"}]}</output>
</example>

<example id="6" description="Skip: newsletter / weekly bulletin — informational, no family action">
<sent_today></sent_today>
<bucket group="הורי גן כוכב" date="2026-07-16">
<notice id="601">ניוזלטר שבועי: השבוע התנסינו בפעילות יצירה — מדבקות, ציור, ציפורניים. הילדים נהנו מאוד. שבוע הבא נמשיך עם אותו פורמט. תודה על השתתפותכם.</notice>
<notice id="602">תמונות מפעילות מסיבת תחפושות — שיתפנו גם סרטון. ילדים נהדרים!</notice>
</bucket>
<output>{"decisions":[{"notice_id":601,"action":"skip","merge_group":null,"reason":"weekly newsletter, no actionable item — event recap only, no payment, deadline, or family action needed","material_change":false},{"notice_id":602,"action":"skip","merge_group":null,"reason":"image/video dump from past event — no action required","material_change":false}]}</output>
</example>

<example id="7" description="Skip: photo/video dump from completed past event">
<sent_today></sent_today>
<bucket group="ג׳3 תשפ״ו" date="2026-07-16">
<notice id="701">[תמונה: ילדות לבושות בתחפושות נסיכות בגן — קבוצת תמונות מיום הולדת]</notice>
<notice id="702">[תמונה: שולחן עם חטיפים וממתקים, ילדים סביבו — ללא טקסט]</notice>
<notice id="703">[תמונה: ציור אצבעות, ילדות יוצרות — ללא מידע על מועד או פעולה]</notice>
<notice id="704">וידאו מהאירוע שהסתיים. ללא מועדים, תשלומים, אנשי קשר.</notice>
</bucket>
<output>{"decisions":[{"notice_id":701,"action":"skip","merge_group":null,"reason":"photo dump from completed event, no action","material_change":false},{"notice_id":702,"action":"skip","merge_group":null,"reason":"photo dump, no action","material_change":false},{"notice_id":703,"action":"skip","merge_group":null,"reason":"photo dump, no action","material_change":false},{"notice_id":704,"action":"skip","merge_group":null,"reason":"event video recap, no action","material_change":false}]}</output>
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

async function classifyBucket(bucket, sentToday) {
  console.time(`classify:${bucket.group_name}`);
  const prompt = buildClassificationPrompt(bucket, sentToday);
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
  return parsed.decisions;
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
    return await callHaiku(SYNTHESIS_SYSTEM, user);
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
    // Check dismissal — for immediates, topic_key is not stored, so also check
    // content-based keyword matching against topic_key scope_values.
    const immediateContentDismissed = activeDismissals.some(d => {
      if (d.scope_type === 'all') return true;
      if (d.scope_type === 'source_group' && n.group_name && d.scope_value) {
        return n.group_name.includes(d.scope_value) || d.scope_value.includes(n.group_name.substring(0, 8));
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
    // Cross-day dedup: if this group was already sent recently, demote to normal triage
    const alreadySentForGroup = sentToday.find(s =>
      s.message_text && s.message_text.includes(n.group_name.substring(0, 8))
    );
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
        await voiceSend(GROUP_JID, text);
        markNoticesSent(db, [n.id]);
        saveSentMessage(db, `immediate-${n.id}`, text, [n.id]);
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

    // Daily group cap: max 3 distinct messages per source group per day
    const groupSentCount = (groupSentToday[sourceGroup] || 0) +
      sentToday.filter(s => s.sent_at >= israelMidnight && s.message_text && s.message_text.includes(sourceGroup.substring(0, 8))).length;
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
          await voiceSend(GROUP_JID, message);
          const noticeIds = groupNotices.map(n => n.id);
          markNoticesSent(db, noticeIds);
          saveSentMessage(db, topicKey, message, noticeIds);
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
          sentToday.push({ topic_key: topicKey, sent_at: Date.now(), message_text: message });
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

// Export for test runner
module.exports = { callHaiku, buildClassificationPrompt, CLASSIFICATION_SYSTEM, getClassificationSystem, FEW_SHOT_EXAMPLES };

// Run if called directly
if (require.main === module) {
  runTriage().catch(e => {
    console.error('[Triage] Fatal:', e.message);
    process.exit(1);
  });
}
