/**
 * scheduler.js — Cron-based scheduler for FamilyBot.
 * Timezone: Asia/Jerusalem
 *
 * Reminder architecture (v2):
 * - NO local DB scheduling. Reminders are derived live from Google Calendar every 5 minutes.
 * - Deleted/modified events are automatically reflected on the next poll.
 * - DB (reminders table) is used ONLY to track which reminders have already been sent (dedup).
 * - Custom reminders should be set directly on the GCal event via the API.
 */

const cron = require('node-cron');
const config = require('./config');
const { getPendingActionItems, saveReminder, claimReminder, claimDigestToday, saveFollowUp, getPendingFollowUps, claimFollowUp, setFollowUpBotMsgId, getDB, getPendingBotTasks, claimBotTask, saveBotTask } = require('./db');
const { getTodayEvents, getUpcomingEvents } = require('./calendar');

let sendToMasterGroup = null;
let sendWithMentions  = null;
let sendFollowUpFn    = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildMentions(owner) {
  const avivId = `${config.AVIV_PHONE}@c.us`;
  const liatId = `${config.LIAT_PHONE}@c.us`;
  if (owner === 'aviv') return { prefix: `@${config.AVIV_PHONE} `, mentionIds: [avivId] };
  if (owner === 'liat') return { prefix: `@${config.LIAT_PHONE} `, mentionIds: [liatId] };
  return { prefix: `@${config.AVIV_PHONE} @${config.LIAT_PHONE} `, mentionIds: [avivId, liatId] };
}

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
        const rawSummary = (e.summary || 'אירוע').split('\n')[0].trim();
        const summary = rawSummary.length > 60 ? rawSummary.substring(0, 60) + '…' : rawSummary;
        map.set(key, { summary, timeStr, sortKey: start, owners: [] });
      }
      const entry = map.get(key);
      if (!entry.owners.includes(owner)) entry.owners.push(owner);
    }
  }
  return [...map.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}

/**
 * Convert minutes-before to a human-readable Hebrew label.
 */
function minsToLabel(mins) {
  if (mins === 0) return 'עכשיו!';
  if (mins < 60) return `${mins} דקות לפני`;
  const hours = mins / 60;
  const days = mins / 1440;
  if (Number.isInteger(days) && days >= 1) {
    if (days === 1) return 'מחר (התראה יום מראש)';
    if (days === 7) return 'בעוד שבוע (התראה 7 ימים מראש)';
    return `בעוד ${days} ימים (התראה ${days} ימים מראש)`;
  }
  if (Number.isInteger(hours)) {
    if (hours === 1) return 'שעה לפני';
    return `${hours} שעות לפני`;
  }
  return `${mins} דקות לפני`;
}

/**
 * Determine which reminder times (as Date objects + labels) apply to a GCal event.
 * For timed events: uses the event's reminder overrides if set, otherwise defaults to [30] min before.
 * For all-day events: fires at 07:00 on (event-3 days) and (event-1 day).
 */
function getEventReminderTimes(event) {
  const title = (event.summary || 'אירוע').split('\n')[0].trim();

  if (event.start?.date && !event.start?.dateTime) {
    // All-day event
    const eventMorning = new Date(event.start.date + 'T07:00:00+03:00');
    return [
      { remindAt: new Date(eventMorning.getTime() - 3 * 86400000), label: '3 ימים לפני' },
      { remindAt: new Date(eventMorning.getTime() - 1 * 86400000), label: 'מחר' },
    ];
  }

  if (event.start?.dateTime) {
    const eventMs = new Date(event.start.dateTime).getTime();

    // Use GCal reminder overrides if present; otherwise default to 30 min
    let minutesBefore = [30]; // default
    const remObj = event.reminders;
    if (remObj && remObj.useDefault === false && Array.isArray(remObj.overrides) && remObj.overrides.length > 0) {
      minutesBefore = remObj.overrides
        .filter(r => r.method === 'popup' || r.method === 'email')
        .map(r => r.minutes)
        .filter(m => typeof m === 'number');
      if (minutesBefore.length === 0) minutesBefore = [30];
    }

    return minutesBefore.map(mins => ({
      remindAt: new Date(eventMs - mins * 60000),
      label: minsToLabel(mins),
    }));
  }

  return [];
}

