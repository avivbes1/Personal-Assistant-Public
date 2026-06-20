/**
 * calendar.js — Google Calendar integration using googleapis.
 * Uses separate OAuth token files for Aviv and Liat.
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getToken, saveToken, setTokenError, migrateTokenFromFile, logCalendarIntent, findPendingIntentsForDate, updateCalendarIntentStatus } = require('./db');

let _credentials = null;
const _authClients = {}; // keyed by userId ('aviv' | 'liat')

function _getCredentials() {
  if (!_credentials) {
    const credentialsPath = path.resolve(config.GOOGLE_CREDENTIALS_PATH);
    if (!fs.existsSync(credentialsPath)) throw new Error(`Google credentials file not found at: ${credentialsPath}`);
    _credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  }
  return _credentials;
}

function tokenPathToUserId(tokenPath) {
  const resolved = path.resolve(tokenPath);
  if (resolved === path.resolve(config.AVIV_TOKEN_PATH)) return { userId: 'aviv', email: config.AVIV_CALENDAR_ID };
  if (resolved === path.resolve(config.LIAT_TOKEN_PATH)) return { userId: 'liat', email: config.LIAT_CALENDAR_ID };
  throw new Error(`Unknown token path: ${tokenPath}`);
}

function _buildAuthClient(userId, email, tokenData) {
  const { client_secret, client_id, redirect_uris } = _getCredentials().installed || _getCredentials().web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(tokenData);
  oAuth2Client.on('tokens', (newTokens) => {
    const merged = { ...oAuth2Client.credentials, ...newTokens };
    oAuth2Client.setCredentials(merged);
    // Persist to DB (source of truth)
    saveToken(userId, email, merged);
    // Also write to file for backward compat (check-calendar-auth.js, etc.)
    const filePath = userId === 'aviv' ? config.AVIV_TOKEN_PATH : config.LIAT_TOKEN_PATH;
    try { fs.writeFileSync(path.resolve(filePath), JSON.stringify(merged, null, 2)); } catch (_) {}
  });
  return oAuth2Client;
}

function createAuthClient(tokenPath) {
  const { userId, email } = tokenPathToUserId(tokenPath);
  // Migrate from file to DB on first use
  migrateTokenFromFile(userId, email, tokenPath);
  if (_authClients[userId]) return _authClients[userId];
  const tokenData = getToken(userId);
  if (!tokenData || !tokenData.refresh_token) {
    throw new Error(`No valid token in DB for ${userId}. Re-auth required.`);
  }
  const client = _buildAuthClient(userId, email, tokenData);
  _authClients[userId] = client;
  return client;
}

// Reload from DB/disk and rebuild client — used as recovery after invalid_grant
function reloadAuthClient(tokenPath) {
  const { userId, email } = tokenPathToUserId(tokenPath);
  delete _authClients[userId];
  // Re-read file into DB in case file was updated externally (e.g. by exchangeAuthCode)
  const filePath = path.resolve(tokenPath);
  if (fs.existsSync(filePath)) {
    try {
      const t = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (t.refresh_token) saveToken(userId, email, t);
    } catch (_) {}
  }
  const tokenData = getToken(userId);
  if (!tokenData || !tokenData.refresh_token) return null;
  const client = _buildAuthClient(userId, email, tokenData);
  _authClients[userId] = client;
  return client;
}

function getAvivCalendar() {
  return createAuthClient(config.AVIV_TOKEN_PATH);
}

function getLiatCalendar() {
  return createAuthClient(config.LIAT_TOKEN_PATH);
}

/**
 * Get upcoming events from a Google Calendar.
 * @param {string} calendarId
 * @param {string} tokenPath
 * @param {number} hoursAhead
 * @returns {Promise<Array>}
 */
async function getUpcomingEvents(calendarId, tokenPath, hoursAhead = 24) {
  async function _fetch(auth) {
    const calendar = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const end = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);
    const response = await calendar.events.list({
      calendarId,
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 20,
    });
    return response.data.items || [];
  }
  try {
    return await _fetch(createAuthClient(tokenPath));
  } catch (err) {
    if (err.message?.includes('invalid_grant') || err.response?.data?.error === 'invalid_grant') {
      console.warn('[Calendar] invalid_grant on getUpcomingEvents — reloading token and retrying');
      const { userId } = tokenPathToUserId(tokenPath);
      setTokenError(userId, err.message);
      const reloaded = reloadAuthClient(tokenPath);
      if (reloaded) {
        try { return await _fetch(reloaded); } catch (retryErr) {
          console.error('[Calendar] getUpcomingEvents error after reload:', retryErr.message);
          return [];
        }
      }
    }
    console.error('[Calendar] getUpcomingEvents error:', err.message);
    return [];
  }
}

