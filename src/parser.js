/**
 * parser.js — LLM-powered parser using Claude for Hebrew/English text.
 * Falls back to regex heuristics if API call fails.
 */

const https = require('https');
const config = require('./config');
const { getFamilyContext } = require('./family-profiles');
const { render: renderPrompt } = require('./llm/prompts');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TODAY = () => new Date().toLocaleDateString('he-IL', { timeZone: process.env.TIMEZONE || 'Asia/Jerusalem', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

const SYSTEM_PROMPT_BASE = `You are ${config.BOT_NAME_ALT}, a smart family assistant. You extract structured data from WhatsApp messages — from the family master group and from monitored family group chats.
TIMEZONE_PLACEHOLDER IMPORTANT: all times in messages are LOCAL Israel time (UTC+3). Return start_time and end_time as ISO8601 strings with +03:00 offset when a time is given (e.g. "2026-05-11T07:30:00+03:00"), or ONLY the date "YYYY-MM-DD" when no time is mentioned. Be terse. Omit null fields.

GROUP_CONTEXT_PLACEHOLDER

FAMILY_MEMBERS_PLACEHOLDER

Extract events and action items from the message. Return ONLY valid JSON, no explanation, no markdown.

Format:
{
  "events": [
    {
      "title": "clean actionable title — strip reminder prefixes like 'תזכיר לי', 'remind me', 'תזכורת', 'אל תשכח'. Just the actual task/event name.",
      "start_time": "YYYY-MM-DD if date only, ISO8601+03:00 if time given, null if no date at all",
      "end_time": "same format as start_time, or null",
      "location": "location or null",
      "description": "ALL details relevant to THIS event: topics, agenda, what to bring, notes",
      "is_reminder": true/false,
      "calendar_owner": "both|aviv|liat",
      "family_members": ["CHILD_1","CHILD_2"] // which family members are involved/affected
    }
  ],
  "actionItems": [
    {
      "description": "what needs to be done",
      "due_date": "YYYY-MM-DD or ISO8601+03:00 or null",
      "family_members": ["CHILD_NAME"] // who is involved
    }
  ],
  "intent": "event|reminder|task|query|update|delete|bot_task|unknown",
  // Only present when intent is "update":
  "update": {
    "search_title": "keywords to search calendar for the existing event (e.g. 'soccer Nevo')",
    "changes": {
      "start_time": "new ISO8601+03:00 or YYYY-MM-DD if date only, omit if not changing",
      "end_time": "new ISO8601+03:00, omit if not changing",
      "title": "new title, omit if not changing",
      "location": "new location, omit if not changing",
      "description": "new/additional description, omit if not changing"
    }
  },
  // Only present when intent is "delete":
  "delete": {
    "search_title": "keywords to search the calendar for the event to delete (e.g. 'trip with Roly', 'טיול עם רולי')"
  },
  // Only present when intent is "bot_task":
  "bot_task": {
    "description": "what Tudat needs to do (e.g. 'make sure Liat booked babysitters')",
    "check_in_message": "the message Tudat will send to the master group when it checks in (Hebrew)",
    "schedule": "now|Xhours|Xdays — when to execute for ONE-TIME tasks. 'now' = immediately. '2days' = 2 days from now.",
    "send_to": "liat|aviv|master — who to send to. 'master' = master group check-in",
    "recurring": "true if the task should repeat (e.g. 'every day', 'daily until confirmed'). false otherwise.",
    "time_of_day": "HH:MM in 24h format for scheduled time (e.g. '20:00'). Only when a specific time was mentioned.",
    "stop_on_confirm": "true if the recurring task should stop when the user replies 'כן' (yes, confirmed)"
  }
}

Rules:
- "מחר" = tomorrow, "היום" = today, "בשעה X" = at time X
- CRITICAL: NEVER use relative time words (מחר, היום, tomorrow, today, next week, השבוע הבא, etc.) in titles, descriptions, or action item text. Always convert to the actual date (e.g. "יום שישי 8.5" or "9.5"). The message may be read days later — relative words become wrong.
- If message is asking a question or requesting info → intent: "query", empty arrays
- If the message says "remind me" / "תזכיר לי" → events with is_reminder:true
- If it's a task (buy, bring, check, etc.) → actionItems
- For exam/event announcements with study topics → put ALL topics in that event's description, not as separate action items
- If unclear → intent: "unknown", return empty arrays
- CRITICAL: if multiple events listed → separate entry per event, NEVER merge
- IMPORTANT: If the message is clearly addressed to a specific person (not the bot) — e.g. "PARENT tell CHILD" — return intent:"unknown" and empty arrays
- If the message says an existing event moved/changed/rescheduled → intent:"update" with "update" object. Do NOT also put it in events[]. Examples: "CHILD soccer moved from 16:00 to 17:00"
- If the message asks TUDAT to do something (not the user): check on something, remind, follow up, verify — intent:"bot_task". Examples: "תודא שליאת סגרה X", "תזכיר לי לשאול אם X", "במהלך השבוע תבדוק אם Y", "כל יום בשעה 20:00 בדוק אם X עד שנאשר", "follow up with Liat about Z". Key signal: verb is addressed TO the bot. For recurring requests ("כל יום", "כל שבוע", "עד שנאשר"), set recurring:true, time_of_day if mentioned, stop_on_confirm:true if "until confirmed". This is NOT a user task — it's Tudat's own to-do.
- If the message says to DELETE/CANCEL/REMOVE an event from the calendar → intent:"delete" with "delete" object containing search_title. Examples: "תמחק את זה מהיומן", "מחק את הטיול", "בטל את הפגישה", "delete this from calendar". Use [ההודעה המצוטטת: ...] if present to identify which event.
- "ביטול" alone (cancellation notice) → intent:"update" not "delete" (event still exists, mark it cancelled)
- Use group context (if provided) to infer which family member is involved even if the message doesn't say
- Return ONLY valid JSON, no markdown fences, no explanation
- CRITICAL: Return ONLY raw JSON. No markdown, no explanation, no code blocks. The first character must be { and the last must be }.`;

/**
 * Call Claude API to parse message.
 */
async function parseWithClaude(text, history = [], groupContext = null) {
  if (!ANTHROPIC_API_KEY) throw new Error('No ANTHROPIC_API_KEY');

  // Build messages array with recent history context
  const messages = [];
  const recentHistory = history.slice(-10);
  for (const h of recentHistory) {
    messages.push({ role: h.role, content: h.content });
  }
  messages.push({ role: 'user', content: text });

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const groupContextStr = groupContext
    ? `GROUP CONTEXT: This message comes from the group "${groupContext.name}". Known context: "${groupContext.description}". Use this to infer which family members are involved.`
    : '';
  const systemPrompt = renderPrompt('parser-system', {
    BOT_NAME_ALT:   config.BOT_NAME_ALT,
    TIMEZONE_LINE:  `Today's date: ${today} (${config.TIMEZONE} timezone). IMPORTANT: all times in messages are LOCAL timezone. Return start_time and end_time as ISO8601 with timezone offset when time is given, or ONLY the date "YYYY-MM-DD" when no time is mentioned. Be terse. Omit null fields.`,
    GROUP_CONTEXT:  groupContextStr,
    FAMILY_CONTEXT: getFamilyContext(),
  });

  const body = JSON.stringify({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
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
          let content = parsed.content?.[0]?.text || '{}';
          // Extract JSON from inside code fences if Claude wraps it (handles any prefix text too)
          const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
          if (fenceMatch) {
            content = fenceMatch[1].trim();
          } else {
            // No fences — try to extract the JSON object/array directly
            const jsonStart = content.search(/[{[]/);
            if (jsonStart > 0) content = content.slice(jsonStart);
            content = content.trim();
          }
          resolve(JSON.parse(content));
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
 * Regex fallback — basic Hebrew/English patterns.
 */
function parseWithRegex(text) {
  // Questions should never be treated as events
  const trimmed = text.trim();
  const isQuestion = /^(מה|מתי|האם|כמה|איפה|מי|למה|איך)\s/.test(trimmed) || trimmed.endsWith('?');
  if (isQuestion) {
    return { events: [], actionItems: [], intent: 'query' };
  }

  const events = [];
  const actionItems = [];

  const hasReminder = /תזכיר|תזכורת|תזכור|להזכיר|remind/i.test(text);
  const hasAction = /צריך|להביא|לקנות|לשלוח|לבדוק|לאסוף|need to|buy|bring|check/i.test(text);
  const hasTime = /\d{1,2}:\d{2}|מחר|היום|tomorrow|today/.test(text);

  if (hasReminder || (hasTime && !hasAction)) {
    const now = new Date();
    if (/מחר|tomorrow/.test(text)) now.setDate(now.getDate() + 1);
    const timeMatch = text.match(/(\d{1,2}):(\d{2})/);
    if (timeMatch) now.setHours(parseInt(timeMatch[1]), parseInt(timeMatch[2]), 0, 0);
    events.push({ title: text.substring(0, 80), start_time: now.toISOString(), end_time: null, location: null, is_reminder: true });
  }

  if (hasAction) {
    actionItems.push({ description: text.substring(0, 120), due_date: null });
  }

  return { events, actionItems, intent: events.length ? 'reminder' : actionItems.length ? 'task' : 'unknown' };
}

/**
 * Main export: parse text and return { events, actionItems, intent }
 */
async function extractFromText(text, history = [], groupContext = null) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return { events: [], actionItems: [], intent: 'unknown' };
  }

  try {
    const result = await parseWithClaude(text, history, groupContext);
    console.log(`[Parser] Claude parsed: intent=${result.intent}, events=${result.events?.length || 0}, tasks=${result.actionItems?.length || 0}`);
    return {
      events: result.events || [],
      actionItems: result.actionItems || [],
      intent: result.intent || 'unknown',
      update: result.update || null,
      delete: result.delete || null,
      bot_task: result.bot_task || null,
    };
  } catch (err) {
    console.warn('[Parser] Claude failed, using regex fallback:', err.message);
    return parseWithRegex(text);
  }
}

/**
 * Detect which required params are missing from parsed events.
 * Returns array of missing param names for the first event, or [].
 */
function detectMissingParams(events, intent) {
  if (!['event', 'reminder'].includes(intent) || events.length === 0) return [];
  const event = events[0];
  const missing = [];
  if (!event.start_time) missing.push('start_time');
  if (!event.title || event.title.trim().length < 2) missing.push('title');
  return missing;
}

/**
 * Build a focused Hebrew clarification question for a single missing param.
 */
function buildClarificationQuestion(missingParams, partialEvent) {
  const title = partialEvent.title ? ` "${partialEvent.title}"` : '';
  if (missingParams.includes('start_time')) return `לאיזה תאריך ושעה לקבוע${title}?`;
  if (missingParams.includes('title')) return 'מה שם האירוע?';
  return 'חסר לי מידע — תוכל לפרט יותר?';
}

/**
 * Ask Claude to extract a missing param value from the user's clarification reply.
 * Returns an object with extracted fields, e.g. { start_time: "2026-05-10T10:00:00+03:00" }
 */
async function resolvePartialEvent(partialEvent, missingParams, clarificationQuestion, userReply) {
  if (!ANTHROPIC_API_KEY) return {};
  const today = new Date().toLocaleDateString('en-CA', { timeZone: process.env.TIMEZONE || 'Asia/Jerusalem' });

  const system = `You are a date/time extraction assistant. Today is ${today} (Asia/Jerusalem, UTC+3). Extract ONLY the missing parameter(s) from the user's reply. Return ONLY valid JSON with the extracted fields. Times must be ISO8601 with +03:00 offset. If a param cannot be extracted, omit it.`;

  const user = `Partial event: ${JSON.stringify(partialEvent)}
Missing params needed: ${missingParams.join(', ')}
Bot asked: "${clarificationQuestion}"
User replied: "${userReply}"

Return JSON with only the missing params filled in, e.g.: {"start_time":"2026-05-10T10:00:00+03:00"}`;

  const body = JSON.stringify({
    model: 'claude-haiku-4-5',
    max_tokens: 128,
    system,
    messages: [{ role: 'user', content: user }],
  });

  return new Promise((resolve) => {
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
          const text = parsed.content?.[0]?.text || '{}';
          const match = text.match(/\{[\s\S]*\}/);
          resolve(match ? JSON.parse(match[0]) : {});
        } catch (_) { resolve({}); }
      });
    });
    req.on('error', () => resolve({}));
    req.write(body);
    req.end();
  });
}

module.exports = { extractFromText, detectMissingParams, buildClarificationQuestion, resolvePartialEvent };
