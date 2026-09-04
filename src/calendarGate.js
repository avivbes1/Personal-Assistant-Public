/**
 * calendarGate.js — Single entry point for ALL calendar writes.
 *
 * Implements the 4-stage write flow:
 *   Stage 1 (extraction)  : Haiku extracts structured intent — NO calendar writes
 *   Stage 2 (fetch)       : Pull real calendar state for ±1 day — NO LLM
 *   Stage 3 (decision)    : Haiku decides create / update / skip / ask_user
 *   Stage 4 (execution)   : Deterministic: write, skip, or ask in master group
 *
 * Both handleGroupEvent (monitored groups) and handleMessage (master group)
 * route through here for all add_event actions.
 */

'use strict';

const https   = require('https');
const config  = require('./config');
const { addSharedEvent, updateCalendarEvent, listEventsForDateRange } = require('./calendar');
const { logCalendarIntent } = require('./db');
const { validateCalendarWrite, logBlocked } = require('./validation/sourceValidator');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── LLM helper ────────────────────────────────────────────────────────────────

function callHaiku(system, userContent, maxTokens = 512) {
  const body = JSON.stringify({
    model: 'claude-haiku-4-5',
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: String(userContent) }],
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
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.content?.[0]?.text?.trim() || '');
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Location resolver (Nominatim / OSM) ─────────────────────────────────────────

const _locationCache = new Map();

/**
 * Best-effort: resolve a venue name to a full street address via OSM Nominatim.
 * Returns the resolved address string (trimmed to 3 segments), or the original
 * name on any failure (timeout, parse error, no results).
 * Results are cached in-memory for the lifetime of the process.
 * @param {string} locationName  Raw venue name (e.g. "Bank Tefahot Afula")
 * @returns {Promise<string>}
 */
async function resolveLocationAddress(locationName) {
  if (!locationName) return locationName;
  const key = locationName.toLowerCase().trim();
  if (_locationCache.has(key)) return _locationCache.get(key);

  const query = encodeURIComponent(`${locationName} Israel`);
  const path  = `/search?q=${query}&format=json&limit=1&addressdetails=0`;

  return new Promise(resolve => {
    const req = https.request({
      hostname: 'nominatim.openstreetmap.org',
      path,
      method: 'GET',
      headers: {
        'User-Agent':      'family-calendar-bot/1.0 (calendar-assistant)',
        'Accept-Language': 'he,en',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const results = JSON.parse(data);
          if (results.length > 0 && results[0].display_name) {
            // Trim to first 3 comma-segments for a clean, readable address
            const resolved = results[0].display_name
              .split(',')
              .slice(0, 3)
              .join(',')
              .trim();
            _locationCache.set(key, resolved);
            console.log(`[CalendarGate] Location resolved: "${locationName}" → "${resolved}"`);
            resolve(resolved);
          } else {
            console.log(`[CalendarGate] Location not found for "${locationName}", keeping raw`);
            _locationCache.set(key, locationName);
            resolve(locationName);
          }
        } catch (e) {
          console.warn(`[CalendarGate] Nominatim parse error for "${locationName}":`, e.message);
          resolve(locationName);
        }
      });
    });
    req.on('error', err => {
      console.warn(`[CalendarGate] Nominatim request error for "${locationName}":`, err.message);
      resolve(locationName);
    });
    req.setTimeout(3000, () => {
      req.destroy();
      console.warn(`[CalendarGate] Nominatim timeout for "${locationName}", keeping raw`);
      resolve(locationName);
    });
    req.end();
  });
}

// ── Stage 1: Extract event intent from raw action ─────────────────────────────

/**
 * Takes a raw add_event action block (from Haiku group event handler)
 * and returns a normalised candidate with strict time rules.
 *
 * For events already structured (from handleMessage), we just normalise
 * without a second LLM call.
 *
 * @param {object} action  Raw action block from agent
 * @param {string} rawMessage  Original WhatsApp message text
 * @param {string} groupName
 * @returns {object|null} candidate or null if extraction failed
 */