/**
 * Add an event to a Google Calendar.
 * Accepts event objects with either snake_case (start_time/end_time) or
 * camelCase (startTime/endTime) field names.
 * If no start time is available, creates an all-day event for today.
 * @param {string} calendarId
 * @param {string} tokenPath
 * @param {{ title: string, start_time?: string, startTime?: string, end_time?: string|null, endTime?: string|null, location?: string|null }} event
 * @returns {Promise<object|null>}
 */
async function addEvent(calendarId, tokenPath, event) {
  try {
    const auth = createAuthClient(tokenPath);
    const calendar = google.calendar({ version: 'v3', auth });

    // Support both snake_case and camelCase field names
    const rawStart = event.start_time || event.startTime || null;
    const rawEnd = event.end_time || event.endTime || null;

    let gcalEvent;

    // Check if it's a date-only string (YYYY-MM-DD, no time component)
    const isDateOnly = rawStart && (
      /^\d{4}-\d{2}-\d{2}$/.test(rawStart.trim()) ||        // YYYY-MM-DD
      /T00:00:00/.test(rawStart)                             // midnight datetime = date-only intent
    );

    if (!rawStart || isDateOnly) {
      // Extract date string directly to avoid UTC conversion shifting the day
      const dateStr = rawStart
        ? rawStart.trim().substring(0, 10)  // takes "YYYY-MM-DD" from any ISO format
        : new Date().toLocaleDateString('en-CA', { timeZone: config.TIMEZONE }); // YYYY-MM-DD in local tz
      gcalEvent = {
        summary: event.title,
        description: event.description || undefined,
        location: event.location || undefined,
        start: { date: dateStr },
        end: { date: dateStr },
      };
    } else {
      const startTime = new Date(rawStart);
      const endTime = rawEnd
        ? new Date(rawEnd)
        : new Date(startTime.getTime() + 60 * 60 * 1000); // default 1 hour

      gcalEvent = {
        summary: event.title,
        location: event.location || undefined,
        start: {
          dateTime: startTime.toISOString(),
          timeZone: config.TIMEZONE,
        },
        end: {
          dateTime: endTime.toISOString(),
          timeZone: config.TIMEZONE,
        },
      };
    }

    const response = await calendar.events.insert({
      calendarId,
      resource: gcalEvent,
    });

    console.log(`[Calendar] Event added: ${event.title} (${response.data.id})`);
    return response.data;
  } catch (err) {
    console.error('[Calendar] addEvent error:', err.message);
    return null;
  }
}

/**
 * Add a shared event to Aviv's calendar with Liat as an attendee.
 * Creates a single event both can see and respond to.
 * If an event with a similar title exists on the same day within 90 minutes,
 * updates it instead and returns the result with _wasUpdated=true.
 */