// ── Core: fire a reminder ─────────────────────────────────────────────────────

async function fireReminder(reminder) {
  if (!sendToMasterGroup) return;
  try {
    if (!claimReminder(reminder.id)) {
      console.log(`[Scheduler] Reminder already sent, skipping: "${reminder.event_title}" (${reminder.label})`);
      return;
    }
    const isAllDay = !reminder.event_start.includes('T');
    const { prefix, mentionIds } = buildMentions(reminder.owner || 'both');
    let msg;
    if (isAllDay) {
      const dateStr = new Date(reminder.event_start + 'T00:00:00+03:00')
        .toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: config.TIMEZONE });
      msg = `${prefix}📅 *תזכורת — ${reminder.label}*\n${reminder.event_title}\n🗓 ${dateStr}`;
    } else {
      const eventDate = new Date(reminder.event_start);
      const timeStr = eventDate.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: config.TIMEZONE });
      const dateStr = eventDate.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric', timeZone: config.TIMEZONE });
      msg = `${prefix}⏰ *תזכורת — ${reminder.label}*\n${reminder.event_title}\n🗓 ${dateStr} בשעה ${timeStr}`;
    }
    // Send plain message — no @mentions. Mentions cause WhatsApp to deliver
    // a second copy to the mentioned user's DM via OpenClaw's WhatsApp session.
    await sendToMasterGroup(msg);
    console.log(`[Scheduler] Reminder fired: "${reminder.event_title}" (${reminder.label})`);
  } catch (err) {
    console.error('[Scheduler] fireReminder error:', err.message);
  }
}

// ── Poll: check calendar and fire due reminders ───────────────────────────────

/**
 * Every 5 minutes: fetch upcoming events from all calendars, compute which
 * reminders are due in this window, fire any that haven't been sent yet.
 *
 * This is the ONLY reminder mechanism. No setTimeout, no DB-scheduled reminders.
 * Deleted events won't appear in the poll → their reminders silently stop firing.
 */
async function pollAndFireReminders() {
  try {
    const now = Date.now();
    const WINDOW_MS = 6 * 60 * 1000; // 6-min window (slightly more than poll interval)

    const sources = [
      { calendarId: config.AVIV_CALENDAR_ID,      tokenPath: config.AVIV_TOKEN_PATH,  owner: 'aviv' },
      { calendarId: config.LIAT_CALENDAR_ID,      tokenPath: config.LIAT_TOKEN_PATH,  owner: 'liat' },
      ...(config.LIAT_WORK_CALENDAR_ID
        ? [{ calendarId: config.LIAT_WORK_CALENDAR_ID, tokenPath: config.LIAT_TOKEN_PATH, owner: 'liat' }]
        : []),
    ];

    const seen = new Set();

    for (const { calendarId, tokenPath, owner } of sources) {
      // Fetch next 25 hours so we catch all reminder times (e.g. 24h before an all-day event)
      const events = await getUpcomingEvents(calendarId, tokenPath, 25);

      for (const event of events) {
        if (!event.id || seen.has(event.id)) continue;
        if (event.status === 'cancelled') continue;
        seen.add(event.id);

        const startStr = event.start?.dateTime || event.start?.date;
        const title = (event.summary || 'אירוע').split('\n')[0].trim();
        const reminderTimes = getEventReminderTimes(event);

        for (const { remindAt, label } of reminderTimes) {
          const remindMs = remindAt.getTime();
          // Due: within the last WINDOW_MS (already past) up to 30s in the future
          if (remindMs >= now - WINDOW_MS && remindMs <= now + 30000) {
            // saveReminder deduplicates by event_id+label — returns existing id if already in DB
            const dbId = saveReminder({
              event_id:    event.id,
              event_title: title,
              event_start: startStr,
              remind_at:   remindAt.toISOString(),
              label,
              owner,
            });
            // claimReminder atomically sets sent=1 only if sent=0 — prevents double-fire
            await fireReminder({ id: dbId, event_id: event.id, event_title: title, event_start: startStr, remind_at: remindAt.toISOString(), label, owner });
          }
        }
      }
    }
  } catch (err) {
    console.error('[Scheduler] pollAndFireReminders error:', err.message);
  }
}

