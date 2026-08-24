/**
 * whatsapp.js â€" WhatsApp client using whatsapp-web.js with LocalAuth.
 * Monitors specified groups and handles incoming messages.
 */

// Baileys adapter (replaces whatsapp-web.js)
const { BaileysClient } = require('./baileys-client');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const logger = require('./logger');
const { recordMessagePersisted, getMessagesPersisted5Min } = require('./message-counter');

// Safe _serialized accessor (WhatsApp Web renamed _serialized to $1 in some builds)
function _ser(obj) {
  if (!obj) return undefined;
  return obj._serialized || obj['$1'] || (typeof obj.toString === 'function' ? obj.toString() : undefined);
}
const { saveMessage, saveNotice, saveEvent, saveActionItem, saveClarification, saveGroup, setGroupRelatedTo, setGroupDescription, getGroup, getMonitoredGroupsWithoutDescription, getAllPendingGroupQuestions, savePendingGroupQuestion, getPendingGroupQuestion, deletePendingGroupQuestion, isMessageProcessed, markMsgProcessed, getDB, addToConversationHistory, getConversationHistory, setPendingAction, getPendingAction, clearPendingAction, cancelRemindersForEvent, cancelFollowUpsForEvent, saveBotTask, getPendingBotTasks, claimBotTask, cancelRecurringGroup, isRecurringGroupActive, saveCapabilityRequest, getPendingCapabilityRequests, getRecentGroupMessages, markMessageTerminal, updateMessageMedia, setMediaStatus } = require('./db');
const { archiveMedia } = require('./media-archive');
const { resolveMembersInText } = require('./family-profiles');
const { validateOutgoing, repairMessage } = require('./validate-outgoing');
const { extractFromText, detectMissingParams, buildClarificationQuestion, resolvePartialEvent } = require('./parser');
const { processMediaMessage, extractFromUrl, isSchoolGroup } = require('./media-parser');
const { addEvent, addSharedEvent, searchCalendarEvents, updateCalendarEvent, deleteCalendarEvent } = require('./calendar');
const { scheduleRemindersForEvent, scheduleFollowUpForEvent } = require('./scheduler');
const { answerQuery } = require('./query');
const { handleMessage, handleGroupEvent } = require('./agent');
const { getFollowUpByBotMsgId, updateFollowUpStatus, dismissThread, getMostRecentDeliveredThread } = require('./db');
// Requiring voice-server starts the HTTP health/voice server immediately (on
// module load), before WhatsApp connects — so /health is reachable during
// startup. setClient() wires in the real client once ready.
const { setClient: setVoiceServerClient, addInitError } = require('./voice-server');

// ── DM History Logger —————————————————————————————————————————————
// Logs all DMs (inbound + outbound) to a rolling JSONL file.
// Used by /chat-history when fetchMessages() fails due to Puppeteer issues.
const _fs = require('fs');
const DM_HISTORY_PATH = require('path').join(__dirname, '../data/dm-history.jsonl');
const DM_HISTORY_MAX_LINES = 500;

function appendDMHistory(entry) {
  try {
    const line = JSON.stringify({ ...entry, logged: Date.now() }) + '\n';
    _fs.appendFileSync(DM_HISTORY_PATH, line, 'utf8');
    // Trim to last MAX_LINES entries
    try {
      const content = _fs.readFileSync(DM_HISTORY_PATH, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      if (lines.length > DM_HISTORY_MAX_LINES) {
        _fs.writeFileSync(DM_HISTORY_PATH, lines.slice(-DM_HISTORY_MAX_LINES).join('\n') + '\n', 'utf8');
      }
    } catch (_) {}
  } catch (e) {
    logger.error({ component: 'DMHistory', err: e.message }, 'append failed');
  }
}

module.exports._appendDMHistory = appendDMHistory; // exposed for voice-server
// Immediately export so voice-server can call it before module.exports is set
if (!global._appendDMHistory) global._appendDMHistory = appendDMHistory;

let client = null;
let masterGroupId = null;
let _backlogCutoffMs = 0; // messages older than this timestamp are considered backlog (set on reconnect)
const isBacklogMessage = (timestampMs) => timestampMs < _backlogCutoffMs;

// Reconnection loop protection (module-level so it persists across reinitialization)
let _readyFailureCount = 0;
let _lastActivityMs = Date.now();
const MAX_READY_FAILURES = 5;

// ISSUE-021: Disconnect / reconnect tracking (module-level so it survives re-init)
let _lastDisconnectMs = 0;      // set when disconnected event fires
let _disconnectedSinceMs = 0;  // non-zero while bot is offline
let _reconnectAttempts = 0;
let _reconnectTimer = null;     // active reconnect setTimeout
let _watchdogStarted = false;   // prevent duplicate watchdog intervals
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY_MS = 30_000; // 30s initial delay
const getHealthState = () => {
  let watchdogState = null;
  try { watchdogState = require('./watchdog').getState(); } catch (_) {}
  return {
    whatsapp_connected: !!(client && client.info),
    last_activity_ms: _lastActivityMs,
    ready_failure_count: _readyFailureCount,
    uptime_s: Math.round(process.uptime()),
    watchdog: watchdogState,
  };
};

// Rolling conversation history for master group (last 20 messages — in-memory fallback)

const masterGroupHistory = []; // { role: 'user'|'assistant', content: string }

// ── Babysitter Booking microservice integration ──────────────────────────────
const { getBabysitterPhones, resolveJids: resolveJidsForBabysitters, getPhoneByJid, setWaClient: setBabysitterWaClient, checkOnboarding: checkBabysitterOnboarding, handleOnboardingReply } = require('./babysitter-onboarding');
const BOOKING_SECRET = process.env.SHARED_SECRET || '';

async function forwardToBabysitterService(from_phone, body, ts) {
  const http = require('http');
  const payload = JSON.stringify({ from_phone, body, ts });
  return new Promise((resolve) => {
    const req = http.request({ hostname: 'localhost', port: 3002, path: '/inbound',
      method: 'POST', headers: { 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload), 'x-shared-token': BOOKING_SECRET } }, (res) => {
      res.resume(); resolve();
    });
    req.on('error', resolve);
    req.setTimeout(5000, () => { req.destroy(); resolve(); });
    req.write(payload); req.end();
  });
}

const MAX_HISTORY = 20;

function addToHistory(role, content, userId = null) {
  masterGroupHistory.push({ role, content, timestamp: Date.now() });
  if (masterGroupHistory.length > MAX_HISTORY) masterGroupHistory.shift();
  // Phase 2: also persist to DB when flag enabled
  if (config.FEATURE_CONVERSATION_HISTORY && userId) {
    try { addToConversationHistory(userId, role, content); } catch (_) {}
  }
}

/** Get history — DB-backed when flag on, in-memory otherwise. */
function getHistory(userId = null, limit = 10) {
  if (config.FEATURE_CONVERSATION_HISTORY && userId) {
    try {
      return getConversationHistory(userId, limit).map(r => ({ role: r.role, content: r.content }));
    } catch (_) {}
  }
  return masterGroupHistory.slice(-limit);
}

// processedMessageIds persisted to DB — no in-memory Set needed

// Phase 3: confirmation approval / rejection patterns
const APPROVE_REGEX = /^(\u2705|כן|אישור|בסדר|אשר|אוקי|ok|yes|approved|👍)$/i;
const REJECT_REGEX  = /^(\u274c|לא|בטל|עזוב|ביטול|cancel|no|נהי)$/i;

