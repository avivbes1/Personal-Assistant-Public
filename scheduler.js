/**
 * scheduler.js — Cron-based scheduler for Besinsky Bot.
 * Timezone: Asia/Jerusalem
 */

const cron = require('node-cron');
const config = require('./config');
const { getPendingActionItems } = require('./db');
const { getTodayEvents, getUpcomingEvents } = require('./calendar');

let sendToMasterGroup = null; // injected after init

// Track sent reminders to avoid duplicates: key = eventId + minutesMark
const sentReminders = new Set();

/**
 * Format a Google Calendar event for display.
 */
function formatEvent(event) {
  const start = event.start?.dateTime || event.start?.date;
  const startStr = start ? new Date(start).toLocaleTimeString('he-IL', {
    hour: '2-digit', minute: '2-digit', timeZone: config.TIMEZONE
  }) : 'כל היום';
  return `• ${startStr} — ${event.summary || 'ללא שם'}`;
}

/**
 * Merge events from multiple calendars, deduplicating by title+time.
 * Returns sorted list of { summary, startStr, owners[] }
 */
function mergeEvents(eventSources) {
  const map = new Map();
  for (const { events, owner } of eventSources) {
    for (const e of events) {
      const start = e.start?.dateTime || e.start?.date || '';
      const key = `${(e.summary || '').trim()}|${start.substring(0, 16)}`;
      if (!map.has(key)) {
        const timeStr = e.start?.dateTime
          ? new Date(e.start.dateTime).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: config.TIMEZONE })
          : 'כל היום';
        map.set(key, { summary: e.summary || 'אירוע', timeStr, sortKey: start, owners: [] });
      }
      const entry = map.get(key);
      if (!entry.owners.includes(owner)) entry.owners.push(owner);
    }
  }
  return [...map.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}

/**
 * Build and send the morning digest.
 */