// ── Morning digest ────────────────────────────────────────────────────────────

async function sendMorningDigest() {
  if (!sendToMasterGroup) return;

  const today = new Date().toLocaleDateString('en-CA', { timeZone: config.TIMEZONE });
  if (!claimDigestToday(today)) {
    console.log('[Scheduler] Morning digest already sent today, skipping.');
    return;
  }

  try {
    const dateLabel = new Date().toLocaleDateString('he-IL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: config.TIMEZONE });
    let msg = `🌅 *דייג'סט בוקר — ${dateLabel}*\n\n`;

    const [avivEvents, liatEvents, liatWorkEvents] = await Promise.all([
      getTodayEvents(config.AVIV_CALENDAR_ID, config.AVIV_TOKEN_PATH),
      getTodayEvents(config.LIAT_CALENDAR_ID, config.LIAT_TOKEN_PATH),
      config.LIAT_WORK_CALENDAR_ID ? getTodayEvents(config.LIAT_WORK_CALENDAR_ID, config.LIAT_TOKEN_PATH) : Promise.resolve([]),
    ]);

    const merged = mergeEvents([
      { events: avivEvents,     owner: 'אביב' },
      { events: liatEvents,     owner: 'ליאת' },
      { events: liatWorkEvents, owner: 'ליאת - עבודה' },
    ]);

    const buckets = { both: [], aviv: [], liat: [] };
    merged.forEach(e => {
      const hasAviv = e.owners.includes('אביב');
      const hasLiat = e.owners.some(o => o.startsWith('ליאת'));
      if (hasAviv && hasLiat) buckets.both.push(e);
      else if (hasAviv) buckets.aviv.push(e);
      else buckets.liat.push(e);
    });

    const formatLine = e => `• ${e.timeStr} — ${e.summary}\n`;

    if (buckets.both.length) { msg += `👫 *ליאת ואביב:*\n`; buckets.both.forEach(e => { msg += formatLine(e); }); msg += '\n'; }
    if (buckets.aviv.length) { msg += `👤 *אביב:*\n`;       buckets.aviv.forEach(e => { msg += formatLine(e); }); msg += '\n'; }
    if (buckets.liat.length) { msg += `👤 *ליאת:*\n`;       buckets.liat.forEach(e => { msg += formatLine(e); }); msg += '\n'; }
    if (merged.length === 0) { msg += '  (אין אירועים)\n'; }

    const pendingItems = getPendingActionItems();
    if (pendingItems.length > 0) {
      msg += `\n📝 *משימות פתוחות:*\n`;
      pendingItems.slice(0, 10).forEach(item => {
        const due = item.due_date ? ` (${new Date(item.due_date).toLocaleDateString('he-IL', { timeZone: config.TIMEZONE })})` : '';
        const firstLine = item.description.split('\n')[0].trim();
        const shortDesc = firstLine.length > 70 ? firstLine.substring(0, 70) + '…' : firstLine;
        msg += `• ${shortDesc}${due}\n`;
      });
      if (pendingItems.length > 10) msg += `...ועוד ${pendingItems.length - 10}\n`;
    }

    await sendToMasterGroup(msg);
    console.log('[Scheduler] Morning digest sent.');
  } catch (err) {
    console.error('[Scheduler] Morning digest error:', err.message);
  }
}

// ── Follow-ups ────────────────────────────────────────────────────────────────

async function fireFollowUp(followUp) {
  if (!sendToMasterGroup || !sendFollowUpFn) return;
  if (!claimFollowUp(followUp.id)) return;

  const { prefix, mentionIds } = buildMentions(followUp.owner || 'aviv');
  const msg = `${prefix}👀 ביצעת את: *${followUp.event_title}*?\nענה כן / לא`;

  try {
    // No @mentions — same reason as reminders (avoids DM duplication via OpenClaw)
    const botMsgId = await sendFollowUpFn(msg);
    if (botMsgId) setFollowUpBotMsgId(followUp.id, botMsgId);
    console.log(`[Scheduler] Follow-up sent for: "${followUp.event_title}"`);
  } catch (err) {
    console.error('[Scheduler] fireFollowUp error:', err.message);
  }
}

function scheduleFollowUpForEvent(gcalEvent, owner = 'both') {
  const startDateTime = gcalEvent.start?.dateTime;
  if (!startDateTime) return; // all-day events: no follow-up

  const id = gcalEvent.id;
  const title = gcalEvent.summary || 'אירוע';
  const askAt = new Date(new Date(startDateTime).getTime() + 30 * 60 * 1000);
  if (askAt.getTime() <= Date.now()) return; // already past

  // DB upsert only — no setTimeout. The poll loop fires it.
  saveFollowUp({
    event_id: id, event_title: title, event_start: startDateTime,
    owner: owner === 'both' ? 'aviv' : owner,
    ask_at: askAt.toISOString(),
  });

  const minsFromNow = Math.round((askAt.getTime() - Date.now()) / 60000);
  console.log(`[Scheduler] Follow-up registered: "${title}" fires in ~${minsFromNow} min (poll-based)`);
}

// Poll-based follow-up poller — replaces all setTimeout logic.
// Runs every 60 seconds, fires any due follow-ups exactly once.
let _followUpPollTimer = null;

function startFollowUpPoller() {
  if (_followUpPollTimer) return; // idempotent
  _followUpPollTimer = setInterval(async () => {
    try {
      const now = new Date().toISOString();
      const due = getPendingFollowUps().filter(fu => fu.ask_at <= now);
      for (const fu of due) {
        await fireFollowUp(fu);
      }
    } catch (err) {
      console.error('[Scheduler] Follow-up poller error:', err.message);
    }
  }, 60_000);
  console.log('[Scheduler] Follow-up poller started (60s interval, poll-based)');
}

// ── Bot task check-ins ────────────────────────────────────────────────────────

/**
 * Every 5 minutes: fire any pending bot_tasks whose run_at has arrived.
 * These are personal check-ins ("did you do X?") stored without a calendar event.
 * Recurring tasks reschedule themselves automatically.
 */
/**
 * Send a scheduled WhatsApp to a family member via the voice server.
 * Retries up to 3 times (5-min gaps). Alerts master group on final failure.
 */
async function sendScheduledWhatsApp(task) {
  const http = require('http');
  const body = JSON.stringify({ to: task.target_phone + '@c.us', text: task.check_in_message });

  await new Promise((resolve, reject) => {
    const req = http.request(
      { host: 'localhost', port: 3001, path: '/send-message', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const r = JSON.parse(d);
            if (r.ok) resolve();
            else reject(new Error(r.error || 'send failed'));
          } catch { reject(new Error('bad response')); }
        });
      }
    );
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(body); req.end();
  }).then(() => {
    console.log(`[Scheduler] scheduled_whatsapp sent to ${task.target_phone}: "${task.description}"`);
  }).catch(async err => {
    const retries = (task.retry_count || 0) + 1;
    console.error(`[Scheduler] scheduled_whatsapp failed (attempt ${retries}/3): ${err.message}`);
    if (retries < 3) {
      // Un-claim and retry in 5 min
      const nextRun = Date.now() + 5 * 60 * 1000;
      getDB().prepare(
        'UPDATE bot_tasks SET status=\'pending\', run_at=?, retry_count=? WHERE id=?'
      ).run(nextRun, retries, task.id);
    } else {
      // Final failure — alert master group
      const recipient = task.description.match(/WhatsApp to (\S+):/)?.[1] || task.target_phone;
      if (sendToMasterGroup) {
        await sendToMasterGroup(
          `‏⚠️ לא הצלחתי לשלוח תזכורת ל${recipient} אחרי 3 נסיונות: "ִ${task.check_in_message}"`
        ).catch(() => {});
      }
    }
  });
}