async function addSharedEvent(event, owner = 'both') {
  // owner: 'both' | 'aviv' | 'liat'
  const auth = createAuthClient(config.AVIV_TOKEN_PATH);
  const calendar = google.calendar({ version: 'v3', auth });

  const rawStart = event.start_time || event.startTime || null;
  const rawEnd = event.end_time || event.endTime || null;

  const isDateOnly = rawStart && (
    /^\d{4}-\d{2}-\d{2}$/.test(rawStart.trim()) ||
    /T00:00:00/.test(rawStart)
  );

  // ── Dedup: check for existing event before creating ───────────────────────
  if (rawStart) {
    try {
      // ─ Check 0: Intent queue cross-source dedup ─────────────────────────────
      // If another source already created an intent for this date, log a warning.
      try {
        const pendingIntents = findPendingIntentsForDate(rawStart.trim().substring(0, 10));
        if (pendingIntents.length > 0) {
          const sources = pendingIntents.map(i => i.source + ':"' + i.event_title + '"').join(', ');
          console.warn('[Calendar] ⚠️ Cross-source conflict on ' + rawStart.trim().substring(0, 10) + ': pending=[' + sources + '], incoming="' + event.title + '"');
        }
      } catch (_) {}

      const searchResults = await searchCalendarEvents(event.title);
      const newDateStr = rawStart.trim().substring(0, 10); // YYYY-MM-DD
      const newMs = isDateOnly ? null : new Date(rawStart).getTime();

      for (const { event: existing, calendarId, tokenPath } of searchResults) {
        const existingStart = existing.start?.dateTime || existing.start?.date;
        if (!existingStart) continue;

        // Must be same day
        if (existingStart.substring(0, 10) !== newDateStr) continue;

        // If both have times, check within 90 minutes
        if (existing.start?.dateTime && newMs !== null) {
          const existingMs = new Date(existing.start.dateTime).getTime();
          if (Math.abs(newMs - existingMs) / 60000 > 90) continue;
        }

        // Found a match — build a patch and update
        const previousStart = existingStart;
        let patch = {};
        if (!rawStart || isDateOnly) {
          const dateStr = rawStart
            ? rawStart.trim().substring(0, 10)
            : new Date().toLocaleDateString('en-CA', { timeZone: config.TIMEZONE });
          patch = {
            start: { date: dateStr },
            end: { date: dateStr },
          };
        } else {
          const startTime = new Date(rawStart);
          const endTime = rawEnd
            ? new Date(rawEnd)
            : new Date(startTime.getTime() + 15 * 60 * 1000);
          patch = {
            start: { dateTime: startTime.toISOString(), timeZone: config.TIMEZONE },
            end: { dateTime: endTime.toISOString(), timeZone: config.TIMEZONE },
          };
        }
        if (event.location != null) patch.location = event.location;
        if (event.description != null) patch.description = event.description;

        const updated = await updateCalendarEvent(calendarId, tokenPath, existing.id, patch);
        if (updated) {
          console.log(`[Calendar] Dedup: updated existing event "${event.title}" instead of creating new (${existing.id})`);
          return { ...updated, _wasUpdated: true, _previousStart: previousStart };
        }
      }
    } catch (err) {
      console.error('[Calendar] addSharedEvent dedup check error:', err.message);
      // Fall through to create normally
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  let gcalEvent;
  if (!rawStart || isDateOnly) {
    const dateStr = rawStart
      ? rawStart.trim().substring(0, 10)
      : new Date().toLocaleDateString('en-CA', { timeZone: config.TIMEZONE });
    gcalEvent = {
      summary: event.title,
      description: event.description || undefined,
      location: event.location || undefined,
      attendees: owner === 'liat' ? [] : owner === 'both' ? [{ email: config.LIAT_CALENDAR_ID }] : [],
      start: { date: dateStr },
      end: { date: dateStr },
    };
  } else {
    const startTime = new Date(rawStart);
    const endTime = rawEnd
      ? new Date(rawEnd)
      : new Date(startTime.getTime() + 15 * 60 * 1000);
    gcalEvent = {
      summary: event.title,
      description: event.description || undefined,
      location: event.location || undefined,
      attendees: owner === 'liat' ? [] : owner === 'both' ? [{ email: config.LIAT_CALENDAR_ID }] : [],
      start: { dateTime: startTime.toISOString(), timeZone: config.TIMEZONE },
      end: { dateTime: endTime.toISOString(), timeZone: config.TIMEZONE },
    };
  }

  // For liat-only events: add to Liat's calendar using her token
  const targetCalendarId = owner === 'liat' ? config.LIAT_CALENDAR_ID : config.AVIV_CALENDAR_ID;
  const finalAuth = owner === 'liat' ? createAuthClient(config.LIAT_TOKEN_PATH) : auth;
  const finalCalendar = owner === 'liat' ? google.calendar({ version: 'v3', auth: finalAuth }) : calendar;

  // ─ Step 6: Log intent before insert ─────────────────────────────────────
  const intentSource = event._source || 'realtime';
  const intentDate = rawStart ? rawStart.trim().substring(0, 10) : null;
  let intentId = null;
  try {
    intentId = logCalendarIntent({
      source: intentSource,
      event_title: event.title,
      event_date: intentDate,
      event_start: rawStart || null,
      event_end: rawEnd || null,
      raw_message: event._rawMessage || null,
    });
  } catch (_) {}

  const response = await finalCalendar.events.insert({
    calendarId: targetCalendarId,
    sendUpdates: gcalEvent.attendees?.length ? 'all' : 'none',
    resource: gcalEvent,
  });

  // ─ Step 5: Confirm ONLY from actual API response ─────────────────────────
  const calEventId = response.data?.id;
  if (intentId) {
    try { updateCalendarIntentStatus(intentId, calEventId ? 'applied' : 'failed', calEventId); } catch (_) {}
  }
  if (!calEventId) throw new Error('Calendar API returned no event ID — insert may have failed');

  console.log(`[Calendar] Shared event added: ${event.title} → ${owner} (${calEventId})`);
  return response.data;
}

/**
 * Get today's events from a Google Calendar.
 * @param {string} calendarId
 * @param {string} tokenPath
 * @returns {Promise<Array>}
 */
async function getTodayEvents(calendarId, tokenPath) {
  try {
    const auth = createAuthClient(tokenPath);
    const calendar = google.calendar({ version: 'v3', auth });

    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: config.TIMEZONE }); // YYYY-MM-DD in Israel time
    const startOfDay = new Date(`${todayStr}T00:00:00+03:00`);
    const endOfDay = new Date(`${todayStr}T23:59:59+03:00`);

    const response = await calendar.events.list({
      calendarId,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 20,
      showDeleted: false,
    });

    // Filter out cancelled events (e.g. declined invites that weren't fully removed)
    return (response.data.items || []).filter(e => e.status !== 'cancelled');
  } catch (err) {
    console.error('[Calendar] getTodayEvents error:', err.message);
    return [];
  }
}