async function sendMorningDigest() {
  if (!sendToMasterGroup) return;

  try {
    const dateLabel = new Date().toLocaleDateString('he-IL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: config.TIMEZONE });
    let msg = `🌅 *דייג'סט בוקר — ${dateLabel}*\n\n`;

    // Fetch from all calendars
    const [avivEvents, liatEvents, liatWorkEvents] = await Promise.all([
      getTodayEvents(config.AVIV_CALENDAR_ID, config.AVIV_TOKEN_PATH),
      getTodayEvents(config.LIAT_CALENDAR_ID, config.LIAT_TOKEN_PATH),
      config.LIAT_WORK_CALENDAR_ID ? getTodayEvents(config.LIAT_WORK_CALENDAR_ID, config.LIAT_TOKEN_PATH) : Promise.resolve([]),
    ]);

    const merged = mergeEvents([
      { events: avivEvents, owner: 'אביב' },
      { events: liatEvents, owner: 'ליאת' },
      { events: liatWorkEvents, owner: 'ליאת - עבודה' },
    ]);

    // Group by owner bucket
    const buckets = { both: [], aviv: [], liat: [] };
    merged.forEach(e => {
      const hasAviv = e.owners.includes('אביב');
      const hasLiat = e.owners.some(o => o.startsWith('ליאת'));
      if (hasAviv && hasLiat) buckets.both.push(e);
      else if (hasAviv) buckets.aviv.push(e);
      else buckets.liat.push(e);
    });

    const formatLine = e => `• ${e.timeStr} — ${e.summary}\n`;

    if (buckets.both.length) {
      msg += `👫 *ליאת ואביב:*\n`;
      buckets.both.forEach(e => { msg += formatLine(e); });
      msg += '\n';
    }
    if (buckets.aviv.length) {
      msg += `👤 *אביב:*\n`;
      buckets.aviv.forEach(e => { msg += formatLine(e); });
      msg += '\n';
    }
    if (buckets.liat.length) {
      msg += `👤 *ליאת:*\n`;
      buckets.liat.forEach(e => { msg += formatLine(e); });
      msg += '\n';
    }
    if (merged.length === 0) {
      msg += '  (אין אירועים)\n';
    }

    // Pending action items
    const pendingItems = getPendingActionItems();
    if (pendingItems.length > 0) {
      msg += `\n📝 *משימות פתוחות:*\n`;
      pendingItems.slice(0, 10).forEach(item => {
        const due = item.due_date ? ` (${new Date(item.due_date).toLocaleDateString('he-IL', { timeZone: config.TIMEZONE })})` : '';
        msg += `• ${item.description}${due}\n`;
      });
      if (pendingItems.length > 10) msg += `...ועוד ${pendingItems.length - 10}\n`;
    }

    await sendToMasterGroup(msg);
    console.log('[Scheduler] Morning digest sent.');
  } catch (err) {
    console.error('[Scheduler] Morning digest error:', err.message);
  }
}

/**
 * Check for events coming up in 60, 30, or 10 minutes and send reminders.
 */
async function checkUpcomingReminders() {
  if (!sendToMasterGroup) return;

  const REMINDER_WINDOWS = [60, 30, 10]; // minutes

  try {
    const now = Date.now();

    const allEvents = [
      ...(await getUpcomingEvents(config.AVIV_CALENDAR_ID, config.AVIV_TOKEN_PATH, 2)).map(e => ({ ...e, owner: 'Aviv' })),
      ...(await getUpcomingEvents(config.LIAT_CALENDAR_ID, config.LIAT_TOKEN_PATH, 2)).map(e => ({ ...e, owner: 'Liat' })),
    ];

    for (const event of allEvents) {
      const startStr = event.start?.dateTime || event.start?.date;
      if (!startStr) continue;

      const startMs = new Date(startStr).getTime();
      const diffMinutes = Math.round((startMs - now) / 60000);

      for (const window of REMINDER_WINDOWS) {
        // Send if within ±2 minutes of a reminder window
        if (Math.abs(diffMinutes - window) <= 2) {
          const key = `${event.id}_${window}`;
          if (!sentReminders.has(key)) {
            sentReminders.add(key);
            const timeStr = new Date(startStr).toLocaleTimeString('he-IL', {
              hour: '2-digit', minute: '2-digit', timeZone: config.TIMEZONE,
            });
            const reminderMsg = `⏰ *Reminder — ${window} min (${event.owner})*\n${event.summary || 'Event'} at ${timeStr}${event.location ? `\n📍 ${event.location}` : ''}`;
            await sendToMasterGroup(reminderMsg);
            console.log(`[Scheduler] Reminder sent for "${event.summary}" in ${window}min (${event.owner})`);
          }
        }
      }
    }
    // Also check for all-day events 3 days or 1 day away
    const allDayEvents = [
      ...(await getUpcomingEvents(config.AVIV_CALENDAR_ID, config.AVIV_TOKEN_PATH, 72)).map(e => ({ ...e, owner: 'Aviv' })),
      ...(await getUpcomingEvents(config.LIAT_CALENDAR_ID, config.LIAT_TOKEN_PATH, 72)).map(e => ({ ...e, owner: 'Liat' })),
    ];

    for (const event of allDayEvents) {
      if (!event.start?.date) continue; // skip timed events, only all-day

      const eventDate = new Date(event.start.date + 'T00:00:00+03:00');
      const nowDate = new Date();
      const daysUntil = Math.round((eventDate - nowDate) / (1000 * 60 * 60 * 24));

      for (const daysWindow of [3, 1]) {
        if (daysUntil === daysWindow) {
          const key = `${event.id}_days_${daysWindow}`;
          if (!sentReminders.has(key)) {
            sentReminders.add(key);
            const dayLabel = daysWindow === 1 ? 'מחר' : `בעוד ${daysWindow} ימים`;
            const msg = `📅 תזכורת — ${dayLabel} (${event.owner})\n${event.summary || 'אירוע'}`;
            await sendToMasterGroup(msg);
            console.log(`[Scheduler] ${daysWindow}-day reminder sent for "${event.summary}" (${event.owner})`);
          }
        }
      }
    }
  } catch (err) {
    console.error('[Scheduler] checkUpcomingReminders error:', err.message);
  }
}

/**
 * Initialize all scheduled jobs.
 * @param {Function} sendFn — function to send messages to master group
 */
function initScheduler(sendFn) {
  sendToMasterGroup = sendFn;

  // Job 1: Placeholder scan at 7, 11, 15, 19
  cron.schedule('0 7,11,15,19 * * *', () => {
    console.log('[Scheduler] Periodic scan tick — placeholder (no action).');
  }, { timezone: config.TIMEZONE });

  // Job 2: Morning digest at 7:00 AM
  cron.schedule('0 7 * * *', async () => {
    console.log('[Scheduler] Running morning digest...');
    await sendMorningDigest();
  }, { timezone: config.TIMEZONE });

  // Job 3: Check upcoming reminders every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    await checkUpcomingReminders();
  }, { timezone: config.TIMEZONE });

  console.log('[Scheduler] ✅ All jobs initialized (timezone: ' + config.TIMEZONE + ')');
}

module.exports = { initScheduler, sendMorningDigest };