async function pollBotTasks() {
  if (!sendToMasterGroup) return;
  try {
    const now = Date.now();
    const pending = getPendingBotTasks().filter(t => Number(t.run_at) <= now);
    for (const task of pending) {
      if (!claimBotTask(task.id)) continue; // already claimed by another instance
      try {
        if (task.task_type === 'scheduled_whatsapp' && task.target_phone) {
          // Send directly to a family member via voice server
          await sendScheduledWhatsApp(task);
        } else {
          // Default: check-in message to master group
          await sendToMasterGroup(task.check_in_message);
          console.log(`[Scheduler] Check-in fired: "${task.description}"`);
        }
      } catch (err) {
        console.error('[Scheduler] pollBotTasks send error:', err.message);
      }

      // If recurring, schedule the next occurrence
      if (task.recurring && task.interval_ms > 0) {
        const nextRunAt = now + Number(task.interval_ms);
        saveBotTask({
          description:       task.description,
          check_in_message:  task.check_in_message,
          run_at:            nextRunAt,
          recurring:         1,
          interval_ms:       task.interval_ms,
          time_of_day:       task.time_of_day,
          stop_on_confirm:   task.stop_on_confirm,
          group_key:         task.group_key,
        });
        console.log(`[Scheduler] Recurring check-in rescheduled: "${task.description}" in ${Math.round(Number(task.interval_ms) / 60000)} min`);
      }
    }
  } catch (err) {
    console.error('[Scheduler] pollBotTasks error:', err.message);
  }
}