/** Format a human-readable date/time string from ISO or date-only */
function formatEventDateTime(start_time) {
  if (!start_time) return '';
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(start_time.trim()) || start_time.includes('T00:00:00');
  if (isDateOnly) {
    return new Date(start_time).toLocaleDateString('he-IL', { timeZone: config.TIMEZONE, day: 'numeric', month: 'numeric', year: 'numeric' });
  }
  return new Date(start_time).toLocaleString('he-IL', { timeZone: config.TIMEZONE, day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Build a Hebrew confirmation prompt for ADD_EVENT */
function buildEventConfirmationText(events) {
  const lines = events.map(e => {
    const dt = formatEventDateTime(e.start_time);
    const who = e.calendar_owner === 'aviv' ? ' (אביב בלבד)' : e.calendar_owner === 'liat' ? ' (ליאת בלבד)' : '';
    return `• ${e.title}${dt ? ` – ${dt}` : ''}${who}`;
  });
  return `להוסיף ליומן?\n${lines.join('\n')}\n\n✅ אישור | ❌ ביטול`;
}

/** Build a Hebrew confirmation prompt for ADD_TASK */
function buildTaskConfirmationText(actionItems) {
  const lines = actionItems.map(item => {
    const due = item.due_date ? ` (עד ${item.due_date.substring(0, 10)})` : '';
    return `• ${item.description.split('\n')[0].trim().substring(0, 80)}${due}`;
  });
  return `לרשום משימה?\n${lines.join('\n')}\n\n✅ אישור | ❌ ביטול`;
}

/** Execute a stored pending action after user confirmation */
async function executePendingAction(pending, userId, senderName) {
  const { action_type, params } = pending;
  try {
    if (action_type === 'ADD_EVENT') {
      const { events } = params;
      const confirmLines = [];
      for (const event of events) {
        const owner = event.calendar_owner || 'both';
        try {
          const gcalEvent = await addSharedEvent(event, owner);
          if (gcalEvent) { scheduleRemindersForEvent(gcalEvent, owner); scheduleFollowUpForEvent(gcalEvent, owner); }
        } catch (e) {
          logger.error({ component: 'Confirm', err: e.message }, 'addSharedEvent error');
        }
        const dt = formatEventDateTime(event.start_time);
        confirmLines.push(`• ${event.title}${dt ? ` – ${dt}` : ''}`);
      }
      const msg = `✅ הוספתי ליומן!\n${confirmLines.join('\n')}`;
      await sendToMasterGroup(msg);
      addToHistory('assistant', msg, userId);

    } else if (action_type === 'ADD_TASK') {
      const { actionItems, body: taskBody, senderName: sender } = params;
      const msgId = saveMessage({ group_id: masterGroupId, sender: sender || senderName, body: taskBody || '', timestamp: Date.now() });
      recordMessagePersisted();
      const lines = [];
      for (const item of actionItems) {
        saveActionItem({ message_id: msgId, description: item.description, due_date: item.due_date });
        lines.push(`• ${item.description.split('\n')[0].trim().substring(0, 80)}`);
      }
      const msg = `✅ רשמתי!\n${lines.join('\n')}`;
      await sendToMasterGroup(msg);
      addToHistory('assistant', msg, userId);

    } else if (action_type === 'CAPABILITY_APPROVE') {
      const { title, description } = params;
      const id = saveCapabilityRequest({ title, description });
      const msg = `✅ שמרתי את הבקשה (#${id}):\n*${title}*\n\nאעדכן אותך כשזה יהיה מוכן 🛠️`;
      await sendToMasterGroup(msg);
      addToHistory('assistant', msg, userId);
      // Notify developer (Aviv) on his personal number that a new capability was requested
      try {
        await client.sendMessage(`${config.AVIV_PHONE}@c.us`,
          `🛠️ בקשת יכולת חדשה לטודט:\n*${title}*\n${description}\n\n(בקשה #${id} — נשמרה ב-DB)`
        );
      } catch (_) {}

    } else if (action_type === 'CANCEL_RECURRING') {
      const { group_key, description } = params;
      const cancelled = cancelRecurringGroup(group_key);
      const msg = cancelled > 0
        ? `✅ הפסקתי לבדוק — "${(description || '').substring(0, 60)}"`
        : `אין בדיקות פעילות לביטול.`;
      await sendToMasterGroup(msg);
      addToHistory('assistant', msg, userId);

    } else if (action_type === 'CAPABILITY_CLARIFY') {
      // This shouldn't be "executed" as an approval — it's a mid-clarification step
      // When user replies, it goes through the normal query flow with conversation history
      logger.info({ component: 'Confirm' }, 'CAPABILITY_CLARIFY resolved via normal query path');

    } else {
      logger.warn({ component: 'Confirm', action_type }, 'Unknown pending action type');
    }
  } catch (e) {
    logger.error({ component: 'Confirm', err: e.message }, 'executePendingAction error');
    await sendToMasterGroup('הייתה שגיאה בביצוע הפעולה — נסו שוב.');
  }
}

/**
 * Map of bot question msg ID â†' group ID for pending "new group" questions sent to master group.
 */
const pendingGroupQuestions = new Map();

// Restore persistent pending group questions from DB on startup
/**
 * Compute the next Unix timestamp for a given time-of-day (HH:MM) in Israel timezone.
 * If that time has already passed today, returns tomorrow at that time.
 */
function nextOccurrenceOf(timeOfDay) {
  const tz = config.TIMEZONE || 'Asia/Jerusalem';
  const now = new Date();
  const [hh, mm] = (timeOfDay || '20:00').split(':').map(Number);
  // Build today at the target time in Israel TZ
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
  const candidate = new Date(`${todayStr}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00`);
  // Adjust for TZ offset
  const tzOffset = new Date(candidate.toLocaleString('en-US', { timeZone: tz })).getTime() - candidate.getTime();
  const adjusted = new Date(candidate.getTime() - tzOffset);
  if (adjusted.getTime() <= now.getTime()) {
    // Already passed today — schedule for tomorrow
    adjusted.setDate(adjusted.getDate() + 1);
  }
  return adjusted.getTime();
}

/**
 * Schedule a single recurring bot task occurrence.
 * When it fires, if still active, reschedules the next occurrence.
 */
function scheduleRecurringTask(task) {
  const { id, check_in_message, interval_ms, time_of_day, stop_on_confirm, group_key } = task;
  const delayMs = Math.max(0, task.run_at - Date.now());

  setTimeout(async () => {
    if (!claimBotTask(id)) return; // already done/cancelled

    // Send the check-in message
    await sendToMasterGroup(check_in_message);
    logger.info({ component: 'BotTask', group_key }, 'Recurring fired: %s', check_in_message.substring(0, 60));

    // If stop_on_confirm, don't auto-reschedule — user must reply to stop it,
    // but we reschedule the next occurrence now (it will be cancelled if user confirms)
    if (group_key && isRecurringGroupActive(group_key)) {
      const nextRunAt = time_of_day
        ? nextOccurrenceOf(time_of_day) + (86400000) // next day at same time
        : Date.now() + interval_ms;
      const nextId = saveBotTask({
        description: task.description,
        check_in_message,
        run_at: nextRunAt,
        recurring: 1,
        interval_ms,
        time_of_day,
        stop_on_confirm,
        group_key,
      });
      scheduleRecurringTask({ ...task, id: nextId, run_at: nextRunAt });
    }
  }, delayMs);
}

function loadPendingGroupQuestionsFromDB() {
  const rows = getAllPendingGroupQuestions();
  for (const row of rows) {
    pendingGroupQuestions.set(row.msg_id, row.group_id);
  }
  if (rows.length > 0) logger.info({ component: 'WhatsApp', count: rows.length }, 'Restored pending group questions from DB');
}

/**
 * Load monitored groups and master group from config/groups.json - cached
 */
let _groupsConfigCache = null;
const _groupsConfigPath = path.join(__dirname, '..', 'config', 'groups.json');
try { fs.watch(_groupsConfigPath, () => { _groupsConfigCache = null; }); } catch (_) {}

function loadGroupsConfig() {
  if (!_groupsConfigCache) {
    try {
      _groupsConfigCache = JSON.parse(fs.readFileSync(_groupsConfigPath, 'utf8'));
    } catch (err) {
      logger.warn({ component: 'WhatsApp', err: err.message }, 'Could not load groups.json');
      return { monitored: [], master: '' };
    }
  }
  return _groupsConfigCache;
}

/**
 * Resolve the chat ID for the master group by name.
 */
async function resolveMasterGroup() {
  // Fast path: JID already known from env — skip getChats() entirely
  if (config.MASTER_GROUP_JID) {
    masterGroupId = config.MASTER_GROUP_JID;
    logger.info({ component: 'WhatsApp', masterGroupId }, 'Master group resolved from config JID');
    return;
  }

  const groupsConfig = loadGroupsConfig();
  const masterName = groupsConfig.master || config.MASTER_GROUP_NAME;

  if (!masterName) return;

  const chats = await client.getChats();
  for (const chat of chats) {
    if (chat.isGroup && chat.name === masterName) {
      masterGroupId = _ser(chat.id);
      logger.info({ component: 'WhatsApp', masterName, masterGroupId }, 'Master group resolved');
      return;
    }
  }
  logger.warn({ component: 'WhatsApp', masterName }, 'Master group not found in chat list');
}

/**
 * Determine if a message is from a monitored group.
 */
async function isMonitoredGroup(msg) {
  // Use msg.from directly — avoids msg.getChat() Puppeteer call that throws 'r' error
  const groupId = msg.from;
  if (!groupId || !groupId.endsWith('@g.us')) return false;

  // Check DB: any group with related_to='monitored' is monitored
  const groupRecord = getGroup(groupId);
  if (groupRecord && groupRecord.related_to === 'monitored') return true;

  // Fallback: check static groups.json by name (requires getChat, wrap safely)
  try {
    const chat = await msg.getChat();
    const groupsConfig = loadGroupsConfig();
    const monitored = groupsConfig.monitored || [];
    return monitored.includes(chat.name);
  } catch (_) {
    return false;
  }
}

/**
 * Handle a message from a monitored group.
 */
async function handleGroupMessage(msg, { alreadySaved = false } = {}) {
  try {
    const chat = await msg.getChat();
    const contact = await msg.getContact();
    const groupId = _ser(chat.id);
    const sender = contact.pushname || contact.number || msg.from;

    // Resolve message body — for media, try to extract content
    const groupRecord = getGroup(groupId);
    let body = msg.body || '';
    // Attachment types worth extracting even when the message also carries caption text
    // (e.g. a teacher captions an image with "מצ\"ב מכתב" and attaches the actual letter).
    const alwaysMediaTypes = ['image', 'sticker', 'document', 'audio', 'ptt'];
    const isMedia = alwaysMediaTypes.includes(msg.type)
      || (!body.trim() && ['video', 'location', 'vcard'].includes(msg.type));
    const isImageMsg = isMedia && (msg.type === 'image' || msg.type === 'sticker');
    if (isMedia) {
      // Archive ALL media attachments to disk for retry/retroactive access
      let archived = null;
      try {
        archived = await archiveMedia(msg, groupId, chat.name);
      } catch (archErr) {
        logger.warn({ component: 'WhatsApp', group: chat.name, err: archErr.message }, 'Media archive failed (non-blocking)');
      }

      const captionText = (msg.body || '').trim();
      let mediaProcessed = false;
      let mediaError = null;

      if (isImageMsg) {
        const caption = captionText ? ` (caption: ${captionText.substring(0, 100)})` : '';
        // Process images from ALL groups (not just school) — ISSUE-2026-08-24
        logger.info({ component: 'WhatsApp', group: chat.name }, 'Processing image attachment');
        const described = await processMediaMessage(msg, groupRecord, chat.name, { forceVision: true }).catch((e) => { mediaError = e.message; return null; });
        body = described ? `${described}${caption}` : `[תמונה${caption}]`;
        // A bare '[תמונה]' means vision + OCR both returned nothing — treat as
        // unreadable so it gets flagged for retry (not silently "processed").
        mediaProcessed = !!described && described !== '[תמונה]';
        if (mediaProcessed) logger.info({ component: 'WhatsApp', ocrPreview: described.substring(0, 80) }, 'Image OCR result');
        else mediaError = mediaError || 'vision/OCR returned no text';
      } else if (msg.type === 'video') {
        // Archived only; no text extraction expected — not a failure.
        body = captionText || '[וידאו]';
        mediaProcessed = true;
      } else if (['document', 'audio', 'ptt'].includes(msg.type)) {
        const extracted = await processMediaMessage(msg, groupRecord, chat.name).catch((e) => { mediaError = e.message; return null; });
        // parseDocument returns '[... — לא הצלחתי לקרוא]' when a parser errors — that's a failure worth retrying.
        const ok = extracted && !/לא הצלחתי לקרוא/.test(extracted);
        if (ok) {
          body = extracted;
          mediaProcessed = true;
          logger.info({ component: 'WhatsApp', group: chat.name, preview: extracted.substring(0, 80) }, 'Media extracted');
        } else {
          const mediaLabel = { audio: '[הקלטה קולית]', ptt: '[הקלטה קולית]', document: '[מסמך]' };
          body = mediaLabel[msg.type] || '[מדיה]';
          mediaError = mediaError || 'extraction returned no content';
        }
      } else {
        // location / vcard — no content extraction, nothing to archive/retry.
        const mediaLabel = { location: '[מיקום]', vcard: '[איש קשר]' };
        body = mediaLabel[msg.type] || '[מדיה]';
      }

      // Track media status in DB (applied after messageId is assigned below).
      // location/vcard aren't archivable attachments → don't track them.
      const isArchivableType = ['image', 'sticker', 'document', 'audio', 'ptt', 'video'].includes(msg.type);
      if (isArchivableType) {
        msg._mediaTrack = {
          type: msg.type,
          path: archived ? archived.path : null,
          status: mediaProcessed ? 'processed' : 'failed',
          error: mediaProcessed ? null : mediaError,
          failed: !mediaProcessed,
          caption: captionText,
        };
      }
    }

    // Shared links — a Google Docs/Sheets/Slides/Drive URL arrives as a plain
    // text message (not an attachment). Fetch and append the content so the
    // agent classifies on the actual document, not just the bare link.
    // Runs for text messages too (after the media block above).
    const GOOGLE_URL_REGEX = /https?:\/\/(?:docs|drive)\.google\.com\/\S+/i;
    const googleLinkMatch = body.match(GOOGLE_URL_REGEX);
    if (googleLinkMatch) {
      try {
        const linkContent = await extractFromUrl(googleLinkMatch[0], chat.name);
        if (linkContent) {
          body = body.trim() ? `${body}\n${linkContent}` : linkContent;
          logger.info({ component: 'WhatsApp', group: chat.name, preview: linkContent.substring(0, 80) }, 'Google link content extracted');
        }
      } catch (e) {
        logger.warn({ component: 'WhatsApp', group: chat.name, err: e.message }, 'Google link extraction failed (non-blocking)');
      }
    }

    // Save to DB (skip if caller already saved to avoid duplicates)
    let messageId;
    if (!alreadySaved) {
      messageId = saveMessage({ group_id: groupId, sender, body, timestamp: msg.timestamp * 1000 });
      recordMessagePersisted();
    } else {
      // Update the already-saved row with the extracted body if we got real content
      const row = getDB().prepare('SELECT id FROM messages WHERE group_id=? AND timestamp=? ORDER BY id DESC LIMIT 1').get(groupId, msg.timestamp * 1000);
      messageId = row ? row.id : null;
      if (messageId && isMedia && body !== '[מדיה]' && body !== '[תמונה]' && body !== '[מסמך]') {
        getDB().prepare('UPDATE messages SET body=? WHERE id=?').run(body, messageId);
      }
    }

    // Track media processing status in DB
    if (messageId && msg._mediaTrack) {
      try {
        updateMessageMedia(messageId, {
          media_type: msg._mediaTrack.type,
          media_path: msg._mediaTrack.path,
          media_status: msg._mediaTrack.status,
          media_error: msg._mediaTrack.error
        });
      } catch (_) {}
    }

    logger.info({ component: 'WhatsApp', group: chat.name, sender, bodyPreview: body.substring(0, 60) }, 'Message from group');

    // Build group context for agent
    const groupDescription = (groupRecord && groupRecord.description) ? groupRecord.description : null;

    // Fetch recent messages from this group for context (exclude the current message)
    const recentMessages = messageId
      ? getRecentGroupMessages(groupId, 20).filter(m => {
          // Exclude the message we just saved (it's the current one)
          const bodyMatch = m.body === body && Math.abs(m.timestamp - (msg.timestamp * 1000)) < 5000;
          return !bodyMatch;
        })
      : getRecentGroupMessages(groupId, 20);

    // Event/task extraction — save to DB only; Lipa (OpenClaw) handles surfacing to master group
    const msgIsBacklog = isBacklogMessage(msg.timestamp * 1000);

    // ISSUE-018: Skip notice extraction for messages sent by Aviv or Liat themselves.
    // Their own messages should never be re-broadcast to the master group.
    const senderNumber = (contact.number || '').replace(/\D/g, '');
    const ownerPhones = [config.AVIV_PHONE, config.LIAT_PHONE].map(p => String(p).replace(/\D/g, ''));
    if (ownerPhones.includes(senderNumber)) {
      logger.info({ component: 'WhatsApp', group: chat.name, sender }, 'Skipping notice extraction for owner message');
      if (messageId) markMessageTerminal(messageId, 'NOT_ACTIONABLE', 'owner message');
      return;
    }

    // Media extraction failed — surface a notice with what we know (caption,
    // group, sender) and leave the message flagged for retry. We NEVER ask the
    // family to open the attachment themselves; the /media/retry job will keep
    // trying, and the archived file lets us answer "מה במכתב?" retroactively.
    if (messageId && msg._mediaTrack && msg._mediaTrack.failed) {
      try {
        const t = msg._mediaTrack;
        const typeLabelHe = { document: 'מסמך', audio: 'הקלטה', ptt: 'הקלטה קולית', image: 'תמונה', sticker: 'תמונה', video: 'סרטון' }[t.type] || 'קובץ';
        const capPart = t.caption ? ` כיתוב: "${t.caption.substring(0, 120)}".` : '';
        const noticeContent = `📎 הגיע ${typeLabelHe} מ-${sender} בקבוצה "${chat.name}" שעדיין לא הצלחתי לקרוא.${capPart} אנסה שוב אוטומטית בקרוב ואעדכן.`;
        saveNotice({
          group_name: chat.name,
          content: noticeContent,
          relevance_date: new Date(msg.timestamp * 1000).toLocaleDateString('en-CA', { timeZone: config.TIMEZONE || 'Asia/Jerusalem' }),
          source_timestamp: msg.timestamp * 1000,
          message_timestamp: msg.timestamp * 1000,
          urgency_hint: 'routine',
        });
        logger.warn({ component: 'WhatsApp', group: chat.name, type: t.type, err: t.error }, 'Media unreadable — notice created, flagged for retry');
      } catch (e) {
        logger.error({ component: 'WhatsApp', err: e.message }, 'Failed to create media-failure notice');
      }
    }

    const agentResult = await handleGroupEvent(body, chat.name, sender, groupDescription, recentMessages, msg.timestamp * 1000, isImageMsg, msgIsBacklog, groupRecord?.primary_child || null, messageId);

    // If agent decided this image is worth reading, run vision now and upsert the notice
    if (isImageMsg && agentResult.downloadImage) {
      logger.info({ component: 'WhatsApp', group: chat.name, sender }, 'Agent requested image download');
      try {
        const described = await processMediaMessage(msg, groupRecord, chat.name, { forceVision: true });
        if (described) {
          logger.info({ component: 'WhatsApp', preview: described.substring(0, 100) }, 'Image described');
          if (messageId && described !== '[תמונה]') setMediaStatus(messageId, 'processed', null);
          // Try UPDATE first (old path: agent also saved a notice)
          const updated = getDB().prepare(
            'UPDATE notices SET content = ? WHERE source_timestamp = ? AND group_name = ? AND dismissed = 0'
          ).run(described, msg.timestamp * 1000, chat.name);
          // ISSUE-019: With tool calling, agent may only call download_image without add_notice.
          // If UPDATE found no row, INSERT a new notice with the described content.
          if (updated.changes === 0) {
            saveNotice({
              group_name: chat.name,
              content: described,
              relevance_date: new Date(msg.timestamp * 1000).toLocaleDateString('en-CA', { timeZone: config.TIMEZONE || 'Asia/Jerusalem' }),
              source_timestamp: msg.timestamp * 1000,
              urgency_hint: 'routine',
            });
            logger.info({ component: 'WhatsApp', group: chat.name }, 'Image notice created (new)');
            if (messageId) markMessageTerminal(messageId, 'NOTICE_CREATED', null, null);
          }
        }
      } catch (e) {
        logger.error({ component: 'WhatsApp', err: e.message }, 'Vision post-processing error');
      }
    }

  } catch (err) {
    logger.error({ component: 'WhatsApp', err: err.message }, 'handleGroupMessage error');
  }
}

// Authorized identifiers - phone numbers OR WhatsApp LIDs (new privacy format)
const ALLOWED_NUMBERS = new Set([
  config.AVIV_PHONE, // primary parent phone
  config.LIAT_PHONE, // secondary parent phone
]);

async function isSenderAuthorized(msg) {
  try {
    const contact = await msg.getContact();
    // contact.number may be a string or number - coerce to string
    const number = String(contact.number || '').trim();
    if (number && ALLOWED_NUMBERS.has(number)) return true;
    // For @c.us JIDs, check the user part directly
    const senderJid = msg.author || msg.from || '';
    const authorUser = senderJid.split('@')[0].trim();
    if (!senderJid.endsWith('@lid') && authorUser && ALLOWED_NUMBERS.has(authorUser)) return true;
    // For @lid JIDs, resolve to phone via signalRepository
    if (senderJid.endsWith('@lid')) {
      try {
        const resolvedPhone = await getPhoneByJid(senderJid);
        if (resolvedPhone) {
          const phoneNum = resolvedPhone.replace(/^\+/, '');
          if (ALLOWED_NUMBERS.has(phoneNum)) return true;
        }
      } catch (e) {
        logger.warn({ component: 'WhatsApp', err: e.message, lid: senderJid }, 'LID resolution failed in auth check');
      }
    }
    // Log the actual ID so we can diagnose mismatches
    logger.warn({ component: 'WhatsApp', senderId: senderJid, number }, 'Unauthorized sender');
    return false;
  } catch (e) {
    logger.warn({ component: 'WhatsApp', err: e.message }, 'Could not resolve sender contact');
    return false;
  }
}

/**
 * Check if a message in the master group is directed at the bot.
 * Returns true if the message mentions the bot by name/alias or is a reply to the bot.
 */
function isAddressedToBot(body, quotedFromMe) {
  if (quotedFromMe) return true; // reply to bot's own message
  const lower = body.toLowerCase();
  const botName = config.BOT_NAME.toLowerCase();
  const botAlt = config.BOT_NAME_ALT.toLowerCase();
  return lower.includes(botName) || lower.includes(botAlt);
}

/**
 * Master group command handling — DISABLED.
 * All master group conversation is now handled by Lipa (OpenClaw).
 * This bot (Tudat) only posts scheduled automations (reminders, digest, check-ins).
 * The function is kept as a no-op stub because it's still referenced by message routing.
 */
async function handleMasterGroupCommand(_msg) {
  // OpenClaw handles most master group conversation. A couple of explicit
  // group-monitoring commands are handled deterministically here:
  //   "נטר <שם קבוצה>"   → start monitoring matching groups
  //   "התעלם <שם קבוצה>" → stop monitoring / ignore matching groups
  const body = (_msg && _msg.body ? _msg.body : '').trim();
  if (!body) return;

  const monitorMatch = body.match(/^נטר\s+(.+)$/);
  const ignoreMatch  = body.match(/^התעלם\s+(.+)$/);
  if (!monitorMatch && !ignoreMatch) return;

  const groupName = (monitorMatch ? monitorMatch[1] : ignoreMatch[1]).trim();
  const relatedTo = monitorMatch ? 'monitored' : 'ignored';
  try {
    const rows = getDB().prepare('SELECT id, name FROM groups WHERE name LIKE ?').all(`%${groupName}%`);
    if (rows.length === 0) {
      await sendToMasterGroup(`❓ לא מצאתי קבוצה בשם: ${groupName}`);
      return;
    }
    for (const r of rows) setGroupRelatedTo(r.id, relatedTo);
    const header = monitorMatch
      ? `✅ מתחיל לנטר קבוצות שמכילות: ${groupName}`
      : `✅ מתעלם מקבוצות שמכילות: ${groupName}`;
    await sendToMasterGroup(`${header}\n${rows.map(r => `• ${r.name}`).join('\n')}`);
    logger.info({ component: 'WhatsApp', groupName, relatedTo, matched: rows.length }, 'monitor/ignore command applied');
  } catch (e) {
    logger.error({ component: 'WhatsApp', err: e.message }, 'monitor/ignore command error');
  }
}

/**
 * On startup: replay any unprocessed commands from the master group (last 2 hours).
 * Catches commands that arrived while the bot was down/restarting.
 */
async function replayMasterGroupCommands() {
  if (!masterGroupId) return;
  try {
    const masterChat = await client.getChatById(masterGroupId);
    if (!masterChat) return;

    const msgs = await masterChat.fetchMessages({ limit: 50 });
    const cutoff = Date.now() - 2 * 60 * 60 * 1000; // last 2 hours
    let replayed = 0;

    for (const msg of msgs) {
      const msgTs = msg.timestamp * 1000;
      if (msgTs < cutoff) continue;
      if (msg.fromMe) continue; // skip bot's own messages
      const msgId = _ser(msg.id);
      if (isMessageProcessed(msgId)) continue; // already handled
      markMsgProcessed(msgId);
      logger.info({ component: 'WhatsApp', bodyPreview: (msg.body || '').substring(0, 60) }, 'Replaying missed master command');
      await handleMasterGroupCommand(msg);
      replayed++;
    }

    if (replayed > 0) {
      logger.info({ component: 'WhatsApp', replayed }, 'Replayed missed master group commands');
    }
  } catch (err) {
    logger.error({ component: 'WhatsApp', err: err.message }, 'replayMasterGroupCommands error');
  }
}

/**
 * Scan the last 72 hours of messages from a group chat and process them.
 */
async function scanGroupHistory(chat, { saveDays = 7, parseDays = 1 } = {}) {
  try {
    const fetchLimit = saveDays > 7 ? 500 : 200;
    const msgs = await chat.fetchMessages({ limit: fetchLimit });
    // Save up to saveDays for context; parse+act on last parseDays
    const saveCutoff  = Date.now() - (saveDays  * 24 * 60 * 60 * 1000);
    const parseCutoff = Date.now() - (parseDays * 24 * 60 * 60 * 1000);
    let scanned = 0;
    let saved = 0;
    let skippedProcessed = 0;

    logger.info({ component: 'WhatsApp', group: chat.name, fetched: msgs.length }, 'History scan started');

    const groupId = _ser(chat.id);

    for (const msg of msgs) {
      const msgTs = msg.timestamp * 1000;
      if (msgTs < saveCutoff) continue;
      if (msg.fromMe) continue;

      const msgId = _ser(msg.id);
      const contact = await msg.getContact().catch(() => null);
      const sender = contact?.pushname || contact?.number || msg.author || 'unknown';

      // Resolve body — use placeholder for media messages
      let body = msg.body || '';
      if (!body.trim()) {
        const mediaLabel = { image: '[תמונה]', video: '[וידאו]', audio: '[הקלטה קולית]', document: '[מסמך]', sticker: '[מדבקה]', location: '[מיקום]' };
        body = mediaLabel[msg.type] || '[מדיה]';
      }

      // Always save to DB for context
      saveMessage({ group_id: groupId, sender, body, timestamp: msgTs });
      recordMessagePersisted();
      saved++;

      // Only parse+act on recent messages we haven't processed
      if (msgTs < parseCutoff) continue;
      if (isMessageProcessed(msgId)) { skippedProcessed++; continue; }
      markMsgProcessed(msgId);
      await handleGroupMessage(msg, { alreadySaved: true });
      scanned++;
    }

    logger.info({ component: 'WhatsApp', group: chat.name, scanned, saved, skippedProcessed }, 'History scan complete');
  } catch (err) {
    logger.error({ component: 'WhatsApp', group: chat.name, err: err.message }, 'scanGroupHistory error');
  }
}

/**
 * Internal: validate → repair (LLM) → minimal fallback → DM Aviv pipeline.
 * Returns { ok: true, text: <finalText> } if message can be sent,
 * or handles the DM Aviv step and returns { ok: false }.
 */
async function applyRepairPipeline(text) {
  // Step 1: validate
  let v = validateOutgoing(text);
  if (v.ok) return { ok: true, text };

  logger.warn({ component: 'OutgoingGate', reason: v.reason, original: text.substring(0, 200) }, 'Message failed validation');

  // Step 2: repair via LLM
  const repaired = await repairMessage(text, v.reason).catch(() => null);
  if (repaired) {
    const vr = validateOutgoing(repaired);
    if (vr.ok) {
      logger.info({ component: 'OutgoingGate', preview: repaired.substring(0, 100) }, 'Sending repaired message');
      return { ok: true, text: repaired };
    }
  }

  // Step 3: minimal fallback — strip tags + cap at 100 chars
  const timeMatch = text.match(/\d{1,2}:\d{2}/);
  const fallbackBase = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().substring(0, 100);
  const fallback = timeMatch ? `💡 ${fallbackBase}` : null;
  if (fallback && validateOutgoing(fallback).ok) {
    logger.info({ component: 'OutgoingGate', fallback }, 'Sending fallback');
    return { ok: true, text: fallback };
  }

  // Step 4: DM Aviv — never lose information silently
  const avivJid = `${config.AVIV_PHONE}@c.us`;
  const dmText = `⚠️ ניסיתי לשלוח לקבוצה אבל ההודעה לא עברה בדיקת איכות.\nסיבה: ${v.reason}\n\nתוכן גולמי:\n${text.substring(0, 300)}`;
  logger.warn({ component: 'OutgoingGate' }, 'All repair attempts failed. DMing Aviv.');
  if (client) {
    await client.sendMessage(avivJid, dmText).catch(e => logger.error({ component: 'OutgoingGate', err: e.message }, 'DM also failed'));
  }
  return { ok: false };
}

/**
 * Send a message to the master group.
 */
function logOutgoingDM(jid, text) {
  try {
    // Log messages sent to Aviv's DM (not master group)
    const avivJid = `${config.AVIV_PHONE}@c.us`;
    if (jid === avivJid || jid === config.AVIV_PHONE) {
      appendDMHistory({ jid: avivJid, fromMe: true, body: text, ts: Date.now(), type: 'chat' });
    }
  } catch (_) {}
}

async function sendToMasterGroup(text) {
  if (!client) {
    logger.warn({ component: 'WhatsApp' }, 'Client not initialized, cannot send message.');
    return;
  }

  if (!masterGroupId) {
    logger.warn({ component: 'WhatsApp' }, 'Master group not resolved yet, trying to resolve...');
    await resolveMasterGroup();
    if (!masterGroupId) {
      logger.warn({ component: 'WhatsApp', textPreview: text.substring(0, 60) }, 'Still no master group. Message not sent');
      return;
    }
  }

  const result = await applyRepairPipeline(text);
  if (!result.ok) return;
  try {
    await client.sendMessage(masterGroupId, result.text);
    logger.info({ component: 'WhatsApp', textPreview: result.text.substring(0, 60) }, 'Sent to master group');
    // Log outbound group message to dm-history.jsonl (used by /chat-history for group context)
    appendDMHistory({ jid: masterGroupId, fromMe: true, body: result.text, ts: Date.now(), type: 'chat' });
  } catch (err) {
    logger.error({ component: 'WhatsApp', err: err.message }, 'sendToMasterGroup error');
  }
}

/**
 * Send a message to the master group and return the WhatsApp message ID.
 * Used by the scheduler for follow-up tracking.
 */
async function sendToMasterGroupWithId(text) {
  if (!client || !masterGroupId) return null;
  const result = await applyRepairPipeline(text);
  if (!result.ok) return null;
  try {
    const sentMsg = await client.sendMessage(masterGroupId, result.text);
    return _ser(sentMsg.id);
  } catch (err) {
    logger.error({ component: 'WhatsApp', err: err.message }, 'sendToMasterGroupWithId error');
    return null;
  }
}

/**
 * Send a message to the master group with @mentions.
 * mentionIds: array of 'phonenumber@c.us' strings
 * Returns the sent message ID (for follow-up tracking).
 */
async function sendToMasterGroupWithMentions(text, mentionIds = []) {
  if (!client || !masterGroupId) return null;
  const result = await applyRepairPipeline(text);
  if (!result.ok) return null;
  try {
    const sentMsg = await client.sendMessage(masterGroupId, result.text, { mentions: mentionIds });
    logger.info({ component: 'WhatsApp', textPreview: result.text.substring(0, 60) }, 'Sent with mentions to master group');
    return _ser(sentMsg.id);
  } catch (err) {
    // Fallback to plain send if mentions not supported
    logger.warn({ component: 'WhatsApp', err: err.message }, 'Mentions failed, sending plain');
    try {
      const sentMsg = await client.sendMessage(masterGroupId, result.text);
      return _ser(sentMsg.id);
    } catch (e2) {
      logger.error({ component: 'WhatsApp', err: e2.message }, 'sendToMasterGroupWithMentions error');
      return null;
    }
  }
}

/**
 * Get all available WhatsApp groups.
 */
async function getGroups() {
  if (!client) return [];
  try {
    const chats = await client.getChats();
    return chats
      .filter(c => c.isGroup)
      .map(c => ({ id: _ser(c.id), name: c.name }));
  } catch (err) {
    logger.error({ component: 'WhatsApp', err: err.message }, 'getGroups error');
    return [];
  }
}

/**
 * ISSUE-021: Watchdog — detects prolonged disconnection during daytime and writes
 * /tmp/bot-stuck-alert.json so Lipa (OpenClaw heartbeat) can DM Aviv.
 * Started once; survives client reinitializations.
 */
/**
 * DEPRECATED: Old disconnect watchdog (ISSUE-021) — replaced by src/watchdog.js
 * which provides 3-layer zombie detection. Kept as no-op stub so callers don't break.
 */
function startDisconnectWatchdog() {
  logger.info({ component: 'Watchdog' }, 'Old disconnect watchdog disabled — replaced by 3-layer watchdog.js');
}

/**
 * Initialize the WhatsApp client.
 */
function initWhatsApp() {
  startDisconnectWatchdog(); // ISSUE-021: start once, guard against duplicate starts
  client = new BaileysClient();

  client.on('qr', (qr) => {
    logger.info({ component: 'WhatsApp' }, 'Scan the QR code below to connect');
    qrcode.generate(qr, { small: true });
    // Also save as PNG so it can be shared
    try {
      const QRCode = require('qrcode');
      QRCode.toFile('/tmp/whatsapp-qr.png', qr, { width: 400 }, (err) => {
        if (!err) logger.info({ component: 'WhatsApp' }, 'QR image saved to /tmp/whatsapp-qr.png');
      });
    } catch (_) {}
  });

  const { startReconciliation } = require('./groupReconciliation');

  client.on('disconnected', () => {
    _lastDisconnectMs = Date.now();
  });

  client.on('ready', async () => {
    // Set WA client ref immediately for LID resolution (before resolveJids delay)
    setBabysitterWaClient(client);
    // Mark reconnect point — messages older than this are backlog
    _backlogCutoffMs = Date.now() - 60000; // 1min grace for in-flight messages
    if (_lastDisconnectMs > 0) {
      const offlineMs = Date.now() - _lastDisconnectMs;
      logger.info({ component: 'WhatsApp', offlineMin: Math.round(offlineMs/60000), backlogCutoff: new Date(_backlogCutoffMs).toISOString() }, 'Reconnected after offline period');
    }
    // ISSUE-021: reset reconnect state on successful ready
    _disconnectedSinceMs = 0;
    _reconnectAttempts = 0;
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    // Remove stale stuck-alert file if we successfully reconnected
    try { require('fs').unlinkSync('/tmp/bot-stuck-alert.json'); } catch (_) {}
    logger.info({ component: 'WhatsApp' }, 'Client connected and ready');
    try {
      await resolveMasterGroup();
    } catch (resolveErr) {
      addInitError(resolveErr);
      logger.error({ component: 'WhatsApp', err: resolveErr.message }, 'resolveMasterGroup failed in ready handler — continuing init');
    }

    // ── Context prefetch on startup (ISSUE-022) ──────────────────────────────
    // Runs in a detached setTimeout so it cannot crash or delay the rest of startup.
    // Pre-fills dm-history.jsonl with the last 30 msgs from Aviv DM + master group
    // so /chat-history never returns zero right after a restart.
    setTimeout(async () => {
      try {
        const PREFETCH_LIMIT = 30;
        const chatsToPrefetch = [{ jid: `${config.AVIV_PHONE}@c.us`, label: 'Aviv DM' }];
        if (masterGroupId) chatsToPrefetch.push({ jid: masterGroupId, label: 'master group' });
        for (const { jid, label } of chatsToPrefetch) {
          try {
            const chat = await client.getChatById(jid);
            if (!chat) continue;
            const msgs = await chat.fetchMessages({ limit: PREFETCH_LIMIT });
            let written = 0;
            for (const m of msgs) {
              const ct = await m.getContact().catch(() => null);
              const senderName = (ct && (ct.pushname || ct.number)) || m.author || (m.fromMe ? 'bot' : 'unknown');
              appendDMHistory({ jid, fromMe: m.fromMe, phone: m.fromMe ? null : senderName, body: m.body || '', ts: m.timestamp * 1000, type: m.type });
              written++;
            }
            logger.info({ component: 'ContextPrefetch', label, written }, 'Wrote messages to dm-history.jsonl');
          } catch (e) { logger.warn({ component: 'ContextPrefetch', label, err: e.message }, 'Prefetch failed'); }
        }
      } catch (e) { logger.warn({ component: 'ContextPrefetch', err: e.message }, 'Top-level prefetch error'); }
    }, 5000);
    // ── End context prefetch ─────────────────────────────────────────────────

    // Check babysitter booking onboarding state + resolve JIDs
    setTimeout(() => {
      checkBabysitterOnboarding(sendToMasterGroup).catch(() => {});
      resolveJidsForBabysitters(client).catch(() => {});
    }, 8000);

    // Wire health monitor with client + master group
    try {
      const { initHealth } = require('./health');
      initHealth(client, masterGroupId);
    } catch (_) {}

    // Wire the (already-running) voice/health HTTP server to the live client
    try {
      setVoiceServerClient(client, getHealthState);
    } catch (_) { logger.error({ component: 'WhatsApp', err: _.message }, 'Failed to wire client into voice server'); }

    loadPendingGroupQuestionsFromDB();

    // Restore pending bot tasks from DB (survived restart)
    const pendingBotTasks = getPendingBotTasks();
    for (const task of pendingBotTasks) {
      const delay = Math.max(0, task.run_at - Date.now());
      const taskId = task.id;
      const taskMsg = task.check_in_message;
      setTimeout(async () => {
        if (claimBotTask(taskId)) {
          await sendToMasterGroup(taskMsg);
          console.log(`[BotTask] Fired on restore: "${taskMsg.substring(0, 60)}"`);
        }
      }, delay);
      console.log(`[BotTask] Scheduled: "${task.description.substring(0, 50)}" in ${Math.round(delay / 60000)}min`);
    }

    const groupsConfig = loadGroupsConfig();
    const monitoredNames = groupsConfig.monitored || [];
    const masterName = groupsConfig.master || config.MASTER_GROUP_NAME;

    // Get all group chats (with retry — whatsapp-web.js can fail on first attempt)
    let allChats = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        allChats = await client.getChats();
        break;
      } catch (chatErr) {
        console.warn(`[WhatsApp] getChats attempt ${attempt} failed:`, chatErr.message || String(chatErr));
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
    const groupChats = allChats.filter(c => c.isGroup);

    logger.info({ component: 'WhatsApp' }, 'Available groups:');
    groupChats.forEach(g => logger.info({ component: 'WhatsApp', groupName: g.name, groupId: _ser(g.id) }, 'Group'));

    // â"€â"€ Feature 2: New group detection â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    for (const chat of groupChats) {
      const chatId = _ser(chat.id);
      const existing = getGroup(chatId);

      if (!existing) {
        // New group â€" save it
        saveGroup(chatId, chat.name);
        logger.info({ component: 'WhatsApp', groupName: chat.name }, 'New group detected');

        const isMonitored = monitoredNames.includes(chat.name);
        const isMaster = chat.name === masterName;

        if (isMonitored || isMaster) {
          // Already known / configured â€" mark as configured immediately
          setGroupRelatedTo(chatId, isMonitored ? 'monitored' : 'master');
        } else if (masterGroupId) {
          // Unknown group â€" ask master group who it belongs to
          const question = `🆕 נוספתי לקבוצה חדשה: "${chat.name}"\nלמי הקבוצה קשורה? מעוניינים במעקב? (ענו בתגובה להודעה זו)`;
          try {
            const sentMsg = await client.sendMessage(masterGroupId, question);
            pendingGroupQuestions.set(_ser(sentMsg.id), chatId);
            savePendingGroupQuestion(_ser(sentMsg.id), chatId);
            addToHistory('assistant', question);
            logger.info({ component: 'WhatsApp', groupName: chat.name }, 'Asked master group about new group');
          } catch (err) {
            logger.error({ component: 'WhatsApp', err: err.message }, 'Failed to send new-group question');
          }
        }
      }
    }

    // ── Feature 2b: Re-ask about monitored groups with no description ───────
    if (masterGroupId) {
      const noDesc = getMonitoredGroupsWithoutDescription();
      for (const grp of noDesc) {
        const question = `❓ אני עוקב אחרי הקבוצה *${grp.name}* אבל אין לי הקשר עליה.\nלמי מהמשפחה היא קשורה? לאיזה ילד/פעילות? (ענו בתגובה)`;
        try {
          const sentMsg = await client.sendMessage(masterGroupId, question);
          pendingGroupQuestions.set(_ser(sentMsg.id), grp.id);
          savePendingGroupQuestion(_ser(sentMsg.id), grp.id);
          addToHistory('assistant', question);
          logger.info({ component: 'WhatsApp', groupName: grp.name }, 'Asked about group context');
        } catch (err) {
          logger.error({ component: 'WhatsApp', groupName: grp.name, err: err.message }, 'Failed to ask about group');
        }
        await new Promise(r => setTimeout(r, 1000)); // small delay between messages
      }
    }

    // ── Feature 1: Startup history scan ─────────────────────────────────────
    // Use DB-monitored groups (not just static groups.json list)
    const monitoredChats = groupChats.filter(c => {
      const rec = getGroup(_ser(c.id));
      return (rec && rec.related_to === 'monitored') || monitoredNames.includes(c.name);
    });
    for (const chat of monitoredChats) {
      await scanGroupHistory(chat);
    }

    // Replay any master group commands missed during downtime/restart
    await replayMasterGroupCommands();

    // Start group reconciliation (silent group detection + force-sync)
    startReconciliation(client, masterGroupId, scanGroupHistory);
  });

  client.on('authenticated', () => {
    logger.info({ component: 'WhatsApp' }, 'Authenticated.');

    // Watchdog: if ready doesn't fire within 2 minutes, the WA page is stuck.
    // Uses module-level _readyFailureCount so retries don't reset the counter.
    const readyWatchdog = setTimeout(async () => {
      _readyFailureCount++;
      const backoffMs = Math.min(_readyFailureCount * 5000, 30000); // 5s, 10s, 15s, 20s, 30s
      logger.error({ component: 'WhatsApp', attempt: _readyFailureCount, maxAttempts: MAX_READY_FAILURES, retrySec: backoffMs/1000 }, 'Ready event never fired');

      if (_readyFailureCount >= MAX_READY_FAILURES) {
        // Stop the loop — write flag file for Lipa to detect and DM Aviv out-of-band
        // (can't use sendAlertDirect — WhatsApp is the broken thing)
        logger.error({ component: 'WhatsApp', failures: _readyFailureCount }, 'Giving up after max failures. Writing alert flag for Lipa.');
        try {
          require('fs').writeFileSync('/tmp/bot-stuck-alert.json', JSON.stringify({
            ts: Date.now(),
            failures: _readyFailureCount,
            message: `Tudat stuck in reconnection loop (${_readyFailureCount} failed attempts). WhatsApp not responding. Check linked devices, may need QR re-scan.`
          }));
        } catch (flagErr) {
          logger.error({ component: 'WhatsApp', err: flagErr.message }, 'Failed to write alert flag');
        }
        return; // Stop reinitializing
      }

      try { await client.destroy(); } catch (_) {}
      setTimeout(() => initWhatsApp(), backoffMs);
    }, 2 * 60 * 1000);
    readyWatchdog.unref(); // don't keep process alive just for this

    // Cancel the watchdog and reset failure count once ready fires
    client.once('ready', () => {
      clearTimeout(readyWatchdog);
      _readyFailureCount = 0;
    });
  });

  // Detect when the bot is added to a new group (fires even with no text message)
  client.on('group_update', async (notification) => {
    try {
      console.log('[WhatsApp] group_update event:', JSON.stringify({
        type: notification.type,
        chatId: notification.chatId,
        author: notification.author,
      }));
    } catch (_) {}
  });

  client.on('group_join', async (notification) => {
    try {
      // Use getChatById — more reliable than notification.getChat() for group events
      const groupId = notification.chatId;
      if (!groupId || !groupId.endsWith('@g.us')) return;
      if (groupId === masterGroupId) return; // ignore master group itself

      // Retry up to 3 times with backoff (group metadata may not be available immediately)
      let chat = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          chat = await client.getChatById(groupId);
          if (chat) break;
        } catch (retryErr) {
          console.warn(`[WhatsApp] group_join getChatById attempt ${attempt} failed:`, retryErr.message || retryErr);
          if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
      const groupName = (chat && chat.name) || groupId;

      const existing = getGroup(groupId);
      if (!existing) {
        saveGroup(groupId, groupName);
        console.log(`[WhatsApp] Added to new group: "${groupName}" (${groupId})`);
        if (masterGroupId) {
          const question = `🆕 נוספתי לקבוצה חדשה: *${groupName}*\nלמי הקבוצה קשורה? מעוניינים במעקב? (ענו בתגובה להודעה זו)`;
          const sentMsg = await client.sendMessage(masterGroupId, question);
          if (sentMsg) {
            pendingGroupQuestions.set(_ser(sentMsg.id), groupId);
            savePendingGroupQuestion(_ser(sentMsg.id), groupId);
            addToHistory('assistant', question);
          }
        }
      } else if (existing.related_to !== 'monitored') {
        console.log(`[WhatsApp] Re-added to known group: "${groupName}"`);
      }
    } catch (err) {
      console.error('[WhatsApp] group_join handler error:', { message: err.message || String(err), code: err.code, stack: err.stack });
    }
  });

  client.on('auth_failure', (msg) => {
    logger.error({ component: 'WhatsApp', reason: msg }, 'Authentication failed');
    // ISSUE-009: log with timestamp so exact drop time is always visible
    const { checkAndAlert } = require('./health');
    checkAndAlert().catch(() => {});
  });

  client.on('disconnected', (reason) => {
    // ISSUE-009: log with ISO timestamp so the exact drop time is always visible in logs
    logger.warn({ component: 'WhatsApp', disconnectedAt: new Date().toISOString(), reason }, 'Client disconnected');

    // ISSUE-021: track disconnect time for watchdog
    _disconnectedSinceMs = _disconnectedSinceMs || Date.now();

    // Trigger health alert immediately (before client fully shuts down)
    const { sendAlertDirect } = require('./health');
    if (sendAlertDirect) {
      sendAlertDirect(`WhatsApp disconnected: ${reason}. Bot will stop receiving messages until re-linked.`).catch(() => {});
    }

    // ISSUE-021: Auto-reconnect with exponential backoff
    // Don't reconnect if we're in a QR/auth-needed state (LOGOUT or auth_failure)
    const noReconnectReasons = ['LOGOUT', 'CONFLICT', 'UNLAUNCHED'];
    if (noReconnectReasons.includes(reason)) {
      logger.warn({ component: 'WhatsApp', reason }, 'Disconnected — not attempting auto-reconnect (needs QR)');
      return;
    }
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    _reconnectAttempts++;
    const delayMs = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, _reconnectAttempts - 1), 15 * 60 * 1000); // cap at 15min
    logger.info({ component: 'WhatsApp', attempt: _reconnectAttempts, delaySec: Math.round(delayMs/1000) }, 'Scheduling reconnect');
    _reconnectTimer = setTimeout(async () => {
      _reconnectTimer = null;
      logger.info({ component: 'WhatsApp', attempt: _reconnectAttempts }, 'Attempting reconnect');
      try { await client.destroy(); } catch (_) {}
      initWhatsApp();
    }, delayMs);
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info({ component: 'FamilyBot' }, 'Received SIGINT. Shutting down gracefully...');
    try { await client.destroy(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Pre-filter: skip non-text and trivially short/emoji-only messages
  // ISSUE-021: 'image' removed from skip set — images from monitored groups must reach handleGroupMessage
  const SKIP_MSG_TYPES = new Set(['sticker', 'audio', 'video', 'location', 'vcard']); // 'document' removed — PDFs/Word/Excel parsed by media-parser; 'image' removed — ISSUE-021
  const SKIP_REGEX = /^[\p{Emoji_Presentation}\s]{1,10}$|^(אוקיי|תודה|👍|ok|כן|לא|yes|no|ממ|יופי|ברור|בסדר|wow|nice)$/iu;

  client.on('message_create', async (msg) => {
    try {
      _lastActivityMs = Date.now(); // track last WA activity for health checks

      // Babysitter DM routing — forward to booking microservice
      if (!msg.from.endsWith('@g.us') && !msg.fromMe) {
        try {
          // Resolve JID to phone (handles both @c.us and @lid LID format)
          const phone = await getPhoneByJid(msg.from);
          logger.info({ component: 'WhatsApp', jid: msg.from, phone: phone || '(unknown)' }, 'DM received');
          // Log DM to rolling history file (used by /chat-history endpoint)
          // Normalize jid to phone@c.us format when available so /chat-history filter matches
          const _dmJid = phone ? `${phone}@c.us` : msg.from;
          appendDMHistory({ jid: _dmJid, phone, fromMe: false, body: msg.body || '', ts: msg.timestamp * 1000, type: msg.type });
          if (phone) {
            const ts = new Date(msg.timestamp * 1000).toISOString();
            await forwardToBabysitterService(phone, msg.body || '', ts);
            logger.info({ component: 'WhatsApp', phone, bodyPreview: msg.body?.substring(0, 30) }, 'Babysitter DM forwarded');
          }
        } catch (e) {
          logger.error({ component: 'WhatsApp', err: e.message }, 'DM routing error');
        }
        return;
      }

      // Only handle group messages
      if (!msg.from.endsWith('@g.us')) return;

      // Skip non-actionable messages before any DB or API calls
      if (SKIP_MSG_TYPES.has(msg.type)) return;
      const msgText = msg.body?.trim() || '';
      const isImageType = msg.type === 'image';
      // ISSUE-021: don't drop image messages on the short-text check — they have no body
      if (!isImageType && msgText.length < 6 && msg.from !== masterGroupId) return;
      if (!isImageType && SKIP_REGEX.test(msgText) && msg.from !== masterGroupId) return;

      const msgId = _ser(msg.id);

      // â"€â"€ Feature 2c: Master group reply handling â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
      if (masterGroupId && msg.from === masterGroupId && msg.hasQuotedMsg) {
        try {
          const quotedMsg = await msg.getQuotedMessage();
          const quotedId = _ser(quotedMsg.id);

          // -- Pending group question reply --
          // Check both in-memory map AND persistent DB (survives restarts)
          const groupIdFromMap = pendingGroupQuestions.get(quotedId);
          const groupIdFromDB = !groupIdFromMap ? getPendingGroupQuestion(quotedId) : null;
          const pendingGroupId = groupIdFromMap || groupIdFromDB;
          if (pendingGroupId) {
            const relatedTo = msg.body.trim();
            if (relatedTo) {
              setGroupRelatedTo(pendingGroupId, 'monitored');
              setGroupDescription(pendingGroupId, relatedTo);
              pendingGroupQuestions.delete(quotedId);
              deletePendingGroupQuestion(quotedId);
              const groupInfo = getGroup(pendingGroupId);
              const groupName = groupInfo ? groupInfo.name : pendingGroupId;
              logger.info({ component: 'WhatsApp', groupName, context: relatedTo }, 'Group context saved');
              await client.sendMessage(masterGroupId, `✅ עודכן: "${groupName}" — ${relatedTo}`);
              // Scan history for the newly-confirmed monitored group
              try {
                const newGroupChat = await client.getChatById(pendingGroupId);
                if (newGroupChat) await scanGroupHistory(newGroupChat);
              } catch (_) {}
            }
            return;
          }

          // -- Fallback: reply to bot's group question, msg_id not in map/DB --
          // Detect by pattern matching the quoted message body
          if (quotedMsg.fromMe) {
            const quotedBody = quotedMsg.body || '';
            // Matches "אני עוקב אחרי הקבוצה *<name>*" or "נוספתי לקבוצה "<name>""
            const groupMatch = quotedBody.match(/הקבוצה \*?["]?([^*"\n]+?)[*"]?\s*(?:אבל|$)/) ||
                               quotedBody.match(/לקבוצה[^"]*[*"]([^*"\n]+)[*"]/);
            if (groupMatch) {
              const groupName = groupMatch[1].trim();
              // Find group in DB by name
              const allGroups = getDB().prepare('SELECT * FROM groups').all();
              const matchedGroup = allGroups.find(g => g.name && g.name.includes(groupName.substring(0, 8)));
              if (matchedGroup) {
                const relatedTo = msg.body.trim();
                if (relatedTo) {
                  setGroupRelatedTo(matchedGroup.id, 'monitored');
                  setGroupDescription(matchedGroup.id, relatedTo);
                  logger.info({ component: 'WhatsApp', groupName: matchedGroup.name, context: relatedTo }, 'Group context saved (pattern match)');
                  await client.sendMessage(masterGroupId, `✅ עודכן: "${matchedGroup.name}" — ${relatedTo}`);
                  // Scan history for the newly-confirmed monitored group
                  try {
                    const newGroupChat = await client.getChatById(matchedGroup.id);
                    if (newGroupChat) await scanGroupHistory(newGroupChat);
                  } catch (_) {}
                  return;
                }
              }
            }
          }

          // -- Follow-up reply --
          const followUp = getFollowUpByBotMsgId(quotedId);
          if (followUp && followUp.status === 'asked') {
            const reply = msg.body.trim();
            const isYes = /^(\u2705|כן|כ|yes|done|ביצעתי|עשיתי|בוצע)$/i.test(reply);
            const isNo = /^(\u274c|לא|ל|no|not yet|טרם)$/i.test(reply);
            if (isYes) {
              updateFollowUpStatus(followUp.id, 'done');
              await client.sendMessage(masterGroupId, '✅ מעולה! רשמתי שביצעת.');
              logger.info({ component: 'WhatsApp', eventTitle: followUp.event_title }, 'Follow-up marked done');
            } else if (isNo) {
              updateFollowUpStatus(followUp.id, 'rescheduling');
              const q = '⏰ בסדר. לאיזה יום ושעה לדחות?';
              await client.sendMessage(masterGroupId, q);
              addToHistory('assistant', q);
            } else {
              // Free-text reply -- treat as rescheduling info
              updateFollowUpStatus(followUp.id, 'rescheduling');
              addToHistory('user', msg.body);
              const { extractFromText } = require('./parser');
              const { addSharedEvent: addEvtFu } = require('./calendar');
              const { events: fuEvents } = await extractFromText(msg.body, masterGroupHistory.slice(-5), null, msg.timestamp ? msg.timestamp * 1000 : null);
              if (fuEvents.length > 0) {
                for (const e of fuEvents) {
                  const gcalEv = await addEvtFu(e, followUp.owner || 'both');
                  if (gcalEv) { scheduleRemindersForEvent(gcalEv, followUp.owner || 'both'); scheduleFollowUpForEvent(gcalEv, followUp.owner || 'both'); }
                }
                const confirmMsg = '✅ קבעתי מחדש!';
                await client.sendMessage(masterGroupId, confirmMsg);
                addToHistory('assistant', confirmMsg);
              }
            }
            return;
          }
        } catch (err) {
          logger.error({ component: 'WhatsApp', err: err.message || String(err), code: err.code }, 'Error handling master group reply');
        }
      }

      // â"€â"€ Master group command handling â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
      // Any non-fromMe message in the master group (not a pending-question reply) is a command
      if (masterGroupId && msg.from === masterGroupId && !msg.fromMe) {
        if (isMessageProcessed(msgId)) return;
        markMsgProcessed(msgId);
        // Log inbound master group message to dm-history.jsonl for /chat-history context
        try {
          const _gc = await msg.getContact().catch(() => null);
          const _gName = (_gc && (_gc.pushname || _gc.number)) || msg.author || 'Family';
          appendDMHistory({ jid: masterGroupId, fromMe: false, phone: _gName, body: msg.body || '', ts: msg.timestamp * 1000, type: msg.type });
        } catch (_) {}

        // Babysitter onboarding reply detection
        const handled = await handleOnboardingReply(msg.body || '', sendToMasterGroup).catch(() => false);
        if (handled) return;

        // Free-text yes/no fallback for active follow-up (user replied without quoting)
        const freeText = msg.body.trim();
        const freeIsYes = /^(\u2705|כן|כ|yes|done|ביצעתי|עשיתי|בוצע)$/i.test(freeText);
        const freeIsNo  = /^(\u274c|לא|ל|no|not yet|טרם)$/i.test(freeText);
        if (freeIsYes || freeIsNo) {
          try {
            // Time guard: only auto-match a bare 'כן'/'לא' to a follow-up asked in
            // the last 30 minutes. Without this, a stale 'asked' follow-up would
            // hijack an unrelated confirmation (e.g. approving a group to monitor).
            const freshCutoff = Date.now() - 30 * 60 * 1000;
            const activeFollowUp = getDB().prepare(
              "SELECT * FROM follow_ups WHERE status='asked' AND created_at > ? ORDER BY id DESC LIMIT 1"
            ).get(freshCutoff);
            if (activeFollowUp) {
              if (freeIsYes) {
                updateFollowUpStatus(activeFollowUp.id, 'done');
                await client.sendMessage(masterGroupId, '✅ מעולה! רשמתי שביצעת.');
                logger.info({ component: 'WhatsApp', eventTitle: activeFollowUp.event_title }, 'Follow-up (free-text) marked done');
              } else {
                updateFollowUpStatus(activeFollowUp.id, 'rescheduling');
                await client.sendMessage(masterGroupId, '⏰ בסדר. לאיזה יום ושעה לדחות?');
              }
              return;
            } else {
              // Debug: surface when a bare yes/no was NOT matched because the only
              // pending follow-up is older than the 30-minute time guard.
              const staleFollowUp = getDB().prepare(
                "SELECT * FROM follow_ups WHERE status='asked' ORDER BY id DESC LIMIT 1"
              ).get();
              if (staleFollowUp) {
                logger.info({ component: 'WhatsApp', followUpId: staleFollowUp.id, eventTitle: staleFollowUp.event_title, createdAt: staleFollowUp.created_at }, 'Free-text yes/no ignored: pending follow-up is older than 30min time guard');
              }
            }
          } catch (_) {}
        }

        // ── Dismissal command detection ───────────────────────────────────────
        const { DISMISSAL_REGEX, parseDismissal, storeDismissal } = require('./dismissal');
        if (DISMISSAL_REGEX.test(msg.body || '')) {
          try {
            const contact2 = await msg.getContact().catch(() => null);
            const senderName2 = (contact2 && (contact2.pushname || contact2.number)) || 'Family';
            const sentRecent = getDB().prepare(
              'SELECT topic_key, sent_at, message_text FROM sent_messages WHERE sent_at >= ? ORDER BY sent_at ASC'
            ).all(Date.now() - 72 * 3600000);

            const parsed = await parseDismissal(msg.body, sentRecent);
            logger.info({ component: 'Dismissal', parsed }, 'Dismissal parsed');

            if (parsed.is_dismissal) {
              const scopeValue = parsed.matched_topic_key || parsed.scope_hint || null;
              const hours = parsed.duration_hours || 48;
              await storeDismissal(senderName2, parsed.scope_type, scopeValue, hours, msg.body);

              // Also dismiss all currently pending notices that match
              if (parsed.scope_type === 'source_group' && scopeValue) {
                getDB().prepare(
                  "UPDATE notices SET triage_decision='skip', triage_reason='dismissed by user', triaged_at=?, posted_to_master=1 WHERE dismissed=0 AND posted_to_master=0 AND group_name LIKE ?"
                ).run(Date.now(), '%' + scopeValue + '%');
              } else if (parsed.scope_type === 'topic_key' && scopeValue) {
                // Can't easily match by topic_key in notices table — triage will handle on next run
              } else if (parsed.scope_type === 'all') {
                getDB().prepare(
                  "UPDATE notices SET triage_decision='skip', triage_reason='dismissed by user (all)', triaged_at=?, posted_to_master=1 WHERE dismissed=0 AND posted_to_master=0"
                ).run(Date.now());
              }

              const scopeLabel = parsed.scope_type === 'all' ? 'הכל'
                : parsed.scope_type === 'source_group' ? `הקבוצה "${scopeValue || parsed.scope_hint}"`
                : `"${scopeValue || parsed.scope_hint}"`;
              const confirmMsg = `‏🔕 הבנתי — לא אשלח עוד על ${scopeLabel} ב-${hours} השעות הקרובות.`;
              await sendToMasterGroup(confirmMsg);
              logger.info({ component: 'Dismissal' }, 'Confirmed to master group: %s', confirmMsg);
              return;
            }
          } catch (e) {
            logger.error({ component: 'Dismissal', err: e.message }, 'Dismissal error');
            // Fall through to normal command handling
          }
        }
        // ── End dismissal detection ───────────────────────────────────────────

        // ── Group monitoring commands (RC-3 fix) ──────────────────────────────────
        // נטר [group name] — start monitoring
        // התעלם [שם קבוצה] — ignore group
        const _monitorCmd = (msg.body || '').match(/^נטר\s+(.+)$/u);
        if (_monitorCmd) {
          const _gNameM = _monitorCmd[1].trim();
          try {
            const _r = getDB().prepare("UPDATE groups SET configured = 1, related_to = 'monitored' WHERE name LIKE ?").run(`%${_gNameM}%`);
            await client.sendMessage(masterGroupId, _r.changes > 0
              ? `✅ מתחיל לנטר קבוצות שמכילות: ${_gNameM}`
              : `❓ לא מצאתי קבוצה בשם: ${_gNameM}`);
          } catch (_e) { logger.error({ component: 'WhatsApp', err: _e.message }, 'נטר command error'); }
          return;
        }
        const _ignoreCmd = (msg.body || '').match(/^התעלם\s+(.+)$/u);
        if (_ignoreCmd) {
          const _gNameI = _ignoreCmd[1].trim();
          try {
            const _r2 = getDB().prepare("UPDATE groups SET configured = 1, related_to = 'ignored' WHERE name LIKE ?").run(`%${_gNameI}%`);
            await client.sendMessage(masterGroupId, _r2.changes > 0
              ? `✅ מתעלם מקבוצות שמכילות: ${_gNameI}`
              : `❓ לא מצאתי קבוצה בשם: ${_gNameI}`);
          } catch (_e2) { logger.error({ component: 'WhatsApp', err: _e2.message }, 'התעלם command error'); }
          return;
        }
        // ── End group monitoring commands ─────────────────────────────────────

        await handleMasterGroupCommand(msg);
        return;
      }

      // â"€â"€ Dedup check â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
      if (isMessageProcessed(msgId)) return;
        markMsgProcessed(msgId);

      // â"€â"€ Normal monitored-group handling â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
      const monitored = await isMonitoredGroup(msg);
      if (monitored) {
        // Always save to DB for context (even media/short messages)
        try {
          const ctxContact = await msg.getContact().catch(() => null);
          const ctxSender = (ctxContact && (ctxContact.pushname || ctxContact.number)) || msg.author || 'unknown';
          const ctxChat = await msg.getChat().catch(() => null);
          const mediaLabel = { image: '[\u05ea\u05de\u05d5\u05e0\u05d4]', video: '[\u05d5\u05d9\u05d3\u05d0\u05d5]', audio: '[\u05d4\u05e7\u05dc\u05d8\u05d4 \u05e7\u05d5\u05dc\u05d9\u05ea]', document: '[\u05de\u05e1\u05de\u05da]', sticker: '[\u05de\u05d3\u05d1\u05e7\u05d4]', location: '[\u05de\u05d9\u05e7\u05d5\u05dd]' };
          const ctxBody = msg.body && msg.body.trim() ? msg.body : (mediaLabel[msg.type] || '[\u05de\u05d3\u05d9\u05d4]');
          saveMessage({ group_id: (ctxChat && ctxChat.id && _ser(ctxChat.id)) || msg.from, sender: ctxSender, body: ctxBody, timestamp: msg.timestamp * 1000 });
          recordMessagePersisted();
        } catch (_) {}
        // Full parse+act only for substantial text messages or images (ISSUE-021: images from
        // any sender in monitored groups must reach handleGroupMessage for vision OCR)
        if ((msgText.length >= 6 && !SKIP_REGEX.test(msgText)) || isImageType) {
          await handleGroupMessage(msg, { alreadySaved: true });
        }
      } else if (msg.from !== masterGroupId) {
        // Message from unknown/unmonitored group -- notify master group if new
        try {
          const chat = await msg.getChat();
          if (chat.isGroup) {
            const existing = getGroup(_ser(chat.id));
            if (!existing && masterGroupId) {
              saveGroup(_ser(chat.id), chat.name);
              const question = `🆕 נוספתי לקבוצה: *${chat.name}*\nלמי הקבוצה קשורה? מעוניינת במעקב? (ענו בתגובה להודעה זו)`;
              const sentMsg = await client.sendMessage(masterGroupId, question);
              pendingGroupQuestions.set(_ser(sentMsg.id), _ser(chat.id));
              savePendingGroupQuestion(_ser(sentMsg.id), _ser(chat.id));
              logger.info({ component: 'WhatsApp', groupName: chat.name }, 'New group detected live');
            }
          }
        } catch (err) {
          logger.error({ component: 'WhatsApp', err: err.message }, 'New group detection error');
        }
      }
    } catch (err) {
      logger.error({ component: 'WhatsApp', err: err.message }, 'message handler error');
    }
  });

  logger.info({ component: 'WhatsApp' }, 'Initializing client...');
  client.initialize().catch(err => {
    addInitError(err);
    logger.error({ component: 'WhatsApp', err: err.message }, 'initialize failed');
  });

  return client;
}

module.exports = {
  initWhatsApp,
  sendToMasterGroup,
  sendToMasterGroupWithId,
  sendToMasterGroupWithMentions,
  getGroups,
  getHealthState,
};

