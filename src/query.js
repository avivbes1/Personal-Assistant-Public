/**
 * query.js — Conversational query handler for FamilyBot.
 * Answers free-form questions about schedule and tasks using live calendar + DB data.
 */

const https = require('https');
const config = require('./config');
const { getFamilyContext } = require('./family-profiles');
const { render: renderPrompt } = require('./llm/prompts');
const { getPendingActionItems, getDB, getPendingHomework } = require('./db');
const { getTodayEvents, getUpcomingEvents } = require('./calendar');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

/** Strip lone/invalid Unicode surrogates that break JSON serialization */
function sanitize(str) {
  if (!str) return '';
  return str.replace(/[\uD800-\uDFFF]/g, '?');
}

/**
 * Format a Google Calendar event into a readable line.
 */
function formatEvent(event) {
  const isAllDay = !event.start?.dateTime;
  const timeStr = isAllDay
    ? 'כל היום'
    : new Date(event.start.dateTime).toLocaleTimeString('he-IL', {
        hour: '2-digit', minute: '2-digit', timeZone: config.TIMEZONE,
      });
  const owners = event._owners || [];
  const ownerStr = owners.length > 0 ? ` (${owners.join(' + ')})` : '';
  return `• ${timeStr} — ${sanitize(event.summary || 'אירוע')}${ownerStr}`;
}

/**
 * Fetch and merge events from all family calendars.
 * Deduplicates by event ID, merging owners when the same event appears in multiple calendars.
 */
async function fetchAllUpcomingEvents(hoursAhead = 7 * 24) {
  const sources = [
    { calendarId: config.AVIV_CALENDAR_ID, tokenPath: config.AVIV_TOKEN_PATH, owner: process.env.PARENT1_NAME || 'Parent 1' },
    { calendarId: config.LIAT_CALENDAR_ID, tokenPath: config.LIAT_TOKEN_PATH, owner: process.env.PARENT2_NAME || 'Parent 2' },
    ...(config.LIAT_WORK_CALENDAR_ID
      ? [{ calendarId: config.LIAT_WORK_CALENDAR_ID, tokenPath: config.LIAT_TOKEN_PATH, owner: (process.env.PARENT2_NAME || 'Parent 2') + ' (עבודה)' }]
      : []),
  ];

  const byId = new Map();

  for (const { calendarId, tokenPath, owner } of sources) {
    try {
      const list = await getUpcomingEvents(calendarId, tokenPath, hoursAhead);
      for (const e of list) {
        if (byId.has(e.id)) {
          // Merge owner into existing entry
          const existing = byId.get(e.id);
          if (!existing._owners.includes(owner)) existing._owners.push(owner);
        } else {
          byId.set(e.id, { ...e, _owners: [owner] });
        }
      }
    } catch (err) {
      console.error(`[Query] fetchAllUpcomingEvents error for ${owner}:`, err.message);
    }
  }

  return [...byId.values()].sort((a, b) => {
    const aStart = a.start?.dateTime || a.start?.date || '';
    const bStart = b.start?.dateTime || b.start?.date || '';
    return aStart.localeCompare(bStart);
  });
}

/**
 * Build a context block describing current family schedule and tasks.
 */