/**
 * List Aviv's events for a specific date (YYYY-MM-DD). Diagnostic / dedup use.
 * Returns array of gcal event objects.
 */
async function listEventsForDate(dateStr) {
  try {
    const auth = createAuthClient(config.AVIV_TOKEN_PATH);
    const calendar = google.calendar({ version: 'v3', auth });
    const response = await calendar.events.list({
      calendarId: config.AVIV_CALENDAR_ID,
      timeMin: new Date(`${dateStr}T00:00:00+03:00`).toISOString(),
      timeMax: new Date(`${dateStr}T23:59:59+03:00`).toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 20,
      showDeleted: false,
    });
    return (response.data.items || []).filter(e => e.status !== 'cancelled');
  } catch (err) {
    console.error('[Calendar] listEventsForDate error:', err.message);
    return [];
  }
}

/**
 * List events for Aviv's calendar within a date range (±N days around a date).
 */
async function listEventsForDateRange(dateStr, daysBefore = 1, daysAfter = 1) {
  try {
    const auth = createAuthClient(config.AVIV_TOKEN_PATH);
    const calendar = google.calendar({ version: 'v3', auth });
    const base = new Date(`${dateStr}T00:00:00+03:00`);
    const timeMin = new Date(base.getTime() - daysBefore * 86400000).toISOString();
    const timeMax = new Date(base.getTime() + (daysAfter + 1) * 86400000).toISOString();
    const response = await calendar.events.list({
      calendarId: config.AVIV_CALENDAR_ID,
      timeMin, timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
      showDeleted: false,
    });
    return (response.data.items || []).filter(e => e.status !== 'cancelled');
  } catch (err) {
    console.error('[Calendar] listEventsForDateRange error:', err.message);
    return [];
  }
}

/**
 * Search for events across all family calendars by title keyword.
 * Returns array of { event, calendarId, tokenPath } sorted by start time.
 */
async function searchCalendarEvents(query, daysAhead = 60) {
  const calendars = [
    { calendarId: config.AVIV_CALENDAR_ID, tokenPath: config.AVIV_TOKEN_PATH },
    { calendarId: config.LIAT_CALENDAR_ID, tokenPath: config.LIAT_TOKEN_PATH },
  ];
  if (config.LIAT_WORK_CALENDAR_ID) {
    calendars.push({ calendarId: config.LIAT_WORK_CALENDAR_ID, tokenPath: config.LIAT_TOKEN_PATH });
  }

  const now = new Date();
  const timeMax = new Date(now.getTime() + daysAhead * 86400000);
  // Also search a bit into the past (for recently passed events that moved)
  const timeMin = new Date(now.getTime() - 7 * 86400000);

  const results = [];
  const seenIds = new Set();

  for (const { calendarId, tokenPath } of calendars) {
    try {
      const auth = createAuthClient(tokenPath);
      const calendar = google.calendar({ version: 'v3', auth });
      const response = await calendar.events.list({
        calendarId,
        q: query,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 10,
      });
      for (const event of (response.data.items || [])) {
        if (!seenIds.has(event.id)) {
          seenIds.add(event.id);
          results.push({ event, calendarId, tokenPath });
        }
      }
    } catch (err) {
      console.error(`[Calendar] searchCalendarEvents error (${calendarId}):`, err.message);
    }
  }

  return results;
}