// ── scheduleRemindersForEvent (no-op — reminders now driven by poll) ──────────
/**
 * @deprecated Reminders are now polled live from Google Calendar.
 * This function is kept as a no-op for backward compatibility with agent.js.
 */
function scheduleRemindersForEvent(_gcalEvent, _owner) {
  // No-op: the 5-minute pollAndFireReminders cron handles all reminders.
}

// ── Init ──────────────────────────────────────────────────────────────────────

function initScheduler(sendFn, sendWithIdFn, sendWithMentionsFn) {
  sendToMasterGroup = sendFn;
  sendFollowUpFn    = sendWithIdFn   || null;
  sendWithMentions  = sendWithMentionsFn || null;

  // Flush any stale pending reminders from old DB-based system — they're no longer valid.
  try {
    const flushed = getDB().prepare('UPDATE reminders SET sent=1 WHERE sent=0').run();
    if (flushed.changes > 0) {
      console.log(`[Scheduler] Flushed ${flushed.changes} stale pending reminder(s) from old scheduling system.`);
    }
  } catch (_) {}

  // Morning digest disabled — Lipa (OpenClaw) owns this now via its own cron.
  // cron.schedule('0 7 * * *', async () => {
  //   console.log('[Scheduler] Running morning digest...');
  //   await sendMorningDigest();
  // }, { timezone: config.TIMEZONE });

  // Poll calendar every 5 minutes for due reminders
  cron.schedule('*/5 * * * *', async () => {
    await pollAndFireReminders();
    await pollBotTasks();
  }, { timezone: config.TIMEZONE });

  // Start poll-based follow-up system (replaces old setTimeout approach)
  startFollowUpPoller();

  // First poll shortly after startup
  setTimeout(async () => {
    await pollAndFireReminders();
    await pollBotTasks();
  }, 15000);

  console.log('[Scheduler] ✅ All jobs initialized — poll-based reminders active (timezone: ' + config.TIMEZONE + ')');
}

module.exports = { initScheduler, sendMorningDigest, scheduleRemindersForEvent, scheduleFollowUpForEvent, startFollowUpPoller };