async function extractCandidate(action, rawMessage, groupName) {
  // If action already has a clear date, normalise directly (no extra LLM call)
  const date = action.date;
  const time = action.time || null;

  if (!date) {
    console.log('[CalendarGate] Skipped: no date in action');
    return null;
  }

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.log('[CalendarGate] Skipped: invalid date format:', date);
    return null;
  }

  // Stage 1 LLM call ONLY if raw message is available AND time looks inferred
  // (i.e., action has a time but the message may not explicitly state it)
  let timeSource = 'explicit';
  if (time && rawMessage) {
    const timePattern = /\b(\d{1,2})[:.]\d{2}\b|\bבשעה\s+\d|\bשעה\s+\d|\b\d{1,2}:\d{2}\b/;
    if (!timePattern.test(rawMessage)) {
      // Time in action but not visible in message → inferred
      timeSource = 'inferred';
      console.log(`[CalendarGate] Time "${time}" appears inferred (not explicit in message)`);
    }
  }

  // Resolve venue name to a real address (Nominatim, best-effort, 3s timeout)
  const resolvedLocation = action.location
    ? await resolveLocationAddress(action.location)
    : null;

  // K3: a candidate with no usable time is an all-day event. A time that looks
  // inferred (not explicit in the message) is dropped — we never fabricate one.
  const finalTime = timeSource === 'inferred' ? null : time;

  return {
    title:       action.summary || action.title || 'אירוע',
    date,
    time:        finalTime,  // drop inferred times
    allDay:      !finalTime,
    timeSource,
    owner:       (action.owner || 'both').toLowerCase(),
    location:    resolvedLocation,
    description: action.description || null,
    durationMin: parseInt(action.duration_min, 10) || 60,
    rawMessage:  rawMessage || null,
    groupName:   groupName || null,
  };
}

// ── Stage 2: Fetch calendar context ──────────────────────────────────────────

async function fetchCalendarContext(date) {
  const events = await listEventsForDateRange(date, 1, 1);
  return events.map(e => ({
    id: e.id,
    title: e.summary || '',
    date: e.start?.date || (e.start?.dateTime || '').split('T')[0],
    startTime: e.start?.dateTime
      ? new Date(e.start.dateTime).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false })
      : 'all-day',
    location: e.location || null,
  }));
}

function formatExistingEvents(events) {
  if (events.length === 0) return '[אין אירועים בטווח ±1 יום]';
  return events.map(e =>
    `- ${e.date} ${e.startTime}: "${e.title}"${e.location ? ` @ ${e.location}` : ''} [id: ${e.id}]`
  ).join('\n');
}

// ── Stage 3: Semantic match decision ─────────────────────────────────────────

/**
 * Normalize a title for deterministic comparison:
 * strip emojis, punctuation, extra whitespace, lowercase.
 */