/**
 * Update an existing calendar event (PATCH — partial update).
 * @param {string} calendarId
 * @param {string} tokenPath
 * @param {string} eventId
 * @param {object} patch — partial gcal event object (e.g. { start, end, summary, description })
 */
async function updateCalendarEvent(calendarId, tokenPath, eventId, patch) {
  try {
    const auth = createAuthClient(tokenPath);
    const calendar = google.calendar({ version: 'v3', auth });
    const response = await calendar.events.patch({
      calendarId,
      eventId,
      resource: patch,
      sendUpdates: 'all',
    });
    console.log(`[Calendar] Event updated: ${response.data.summary} (${eventId})`);
    return response.data;
  } catch (err) {
    console.error('[Calendar] updateCalendarEvent error:', err.message);
    return null;
  }
}

async function deleteCalendarEvent(calendarId, tokenPath, eventId) {
  try {
    const auth = createAuthClient(tokenPath);
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({ calendarId, eventId, sendUpdates: 'all' });
    console.log(`[Calendar] Event deleted: ${eventId} from ${calendarId}`);
    return true;
  } catch (err) {
    if (err.code === 410) return true; // already deleted
    console.error('[Calendar] deleteCalendarEvent error:', err.message);
    return false;
  }
}

/**
 * Generate a personalized Google OAuth authorization URL.
 * @param {string} email - login_hint for the user (pre-fills the Google login)
 * @returns {string}
 */
function generateAuthUrl(email) {
  if (!_credentials) {
    const credentialsPath = path.resolve(config.GOOGLE_CREDENTIALS_PATH);
    _credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  }
  const { client_secret, client_id, redirect_uris } = _credentials.installed || _credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  return oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    prompt: 'select_account',  // was 'consent' — using consent revokes existing refresh tokens
    login_hint: email,
  });
}

/**
 * Exchange an OAuth authorization code for tokens and save to tokenPath.
 * @param {string} code
 * @param {string} tokenPath
 * @returns {Promise<object>} tokens
 */
async function exchangeAuthCode(code, tokenPath) {
  const { client_secret, client_id, redirect_uris } = _getCredentials().installed || _getCredentials().web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  const { tokens } = await oAuth2Client.getToken(code);
  const { userId, email } = tokenPathToUserId(tokenPath);
  // Write to DB (source of truth) and file (backward compat)
  saveToken(userId, email, tokens);
  fs.writeFileSync(path.resolve(tokenPath), JSON.stringify(tokens, null, 2));
  // Clear cached client so next call builds fresh from DB
  delete _authClients[userId];
  return tokens;
}

/**
 * Verify that the OAuth credentials for a given token path are valid.
 * Makes a lightweight API call to test auth — unlike getTodayEvents which
 * silently returns [] on auth failure, this surfaces the real status.
 * @param {string} tokenPath
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function verifyCalendarAuth(tokenPath) {
  try {
    const auth = createAuthClient(tokenPath);
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.calendarList.list({ maxResults: 1 });
    return { ok: true };
  } catch (err) {
    if (err.message?.includes('invalid_grant') || err.response?.data?.error === 'invalid_grant') {
      // Reload from disk/DB and retry once before declaring failure
      const { userId } = tokenPathToUserId(tokenPath);
      setTokenError(userId, err.message);
      const reloaded = reloadAuthClient(tokenPath);
      if (reloaded) {
        try {
          const calendar = google.calendar({ version: 'v3', auth: reloaded });
          await calendar.calendarList.list({ maxResults: 1 });
          return { ok: true };
        } catch (retryErr) {
          setTokenError(userId, retryErr.message);
          return { ok: false, error: retryErr.message };
        }
      }
    }
    return { ok: false, error: err.message };
  }
}

module.exports = {
  getAvivCalendar,
  getLiatCalendar,
  getUpcomingEvents,
  addEvent,
  addSharedEvent,
  getTodayEvents,
  listEventsForDate,
  listEventsForDateRange,
  searchCalendarEvents,
  updateCalendarEvent,
  deleteCalendarEvent,
  verifyCalendarAuth,
  generateAuthUrl,
  exchangeAuthCode,
  reloadAuthClient,
};
