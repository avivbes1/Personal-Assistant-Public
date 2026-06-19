/**
 * calendar.js — Google Calendar integration using googleapis.
 * Uses separate OAuth token files for Aviv and Liat.
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const config = require('./config');

/**
 * Create an authenticated Google OAuth2 client from a token file — cached per token path.
 */
let _credentials = null;
const _authClients = {};

function createAuthClient(tokenPath) {
  const resolvedTokenPath = path.resolve(tokenPath);
  if (_authClients[resolvedTokenPath]) return _authClients[resolvedTokenPath];

  const credentialsPath = path.resolve(config.GOOGLE_CREDENTIALS_PATH);
  if (!fs.existsSync(credentialsPath)) throw new Error(`Google credentials file not found at: ${credentialsPath}`);
  if (!_credentials) _credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

  const { client_secret, client_id, redirect_uris } = _credentials.installed || _credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (!fs.existsSync(resolvedTokenPath)) throw new Error(`Token file not found at: ${resolvedTokenPath}`);
  const token = JSON.parse(fs.readFileSync(resolvedTokenPath, 'utf8'));
  oAuth2Client.setCredentials(token);

  // Re-cache updated token when refreshed
  oAuth2Client.on('tokens', (newTokens) => {
    oAuth2Client.setCredentials(newTokens);
    fs.writeFileSync(resolvedTokenPath, JSON.stringify({ ...token, ...newTokens }));
  });

  _authClients[resolvedTokenPath] = oAuth2Client;
  return oAuth2Client;
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
  try {
    const auth = createAuthClient(tokenPath);
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
  } catch (err) {
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

  const response = await finalCalendar.events.insert({
    calendarId: targetCalendarId,
    sendUpdates: gcalEvent.attendees?.length ? 'all' : 'none',
    resource: gcalEvent,
  });

  console.log(`[Calendar] Shared event added: ${event.title} → ${owner} (${response.data.id})`);
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
    });

    return response.data.items || [];
  } catch (err) {
    console.error('[Calendar] getTodayEvents error:', err.message);
    return [];
  }
}

module.exports = {
  getAvivCalendar,
  getLiatCalendar,
  getUpcomingEvents,
  addEvent,
  addSharedEvent,
  getTodayEvents,
};