function normalizeTitle(str) {
  return (str || '')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}\u{FE00}-\u{FEFF}]/gu, '') // emojis
    .replace(/[\s\-–—_.,!?*()\[\]"']+/g, ' ')
    .trim()
    .toLowerCase();
}

async function decideAction(candidate, existingEvents) {
  // Deterministic pre-check: if any existing event has the same date AND
  // normalized title matches the candidate, skip without calling LLM.
  const normCandidate = normalizeTitle(candidate.title);
  const deterministicMatch = existingEvents.find(e =>
    e.date === candidate.date && normalizeTitle(e.title) === normCandidate
  );
  if (deterministicMatch) {
    console.log(`[CalendarGate] Deterministic SKIP "${candidate.title}" — matches existing "${deterministicMatch.title}" after normalization`);
    return { action: 'skip', match_event_id: deterministicMatch.id, confidence: 1.0, reason: 'deterministic title match' };
  }
  // Also check if candidate is a substring of an existing title or vice versa
  const substringMatch = existingEvents.find(e => {
    if (e.date !== candidate.date) return false;
    const normExisting = normalizeTitle(e.title);
    return normExisting.includes(normCandidate) || normCandidate.includes(normExisting);
  });
  if (substringMatch) {
    console.log(`[CalendarGate] Deterministic SKIP "${candidate.title}" — substring match with "${substringMatch.title}"`);
    return { action: 'skip', match_event_id: substringMatch.id, confidence: 0.95, reason: 'deterministic substring match' };
  }
  const system = `אתה מנוע ההחלטות של מערכת יומן. קבל החלטה אחת מבין:
- "create"   : זה אירוע חדש שלא קיים ביומן
- "update"   : זה עדכון/שינוי לאירוע קיים. כלול match_event_id.
- "skip"     : כפילות מדויקת — האירוע כבר קיים כמו שצריך, אין מה לשנות
- "ask_user" : אי-ודאות — לא ברור אם זה חדש או עדכון לקיים

כללים מחמירים:
1. אם יש אירוע קיים עם שם דומה מאוד ותאריך זהה → "skip" או "update"
2. "update" רק אם יש פרט חדש (שעה, מיקום, כותרת) שלא קיים בנוכחי
3. "ask_user" אם הדמיון גבוה אך לא מלא (ייתכן אותו אירוע, ייתכן אחר)
4. "create" רק אם אין שום אירוע דומה בטווח ±1 יום
5. השם לא חייב להיות זהה — "טורניר הורה וילד" ו-"⚽ טורניר הורה וילד — CHILD" הם אותו אירוע

ענה ב-JSON בלבד ללא markdown:
{"action":"create|update|skip|ask_user","match_event_id":"gcal_id_or_null","confidence":0.0-1.0,"reason":"קצר"}`;

  const userContent = `אירוע מוצע:
כותרת: ${candidate.title}
תאריך: ${candidate.date}
שעה: ${candidate.time || 'לא ידוע (אירוע יום שלם)'}
מיקום: ${candidate.location || 'לא צוין'}

אירועים קיימים ביומן (±1 יום):
${formatExistingEvents(existingEvents)}`;

  try {
    const raw = await callHaiku(system, userContent, 256);
    // Extract JSON from response
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in response');
    return JSON.parse(match[0]);
  } catch (err) {
    console.error('[CalendarGate] Stage 3 decision error:', err.message);
    // Default: ask user on error
    return { action: 'ask_user', match_event_id: null, confidence: 0, reason: 'decision error' };
  }
}

// ── Stage 4: Execute ──────────────────────────────────────────────────────────

async function executeDecision(decision, candidate, existingEvents, sendToMasterGroup) {
  const { action, match_event_id, reason } = decision;

  if (action === 'skip') {
    console.log(`[CalendarGate] SKIP "${candidate.title}" on ${candidate.date} — reason: ${reason}`);
    return { action: 'skipped', reason };
  }

  if (action === 'ask_user') {
    const existing = existingEvents.find(e => e.id === match_event_id) || existingEvents[0];
    const existingDesc = existing ? `"${existing.title}" (${existing.startTime})` : 'אירוע קיים';
    const msg = `📅 זיהיתי: *${candidate.title}* ב-${candidate.date}${candidate.time ? ` בשעה ${candidate.time}` : ''}\n` +
      `ביומן יש כבר ${existingDesc}.\nזה אותו אירוע? ענה *כן* / *לא*`;
    try {
      if (sendToMasterGroup) await sendToMasterGroup(msg);
      console.log(`[CalendarGate] ASK_USER for "${candidate.title}" — ${reason}`);
    } catch (e) {
      console.error('[CalendarGate] Failed to send ask_user message:', e.message);
    }
    return { action: 'asked', reason };
  }

  if (action === 'update' && match_event_id) {
    // Build patch with new info from candidate
    const patch = { summary: candidate.title };
    if (candidate.time) {
      const startISO = `${candidate.date}T${candidate.time}:00+03:00`;
      const endISO = `${candidate.date}T${padTime(candidate.time, candidate.durationMin)}:00+03:00`;
      patch.start = { dateTime: startISO, timeZone: 'Asia/Jerusalem' };
      patch.end   = { dateTime: endISO,   timeZone: 'Asia/Jerusalem' };
    }
    if (candidate.location)    patch.location    = candidate.location;
    if (candidate.description) patch.description = candidate.description;

    try {
      const tokenPath = config.AVIV_TOKEN_PATH;
      const calendarId = config.AVIV_CALENDAR_ID;
      const result = await updateCalendarEvent(calendarId, tokenPath, match_event_id, patch);
      if (result && result.ok === false) {
        console.error(`[CalendarGate] Update failed: ${result.reason}`);
        return { action: 'error', reason: result.reason, details: { eventId: match_event_id, calendarId } };
      }
      const updated = result && result.event ? result.event : result;
      console.log(`[CalendarGate] UPDATED "${candidate.title}" (${match_event_id}) — ${reason}`);
      return { action: 'updated', gcalId: match_event_id, event: updated };
    } catch (err) {
      console.error('[CalendarGate] Update failed:', err.message);
      return { action: 'error', reason: err.message, details: { eventId: match_event_id } };
    }
  }

  if (action === 'create') {
    const event = {
      title:          candidate.title,
      start_time:     candidate.time ? `${candidate.date}T${candidate.time}:00+03:00` : candidate.date,
      end_time:       candidate.time ? `${candidate.date}T${padTime(candidate.time, candidate.durationMin)}:00+03:00` : null,
      location:       candidate.location,
      description:    candidate.description || undefined,
      calendar_owner: candidate.owner,
      _source:        candidate.groupName ? 'realtime' : 'command',
      _rawMessage:    candidate.rawMessage,
    };

    try {
      const gcalEvent = await addSharedEvent(event, candidate.owner);
      if (gcalEvent) {
        console.log(`[CalendarGate] CREATED "${candidate.title}" on ${candidate.date} — ${reason}`);
        return { action: 'created', gcalId: gcalEvent.id, event: gcalEvent };
      }
      return { action: 'error', reason: 'addSharedEvent returned null', details: { title: candidate.title, date: candidate.date } };
    } catch (err) {
      console.error('[CalendarGate] Create failed:', err.message);
      return { action: 'error', reason: err.message, details: { title: candidate.title, date: candidate.date } };
    }
  }

  return { action: 'error', error: `Unknown decision action: ${action}` };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function padTime(timeStr, durationMin) {
  const [h, m] = timeStr.split(':').map(Number);
  const endMins = h * 60 + m + (durationMin || 60);
  return `${String(Math.floor(endMins / 60) % 24).padStart(2, '0')}:${String(endMins % 60).padStart(2, '0')}`;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * processEventAction — the single entry point for all calendar writes.
 *
 * @param {object} action          Raw add_event action block
 * @param {object} opts
 * @param {string} opts.rawMessage Original WhatsApp message (for time-source detection)
 * @param {string} opts.groupName  Group name (if from monitored group)
 * @param {function} opts.sendToMasterGroup  Fn to send WA message to master group
 * @param {number} opts.source_notice_id  Notice this write is grounded in (G1/P-015)
 * @returns {Promise<{action: string, gcalId?: string, event?: object, reason?: string}>}
 */
async function processEventAction(action, { rawMessage, groupName, sendToMasterGroup, source_notice_id } = {}) {
  // G1 / P-015: no calendar event without a validated source. When this write is
  // grounded in a notice, every agent-proposed field (date/time/location) must
  // appear in that notice — a value the source never stated is fabricated and the
  // write is blocked. Absent an id (e.g. a direct user request through Lipa) we
  // proceed but log a warning so the ungrounded path stays visible.
  const sourceNoticeId = source_notice_id != null ? source_notice_id : action.source_notice_id;
  if (sourceNoticeId != null) {
    const proposed = {
      date:     action.date || null,
      time:     action.time || null,
      location: action.location || null,
      summary:  action.summary || action.title || null,
    };
    const check = validateCalendarWrite(sourceNoticeId, proposed);
    if (!check.valid) {
      logBlocked('calendar_write', { ...action, source_notice_id: sourceNoticeId }, check.reason);
      console.warn(`[CalendarGate] BLOCKED calendar write (notice #${sourceNoticeId}): ${check.reason}`);
      return { action: 'blocked', reason: check.reason, ungrounded_fields: check.ungrounded_fields || [] };
    }
  } else {
    console.warn(`[CalendarGate] Calendar write with no source_notice_id ("${action.summary || action.title || 'event'}") — proceeding WITHOUT source validation`);
  }

  // Stage 1: Extract & normalise candidate
  const candidate = await extractCandidate(action, rawMessage, groupName);
  if (!candidate) return { action: 'skipped', reason: 'extraction failed' };

  console.log(`[CalendarGate] Processing "${candidate.title}" on ${candidate.date}${candidate.time ? ` at ${candidate.time}` : ' (all-day)'}`);

  // Stage 2: Fetch real calendar state
  const existingEvents = await fetchCalendarContext(candidate.date);

  // Stage 3: Decide
  const decision = await decideAction(candidate, existingEvents);
  console.log(`[CalendarGate] Decision: ${decision.action} (confidence=${decision.confidence}) — ${decision.reason}`);

  // Stage 4: Execute
  const result = await executeDecision(decision, candidate, existingEvents, sendToMasterGroup);
  return result;
}

module.exports = { processEventAction };