async function buildContext() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('he-IL', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: config.TIMEZONE,
  });
  const timeStr = now.toLocaleTimeString('he-IL', {
    hour: '2-digit', minute: '2-digit', timeZone: config.TIMEZONE,
  });

  let ctx = `תאריך ושעה נוכחיים: ${dateStr}, ${timeStr}\n\n`;

  // Family profiles
  ctx += `בני המשפחה: ${getFamilyContext()}\n\n`;

  // Today's events
  try {
    const todayById = new Map();
    for (const { calendarId, tokenPath, owner } of [
      { calendarId: config.AVIV_CALENDAR_ID, tokenPath: config.AVIV_TOKEN_PATH, owner: process.env.PARENT1_NAME || 'Parent 1' },
      { calendarId: config.LIAT_CALENDAR_ID, tokenPath: config.LIAT_TOKEN_PATH, owner: process.env.PARENT2_NAME || 'Parent 2' },
      ...(config.LIAT_WORK_CALENDAR_ID
        ? [{ calendarId: config.LIAT_WORK_CALENDAR_ID, tokenPath: config.LIAT_TOKEN_PATH, owner: (process.env.PARENT2_NAME || 'Parent 2') + ' (עבודה)' }]
        : []),
    ]) {
      const events = await getTodayEvents(calendarId, tokenPath);
      for (const e of events) {
        if (todayById.has(e.id)) {
          const existing = todayById.get(e.id);
          if (!existing._owners.includes(owner)) existing._owners.push(owner);
        } else {
          todayById.set(e.id, { ...e, _owners: [owner] });
        }
      }
    }
    const todayEvents = [...todayById.values()].sort((a, b) => (a.start?.dateTime || a.start?.date || '').localeCompare(b.start?.dateTime || b.start?.date || ''));

    if (todayEvents.length > 0) {
      ctx += `אירועים להיום:\n${todayEvents.map(formatEvent).join('\n')}\n\n`;
    } else {
      ctx += `אירועים להיום: אין\n\n`;
    }
  } catch (err) {
    console.error('[Query] buildContext today events error:', err.message);
    ctx += `(שגיאה בטעינת אירועי היום: ${err.message})\n\n`;
  }

  // Upcoming events (next 7 days, excluding today)
  try {
    const upcoming = await fetchAllUpcomingEvents(7 * 24);
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: config.TIMEZONE });
    const future = upcoming.filter(e => {
      const eDate = (e.start?.dateTime || e.start?.date || '').substring(0, 10);
      return eDate > todayStr;
    });
    console.log(`[Query] upcoming events fetched: ${upcoming.length} total, ${future.length} after today`);
    if (future.length > 0) {
      ctx += `אירועים קרובים (7 ימים הבאים):\n`;
      for (const e of future.slice(0, 15)) {
        const dateStr = (e.start?.dateTime
          ? new Date(e.start.dateTime)
          : new Date(e.start.date + 'T12:00:00')
        ).toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: config.TIMEZONE });
        const timeStr = e.start?.dateTime
          ? new Date(e.start.dateTime).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: config.TIMEZONE })
          : 'כל היום';
        const owner = e._owners?.length > 0 ? ` (${e._owners.join(' + ')})` : '';
        ctx += `• ${dateStr} ${timeStr} — ${e.summary || 'אירוע'}${owner}\n`;
      }
      ctx += '\n';
    } else {
      ctx += `אירועים קרובים (7 ימים הבאים): אין\n\n`;
    }
  } catch (err) {
    console.error('[Query] buildContext upcoming events error:', err.message);
    ctx += `(שגיאה בטעינת אירועים קרובים: ${err.message})\n\n`;
  }

  // Pending tasks
  const tasks = getPendingActionItems();
  if (tasks.length > 0) {
    ctx += `משימות פתוחות:\n`;
    tasks.slice(0, 15).forEach(t => {
      const due = t.due_date
        ? ` (עד ${new Date(t.due_date).toLocaleDateString('he-IL', { timeZone: config.TIMEZONE })})`
        : '';
      ctx += `• ${t.description.split('\n')[0].trim().substring(0, 80)}${due}\n`;
    });
  } else {
    ctx += `משימות פתוחות: אין\n`;
  }

  // Pending homework
  try {
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: config.TIMEZONE });
    const hw = getPendingHomework(todayStr);
    if (hw.length > 0) {
      ctx += `\n\u05e9\u05d9\u05e2\u05d5\u05e8\u05d9 \u05d1\u05d9\u05ea \u05e4\u05ea\u05d5\u05d7\u05d9\u05dd:\n`;
      for (const h of hw) {
        const dueFmt = h.due_date
          ? new Date(h.due_date + 'T12:00:00').toLocaleDateString('he-IL', {
              weekday: 'short', day: 'numeric', month: 'numeric',
              timeZone: config.TIMEZONE,
            })
          : '\u05dc\u05dc\u05d0 \u05ea\u05d0\u05e8\u05d9\u05da';
        const subj = h.subject ? ` (${h.subject})` : '';
        ctx += `\u2022 [id:${h.id}] ${h.child_name}${subj}: ${h.description.substring(0, 120)} [\u05e2\u05d3 ${dueFmt}]\n`;
      }
      ctx += '\n';
    } else {
      ctx += `\n\u05e9\u05d9\u05e2\u05d5\u05e8\u05d9 \u05d1\u05d9\u05ea \u05e4\u05ea\u05d5\u05d7\u05d9\u05dd: \u05d0\u05d9\u05df\n`;
    }
  } catch (e) {
    console.error('[Query] buildContext homework error:', e.message);
  }

  // Groups I monitor + their context
  try {
    const db = getDB();
    const groups = db.prepare("SELECT name, related_to, description FROM groups ORDER BY added_at").all();
    ctx += `\nקבוצות ווטסאפ שאני עוקב אחריהן:\n`;
    for (const g of groups) {
      if (g.related_to === 'master') continue;
      const desc = sanitize(g.description || '(אין הקשר)');
      const name = sanitize(g.name || '');
      ctx += `• "${name}": ${desc}\n`;
    }
  } catch (e) {
    console.error('[Query] buildContext groups error:', e.message);
  }

  // Recent messages from monitored groups (last 24h)
  try {
    const db = getDB();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recentMsgs = db.prepare(`
      SELECT m.body, m.sender, m.timestamp, g.name as group_name
      FROM messages m
      LEFT JOIN groups g ON m.group_id = g.id
      WHERE m.timestamp > ?
      ORDER BY m.timestamp DESC
      LIMIT 40
    `).all(cutoff);
    if (recentMsgs.length > 0) {
      ctx += `\nהודעות שקראתי ב-24 שעות האחרונות:\n`;
      for (const m of recentMsgs.slice(0, 30)) {
        const time = new Date(m.timestamp).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: config.TIMEZONE });
        const grp = sanitize(m.group_name || 'לא ידוע');
        ctx += `• [${grp} ${time}] ${sanitize(m.body).substring(0, 100)}\n`;
      }
    }
  } catch (e) {
    console.error('[Query] buildContext messages error:', e.message);
  }

  // Last 3 proactive notifications the bot sent
  try {
    const db = getDB();
    const recentReminders = db.prepare(`
      SELECT event_title, label, created_at FROM reminders
      WHERE sent = 1
      ORDER BY created_at DESC LIMIT 3
    `).all();
    const digestRow = db.prepare('SELECT date FROM digest_log ORDER BY sent_at DESC LIMIT 1').get();
    const notifications = [];
    if (digestRow) {
      notifications.push(`דייגסט בוקר נשלח ב-${digestRow.date}`);
    }
    for (const r of recentReminders) {
      const dt = new Date(r.created_at).toLocaleString('he-IL', { timeZone: config.TIMEZONE, day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
      notifications.push(`תזכורת "${sanitize(r.event_title)}" (${r.label}) — ${dt}`);
    }
    if (notifications.length > 0) {
      ctx += `\nהתראות אחרונות שנשלחו:\n${notifications.map(n => `• ${n}`).join('\n')}\n`;
    }
  } catch (e) {
    console.error('[Query] buildContext notifications error:', e.message);
  }

  return ctx;
}

// Family member phone numbers for SEND_WHATSAPP actions
const FAMILY_PHONES = {
  aviv: config.AVIV_PHONE,
  liat: config.LIAT_PHONE,
  [process.env.PARENT1_NAME || 'parent1']: config.AVIV_PHONE,
  [process.env.PARENT2_NAME || 'parent2']: config.LIAT_PHONE,
};

/**
 * Answer a free-form query, OR execute an agentic action if the request calls for it.
 * Returns { text, action } where action may be null.
 *
 * @param {string} question
 * @param {Array} history - recent conversation history [{role, content}]
 * @param {string|null} memberContext - resolved family member context string (Phase 2)
 * @returns {Promise<{text: string, action: object|null}>}
 */
async function answerQuery(question, history = [], memberContext = null) {
  const context = await buildContext();
  const upcomingMatch = context.match(/אירועים קרובים[^\n]*/);
  const todayMatch = context.match(/אירועים להיום[^\n]*/);
  console.log(`[Query] context length: ${context.length} | today: ${todayMatch?.[0] || 'n/a'} | upcoming section present: ${context.includes('אירועים קרובים (7 ימים הבאים):\n•')}`);


  const memberSection = memberContext
    ? `\nאנשים שמוזכרים בהודעה:\n${memberContext}\n`
    : '';

  const systemPrompt = `${renderPrompt("query-system", { BOT_NAME: config.BOT_NAME, BOT_NAME_ALT: config.BOT_NAME_ALT, CONTEXT: context + memberSection })}

## כלל 1 — השתמש בהקשר, אל תבקש הבהרה מיותרת
אם יש לך הקשר מהשיחה או מהודעה מצוטטת, **השתמש בו ישירות**. לעולם אל תשאל "על מה אתה מדבר?" כשהתשובה ברורה מההיסטוריה או מהציטוט.

## כלל 2 — הודעות מצוטטות [זוהי תגובה להודעה שלי:]
כשהמשתמש מגיב להודעה שלך, טקסט הציטוט מופיע בסוגריים. זהו **הקשר לשאלת המשך** בלבד — אל תעבד אותו מחדש כפקודה חדשה. ענה על שאלת המשך בהתבסס על הציטוט.

## כלל 3 — אל תמציא מידע על יומן
אם אין לך נתוני יומן — אמור זאת בבירור. לעולם אל תציג אירועים שלא קיימים במידע שניתן לך.
**אין "יומן משותף"** — יש יומן אישי לכל הורה (כולל יומן עבודה). כשמציג אירועים, ציין את שם הבעלים בסוגריים (כפי שמופיע בנתונים).

## כלל 4 — קצר ותמציתי
עד 3-4 שורות בדרך כלל. ישיר לעניין. ללא הקדמות מיותרות. זהו WhatsApp, לא אימייל.

## היכולות שלך (רשימה מלאה — אל תחרוג ממנה):
1. **לענות על שאלות** — מה יש מחר? מה הסטטוס של X? מה קראתי בקבוצות?
2. **לשלוח הודעת WhatsApp חד-פעמית** לבן משפחה — "תודא עם ליפא", "שלח לליפא", "תזכיר לליפא" — פעם אחת, עכשיו
3. **להוסיף אירוע ליומן** — כשיש תאריך/שעה מפורשים
4. **לרשום משימה** — מעקב, לעשות, לבדוק
5. **למחוק/לעדכן אירוע** — מחיקה, שינוי שעה/תאריך
6. **לתזמן בדיקה חד-פעמית** — לבדוק בעוד X ימים/שעות בשעה ספציפית (לא חוזר)
7. **לענות על שאלות על הקבוצות** — מה כתבו ב-X? מה קרה היום?

## מה אינך יכול לעשות (השתמש ב-capability_request):
- **בדיקות חוזרות / תזכורות מחזוריות** — "כל יום עד שנאשר", "שלח לי כל שבוע"
- **פעולות מותנות** — "אם לא ענו עד X אז Y"
- **שליחת הודעה בשעה מסוימת בעתיד** — "שלח לליפא מחר ב-9"
- כל בקשה שדורשת לוח זמנים מדויק עם חזרתיות

## כלל זהב — אל תאמת שקר:
אם אינך יכול לבצע את הבקשה **בדיוק** כפי שהתבקשת — אל תגיד שעשית. אל תשלח הודעה "קרובה". השתמש ב-capability_request.

## בדיקה עצמית לפני שליחה:
1. האם הפעולה היא בדיוק מה שנתבקשתי? (לא גרסה מקורבת)
2. אם קביעתי שעה — האם השעה הגיונית? (לא לאחר 22:00, לא לפני 07:00)
3. אם המשתמש אמר "זה לא מה שביקשתי" — עצור, הבן שגיתי, שאל שאלת הבהרה

## אם הבקשה לא מכוסה:
{"capability_request":true,"title":"[שם קצר]","description":"[תיאור מדויק]","clarification_needed":false}

אם עדיין לא ברור:
{"capability_request":true,"clarification_needed":true,"clarification_question":"[שאלה אחת]"}

## פורמט JSON — שלח הודעה:
{"response":"[אישור בעברית]","action":{"type":"SEND_WHATSAPP","to":"[parent1/parent2/ליפא]","text":"[תוכן ההודעה]"}}

## הנחיות פורמט:
- "זאת משימה בשבילך" = אתה צריך לבצע את הפעולה, לא לרשום אותה למשתמש
- פורמט: *מודגש* לכותרות, • לרשימות. ללא טבלאות.`;

  const messages = [];
  for (const h of history.slice(-6)) {
    const role = h.role === 'assistant' || h.role === 'bot' ? 'assistant' : 'user';
    messages.push({ role, content: sanitize(h.content || '') });
  }
  messages.push({ role: 'user', content: sanitize(question) });

  const body = JSON.stringify({
    model: 'claude-sonnet-4-5', // Sonnet for reasoning/conversation; parser stays on Haiku
    max_tokens: 768,
    system: systemPrompt,
    messages,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const rawText = parsed.content?.[0]?.text?.trim() || '';
          if (!rawText) return resolve({ text: 'מצטער, לא הצלחתי לענות.', action: null });

          // Try to parse structured response (action or capability_request)
          const jsonMatch = rawText.match(/\{[\s\S]*?(\"action\"|\"capability_request\")[\s\S]*?\}/);
          if (jsonMatch) {
            try {
              const structured = JSON.parse(jsonMatch[0]);

              // Capability request flow
              if (structured.capability_request) {
                return resolve({ text: rawText, action: null, capabilityRequest: structured });
              }

              // SEND_WHATSAPP action
              if (structured.action && structured.response) {
                if (structured.action.type === 'SEND_WHATSAPP') {
                  const key = (structured.action.to || '').toLowerCase();
                  structured.action.phone = FAMILY_PHONES[key] || null;
                }
                return resolve({ text: structured.response, action: structured.action });
              }
            } catch (_) {}
          }

          // Plain text answer
          resolve({ text: rawText, action: null });
        } catch (e) {
          reject(new Error('Failed to parse Claude response: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * ISSUE-010: Build query-specific context — searches DB for terms from the user's message
 * and returns both found results AND explicit "not found" markers.
 * This prevents the LLM from filling gaps with fabricated general knowledge.
 *
 * @param {string} userMessage
 * @returns {string} context section (empty string if nothing relevant found or searched)
 */
function buildQuerySpecificContext(userMessage) {
  if (!userMessage || userMessage.length < 3) return '';

  try {
    const db = getDB();

    // Extract meaningful search terms (2+ char Hebrew/English words, skip stopwords)
    const STOPWORDS = new Set(['של', 'את', 'על', 'עם', 'אם', 'כי', 'לא', 'כן', 'מה', 'מי', 'אני', 'אתה', 'הוא', 'היא', 'הם', 'אנחנו', 'יש', 'אין', 'כבר', 'גם', 'רק', 'עוד', 'the', 'is', 'are', 'what', 'how', 'when', 'why', 'who', 'for', 'and', 'or']);
    const terms = userMessage
      .replace(/[?!.,;:"'()\/\\]/g, ' ')
      .split(/\s+/)
      .map(w => w.trim())
      .filter(w => w.length >= 2 && !STOPWORDS.has(w.toLowerCase()));

    if (terms.length === 0) return '';

    // Search last 14 days for each term
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const foundTerms = [];
    const notFoundTerms = [];
    const foundMessages = new Map(); // deduplicate by message body

    for (const term of terms.slice(0, 5)) { // cap at 5 terms to avoid slow queries
      const rows = db.prepare(`
        SELECT m.body, m.sender, m.timestamp, g.name as group_name
        FROM messages m
        LEFT JOIN groups g ON m.group_id = g.id
        WHERE m.body LIKE ? AND m.timestamp > ?
        ORDER BY m.timestamp DESC LIMIT 5
      `).all(`%${term}%`, cutoff);

      if (rows.length > 0) {
        foundTerms.push(term);
        for (const row of rows) {
          const key = row.body.substring(0, 50);
          if (!foundMessages.has(key)) foundMessages.set(key, row);
        }
      } else {
        notFoundTerms.push(term);
      }
    }

    // Only add this section if there's something meaningful to report
    if (foundMessages.size === 0 && notFoundTerms.length === 0) return '';

    let section = '\n## חיפוש ממוקד (לשאלה הנוכחית):\n';

    if (foundMessages.size > 0) {
      section += '### נמצא בתיעוד:\n';
      for (const m of [...foundMessages.values()].slice(0, 8)) {
        const time = new Date(m.timestamp).toLocaleString('he-IL', {
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
          timeZone: 'Asia/Jerusalem',
        });
        section += `• [${sanitize(m.group_name || '?')}, ${time}] ${sanitize(m.sender)}: ${sanitize(m.body).substring(0, 200)}\n`;
      }
    }

    if (notFoundTerms.length > 0) {
      section += '\n=== לא נמצא בתיעוד (14 ימים אחרונים) ===\n';
      for (const term of notFoundTerms) {
        section += `• "חיפוש "עבור "${term}" — אין תוצאות\n`;
      }
    }

    return section;
  } catch (e) {
    console.warn('[Query] buildQuerySpecificContext error:', e.message);
    return '';
  }
}

module.exports = { answerQuery, buildContext, buildQuerySpecificContext, FAMILY_PHONES };
