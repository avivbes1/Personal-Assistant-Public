/**
 * whatsapp.js â€" WhatsApp client using whatsapp-web.js with LocalAuth.
 * Monitors specified groups and handles incoming messages.
 */

const { Client, LocalAuth, Buttons } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const { saveMessage, saveEvent, saveActionItem, saveClarification, saveGroup, setGroupRelatedTo, setGroupDescription, getGroup, getMonitoredGroupsWithoutDescription, getAllPendingGroupQuestions, savePendingGroupQuestion, getPendingGroupQuestion, deletePendingGroupQuestion, isMessageProcessed, markMsgProcessed, getDB, addToConversationHistory, getConversationHistory, setPendingAction, getPendingAction, clearPendingAction, cancelRemindersForEvent, cancelFollowUpsForEvent, saveBotTask, getPendingBotTasks, claimBotTask, cancelRecurringGroup, isRecurringGroupActive, saveCapabilityRequest, getPendingCapabilityRequests, getRecentGroupMessages } = require('./db');
const { resolveMembersInText } = require('./family-profiles');
const { validateOutgoing, repairMessage } = require('./validate-outgoing');
const { extractFromText, detectMissingParams, buildClarificationQuestion, resolvePartialEvent } = require('./parser');
const { processMediaMessage, isSchoolGroup } = require('./media-parser');
const { addEvent, addSharedEvent, searchCalendarEvents, updateCalendarEvent, deleteCalendarEvent } = require('./calendar');
const { scheduleRemindersForEvent, scheduleFollowUpForEvent } = require('./scheduler');
const { answerQuery } = require('./query');
const { handleMessage, handleGroupEvent } = require('./agent');
const { getFollowUpByBotMsgId, updateFollowUpStatus } = require('./db');
const { startVoiceServer } = require('./voice-server');

let client = null;
let masterGroupId = null;
let _backlogCutoffMs = 0; // messages older than this timestamp are considered backlog (set on reconnect)
const isBacklogMessage = (timestampMs) => timestampMs < _backlogCutoffMs;

// Reconnection loop protection (module-level so it persists across reinitialization)
let _readyFailureCount = 0;
let _lastActivityMs = Date.now();
const MAX_READY_FAILURES = 5;
const getHealthState = () => ({
  whatsapp_connected: !!(client && client.info),
  last_activity_ms: _lastActivityMs,
  ready_failure_count: _readyFailureCount,
  uptime_s: Math.round(process.uptime()),
});

// Rolling conversation history for master group (last 20 messages — in-memory fallback)

const masterGroupHistory = []; // { role: 'user'|'assistant', content: string }

// ── Babysitter Booking microservice integration ──────────────────────────────
const { getBabysitterPhones, resolveJids: resolveJidsForBabysitters, getPhoneByJid, checkOnboarding: checkBabysitterOnboarding, handleOnboardingReply } = require('./babysitter-onboarding');
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
          console.error('[Confirm] addSharedEvent error:', e.message);
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
      console.log('[Confirm] CAPABILITY_CLARIFY resolved via normal query path');

    } else {
      console.warn('[Confirm] Unknown pending action type:', action_type);
    }
  } catch (e) {
    console.error('[Confirm] executePendingAction error:', e.message);
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
    console.log(`[BotTask] Recurring fired: "${check_in_message.substring(0, 60)}" (group: ${group_key})`);

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
  if (rows.length > 0) console.log(`[WhatsApp] Restored ${rows.length} pending group question(s) from DB`);
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
      console.warn('[WhatsApp] Could not load groups.json:', err.message);
      return { monitored: [], master: '' };
    }
  }
  return _groupsConfigCache;
}

/**
 * Resolve the chat ID for the master group by name.
 */
async function resolveMasterGroup() {
  const groupsConfig = loadGroupsConfig();
  const masterName = groupsConfig.master || config.MASTER_GROUP_NAME;

  if (!masterName) return;

  const chats = await client.getChats();
  for (const chat of chats) {
    if (chat.isGroup && chat.name === masterName) {
      masterGroupId = chat.id._serialized;
      console.log(`[WhatsApp] Master group resolved: "${masterName}" (${masterGroupId})`);
      return;
    }
  }
  console.warn(`[WhatsApp] Master group "${masterName}" not found in chat list.`);
}

/**
 * Determine if a message is from a monitored group.
 */
async function isMonitoredGroup(msg) {
  const chat = await msg.getChat();
  if (!chat.isGroup) return false;

  // Check DB: any group with related_to='monitored' is monitored
  const groupRecord = getGroup(chat.id._serialized);
  if (groupRecord && groupRecord.related_to === 'monitored') return true;

  // Fallback: check static groups.json for legacy config
  const groupsConfig = loadGroupsConfig();
  const monitored = groupsConfig.monitored || [];
  return monitored.includes(chat.name);
}

/**
 * Handle a message from a monitored group.
 */
async function handleGroupMessage(msg, { alreadySaved = false } = {}) {
  try {
    const chat = await msg.getChat();
    const contact = await msg.getContact();
    const groupId = chat.id._serialized;
    const sender = contact.pushname || contact.number || msg.from;

    // Resolve message body — for media, try to extract content
    const groupRecord = getGroup(groupId);
    let body = msg.body || '';
    // Documents: always extract even if msg.body contains the filename
    const isDocumentMsg = msg.type === 'document';
    const isMedia = (isDocumentMsg || !body.trim()) && ['image', 'sticker', 'document', 'audio', 'video', 'location', 'vcard'].includes(msg.type);
    const isImageMsg = isMedia && (msg.type === 'image' || msg.type === 'sticker');
    if (isMedia) {
      if (isImageMsg) {
        // For images: don't run vision yet — let the agent decide based on context
        // Caption (if any) is already in msg.body for captioned images
        const caption = msg.body ? ` (caption: ${msg.body.substring(0, 100)})` : '';
        body = `[תמונה${caption}]`;
      } else {
        const extracted = await processMediaMessage(msg, groupRecord, chat.name).catch(() => null);
        if (extracted) {
          body = extracted;
          console.log(`[WhatsApp] Media extracted from "${chat.name}": ${extracted.substring(0, 80)}`);
        } else {
          const mediaLabel = { video: '[וידאו]', audio: '[הקלטה קולית]', document: '[מסמך]', location: '[מיקום]' };
          body = mediaLabel[msg.type] || '[מדיה]';
        }
      }
    }

    // Save to DB (skip if caller already saved to avoid duplicates)
    let messageId;
    if (!alreadySaved) {
      messageId = saveMessage({ group_id: groupId, sender, body, timestamp: msg.timestamp * 1000 });
    } else {
      // Update the already-saved row with the extracted body if we got real content
      const row = getDB().prepare('SELECT id FROM messages WHERE group_id=? AND timestamp=? ORDER BY id DESC LIMIT 1').get(groupId, msg.timestamp * 1000);
      messageId = row ? row.id : null;
      if (messageId && isMedia && body !== '[מדיה]' && body !== '[תמונה]' && body !== '[מסמך]') {
        getDB().prepare('UPDATE messages SET body=? WHERE id=?').run(body, messageId);
      }
    }

    console.log(`[WhatsApp] Message from "${chat.name}" by ${sender}: ${body.substring(0, 60)}`);

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
    const agentResult = await handleGroupEvent(body, chat.name, sender, groupDescription, recentMessages, msg.timestamp * 1000, isImageMsg, msgIsBacklog, groupRecord?.primary_child || null);

    // If agent decided this image is worth reading, run vision now and update the notice
    if (isImageMsg && agentResult.downloadImage) {
      console.log(`[WhatsApp] Agent requested image download for "${chat.name}" by ${sender}`);
      try {
        const described = await processMediaMessage(msg, groupRecord, chat.name, { forceVision: true });
        if (described) {
          console.log(`[WhatsApp] Image described: ${described.substring(0, 100)}`);
          // Update the notice created by agent with the real image content
          getDB().prepare(
            'UPDATE notices SET content = ? WHERE source_timestamp = ? AND group_name = ? AND dismissed = 0'
          ).run(described, msg.timestamp * 1000, chat.name);
        }
      } catch (e) {
        console.error('[WhatsApp] Vision post-processing error:', e.message);
      }
    }

  } catch (err) {
    console.error('[WhatsApp] handleGroupMessage error:', err.message);
  }
}

// Authorized identifiers - phone numbers OR WhatsApp LIDs (new privacy format)
const ALLOWED_NUMBERS = new Set([
  config.AVIV_PHONE, // primary parent phone
  config.LIAT_PHONE, // secondary parent phone
  '245500498423818', // Aviv LID
]);

async function isSenderAuthorized(msg) {
  try {
    const contact = await msg.getContact();
    // contact.number may be a string or number - coerce to string
    const number = String(contact.number || '').trim();
    if (number && ALLOWED_NUMBERS.has(number)) return true;
    // Also check raw author/from ID part (covers LID format: 245500498423818@lid)
    const authorUser = (msg.author || msg.from || '').split('@')[0].trim();
    if (authorUser && ALLOWED_NUMBERS.has(authorUser)) return true;
    // Log the actual ID so we can diagnose mismatches
    console.warn(`[WhatsApp] Unauthorized sender: id=${msg.author || msg.from}, number=${number}`);
    return false;
  } catch (e) {
    console.warn(`[WhatsApp] Could not resolve sender contact: ${e.message}`);
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
 * Lipa (OpenClaw) now handles all master group conversation.
 * Tudat only posts scheduled automations (reminders, digest, check-ins).
 */
async function handleMasterGroupCommand(_msg) {
  return; // no-op
  try {
    const body = msg.body || '';
    if (!body.trim()) return;

    // Check if this is a reply to the bot's own message — capture quoted text for context
    let quotedFromMe = false;
    let quotedBody = '';
    if (msg.hasQuotedMsg) {
      try {
        const quoted = await msg.getQuotedMessage();
        quotedFromMe = quoted.fromMe;
        if (quotedFromMe) quotedBody = (quoted.body || '').substring(0, 300);
      } catch (_) {}
    }

    // Strip bot name from message before parsing so it doesn't confuse the AI
    // (Name-gating only applies in monitored family groups, not the master command group)
    const cleanBody = body
      .replace(new RegExp(config.BOT_NAME, 'gi'), '')
      .replace(new RegExp(config.BOT_NAME_ALT, 'gi'), '')
      .replace(/^[,:\s]+/, '')
      .trim();

    if (!cleanBody) return;

    const contact = await msg.getContact();
    const senderName = contact.pushname || contact.name || 'Family';
    const userId = contact.number || contact.id?.user || config.AVIV_PHONE;

    console.log(`[WhatsApp] Master group command from ${senderName}: ${cleanBody.substring(0, 80)}`);

    // Phase 3+4: check for pending action (confirmation or clarification)
    if (config.FEATURE_CONFIRM_ACTIONS || config.FEATURE_CLARIFICATION_LOOP) {
      const pending = getPendingAction(userId);
      if (pending) {
        const reply = cleanBody.trim();
        const isClarification = pending.missing_params && pending.missing_params.length > 0;

        if (isClarification && config.FEATURE_CLARIFICATION_LOOP) {
          // Phase 4: user is answering a clarification question
          console.log(`[Clarify] Resolving "${pending.action_type}" for ${userId}: "${reply}"`);
          const { partialEvent, followUpCount = 0 } = pending.params;
          const question = pending.confirmation_text || '';

          const extracted = await resolvePartialEvent(partialEvent, pending.missing_params, question, reply);
          const mergedEvent = { ...partialEvent, ...extracted };
          const stillMissing = detectMissingParams([mergedEvent], 'event');

          if (stillMissing.length === 0) {
            // Complete — move to confirmation or execute
            clearPendingAction(userId);
            if (config.FEATURE_CONFIRM_ACTIONS) {
              const confirmText = buildEventConfirmationText([mergedEvent]);
              setPendingAction(userId, 'ADD_EVENT', { events: [mergedEvent] }, [], confirmText);
              await sendToMasterGroup(confirmText);
              addToHistory('assistant', confirmText, userId);
            } else {
              await executePendingAction({ action_type: 'ADD_EVENT', params: { events: [mergedEvent] } }, userId, senderName);
            }
          } else if (followUpCount < 2) {
            // Ask again (max 2 follow-ups)
            const nextQ = buildClarificationQuestion(stillMissing, mergedEvent);
            setPendingAction(userId, 'CLARIFY_EVENT', { partialEvent: mergedEvent, followUpCount: followUpCount + 1 }, stillMissing, nextQ);
            await sendToMasterGroup(nextQ);
            addToHistory('assistant', nextQ, userId);
          } else {
            // Give up gracefully
            clearPendingAction(userId);
            const giveUp = 'לא הצלחתי להבין את הפרטים — נסה שוב בפירוט יותר.';
            await sendToMasterGroup(giveUp);
            addToHistory('assistant', giveUp, userId);
          }
          return;

        } else if (!isClarification && config.FEATURE_CONFIRM_ACTIONS) {
          // Phase 3: confirmation pending
          if (APPROVE_REGEX.test(reply)) {
            clearPendingAction(userId);
            console.log(`[Confirm] Approved: ${pending.action_type} for ${userId}`);
            await executePendingAction(pending, userId, senderName);
            return;
          } else if (REJECT_REGEX.test(reply)) {
            clearPendingAction(userId);
            const cancelMsg = 'בוטל.';
            await sendToMasterGroup(cancelMsg);
            addToHistory('assistant', cancelMsg, userId);
            console.log(`[Confirm] Rejected: ${pending.action_type} for ${userId}`);
            return;
          } else {
            // User moved on — discard pending
            console.log(`[Confirm] Pending ${pending.action_type} discarded (new message)`);
            clearPendingAction(userId);
            // fall through
          }
        } else {
          clearPendingAction(userId); // flag disabled but stale entry exists — clean up
        }
      }
    }

    // ── Pending group question — free-text reply (no quote used) ────────────────────────────
    // If the bot asked "who is this group for?" and the user replied free-text (no quote),
    // handle it here instead of sending to the general agent.
    if (!msg.hasQuotedMsg && pendingGroupQuestions.size === 1) {
      const [[pendingMsgId, pendingGroupId]] = pendingGroupQuestions;
      const groupInfo = getGroup(pendingGroupId);
      const groupName = groupInfo ? groupInfo.name : pendingGroupId;
      setGroupRelatedTo(pendingGroupId, 'monitored');
      setGroupDescription(pendingGroupId, cleanBody);
      pendingGroupQuestions.delete(pendingMsgId);
      deletePendingGroupQuestion(pendingMsgId);
      console.log(`[WhatsApp] Group "${groupName}" context saved via free-text: "${cleanBody}"`);
      const confirmMsg = `✅ עודכן: "${groupName}" — ${cleanBody}`;
      await sendToMasterGroup(confirmMsg);
      addToHistory('assistant', confirmMsg, userId);
      // Scan history for the newly-confirmed monitored group
      try {
        const newGroupChat = await client.getChatById(pendingGroupId);
        if (newGroupChat) await scanGroupHistory(newGroupChat);
      } catch (_) {}
      return;
    }

        // Phase 2: member resolution — find which family members are mentioned
    let resolvedMemberContext = null;
    if (config.FEATURE_MEMBER_RESOLUTION) {
      try {
        const members = resolveMembersInText(cleanBody);
        if (members.length > 0) {
          resolvedMemberContext = members.map(m =>
            `${m.name_he} = ${m.name_en}, ${m.role}${m.calendar_id ? ', has calendar' : ', no personal calendar'}`
          ).join('; ');
          console.log(`[WhatsApp] Resolved members: ${resolvedMemberContext}`);
        }
      } catch (_) {}
    }

    // Add user message to history (persists to DB if flag on)
    addToHistory('user', cleanBody, userId);
    // Fetch prior history (DB-backed or in-memory depending on flag)
    const priorHistory = getHistory(userId, 10).slice(0, -1); // exclude the message we just added

    // Short-message guard: very short messages (< 4 chars) that aren't approval/rejection
    // should not hit the full parser — they're likely typos or fragments
    const isApprovalKeyword = APPROVE_REGEX.test(cleanBody.trim()) || REJECT_REGEX.test(cleanBody.trim());
    if (cleanBody.trim().length < 4 && !isApprovalKeyword && !quotedFromMe) {
      console.log(`[WhatsApp] Short non-command message ignored: "${cleanBody}"`);
      return;
    }

    // When user replies to a bot message, inject the quoted text so the parser has full context
    // e.g. "תמחק את זה" + quoted reminder → parser knows which event
    const parseText = quotedFromMe && quotedBody
      ? `${cleanBody} [ההודעה המצוטטת: ${quotedBody}]`
      : cleanBody;

    // ── Agent call: single Claude invocation handles all intents ────────────────
    const { text: agentResponse, sideEffects } = await handleMessage(parseText, quotedBody, senderName, priorHistory);

    // Execute side effects that need the WhatsApp client (e.g. send_whatsapp)
    for (const effect of (sideEffects || [])) {
      if (effect.type === 'send_whatsapp' && effect.phone && effect.text) {
        try {
          await client.sendMessage(`${effect.phone}@c.us`, effect.text);
          console.log(`[WhatsApp] Agent sent WA to ${effect.to} (${effect.phone}): ${effect.text.substring(0, 60)}`);
        } catch (sendErr) {
          console.error('[WhatsApp] Agent send_whatsapp failed:', sendErr.message);
          await sendToMasterGroup(`שגיאה בשליחת ההודעה ל${effect.to} — נסה שוב.`);
        }
      }
    }

    await sendToMasterGroup(agentResponse);
    addToHistory('assistant', agentResponse, userId);
  } catch (err) {
    console.error('[WhatsApp] handleMasterGroupCommand error:', err.message);
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
      const msgId = msg.id._serialized;
      if (isMessageProcessed(msgId)) continue; // already handled
      markMsgProcessed(msgId);
      console.log(`[WhatsApp] Replaying missed master command: "${(msg.body || '').substring(0, 60)}"`);
      await handleMasterGroupCommand(msg);
      replayed++;
    }

    if (replayed > 0) {
      console.log(`[WhatsApp] Replayed ${replayed} missed master group command(s).`);
    }
  } catch (err) {
    console.error('[WhatsApp] replayMasterGroupCommands error:', err.message);
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

    console.log(`[WhatsApp] History scan for "${chat.name}": fetched ${msgs.length} msgs`);

    const groupId = chat.id._serialized;

    for (const msg of msgs) {
      const msgTs = msg.timestamp * 1000;
      if (msgTs < saveCutoff) continue;
      if (msg.fromMe) continue;

      const msgId = msg.id._serialized;
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
      saved++;

      // Only parse+act on recent messages we haven't processed
      if (msgTs < parseCutoff) continue;
      if (isMessageProcessed(msgId)) { skippedProcessed++; continue; }
      markMsgProcessed(msgId);
      await handleGroupMessage(msg, { alreadySaved: true });
      scanned++;
    }

    console.log(`[WhatsApp] History scan for "${chat.name}": ${scanned} parsed, ${saved} saved for context, ${skippedProcessed} already processed.`);
  } catch (err) {
    console.error(`[WhatsApp] scanGroupHistory error for "${chat.name}":`, err.message);
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

  console.warn(`[OutgoingGate] Message failed validation: ${v.reason}`);
  console.warn(`[OutgoingGate] Original: ${text.substring(0, 200)}`);

  // Step 2: repair via LLM
  const repaired = await repairMessage(text, v.reason).catch(() => null);
  if (repaired) {
    const vr = validateOutgoing(repaired);
    if (vr.ok) {
      console.log(`[OutgoingGate] Sending repaired message: ${repaired.substring(0, 100)}`);
      return { ok: true, text: repaired };
    }
  }

  // Step 3: minimal fallback — strip tags + cap at 100 chars
  const timeMatch = text.match(/\d{1,2}:\d{2}/);
  const fallbackBase = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().substring(0, 100);
  const fallback = timeMatch ? `💡 ${fallbackBase}` : null;
  if (fallback && validateOutgoing(fallback).ok) {
    console.log(`[OutgoingGate] Sending fallback: ${fallback}`);
    return { ok: true, text: fallback };
  }

  // Step 4: DM Aviv — never lose information silently
  const avivJid = `${config.AVIV_PHONE}@c.us`;
  const dmText = `⚠️ ניסיתי לשלוח לקבוצה אבל ההודעה לא עברה בדיקת איכות.\nסיבה: ${v.reason}\n\nתוכן גולמי:\n${text.substring(0, 300)}`;
  console.warn('[OutgoingGate] All repair attempts failed. DMing Aviv.');
  if (client) {
    await client.sendMessage(avivJid, dmText).catch(e => console.error('[OutgoingGate] DM also failed:', e.message));
  }
  return { ok: false };
}

/**
 * Send a message to the master group.
 */
async function sendToMasterGroup(text) {
  if (!client) {
    console.warn('[WhatsApp] Client not initialized, cannot send message.');
    return;
  }

  if (!masterGroupId) {
    console.warn('[WhatsApp] Master group not resolved yet, trying to resolve...');
    await resolveMasterGroup();
    if (!masterGroupId) {
      console.warn('[WhatsApp] Still no master group. Message not sent:', text.substring(0, 60));
      return;
    }
  }

  const result = await applyRepairPipeline(text);
  if (!result.ok) return;
  try {
    await client.sendMessage(masterGroupId, result.text);
    console.log('[WhatsApp] Sent to master group:', result.text.substring(0, 60));
  } catch (err) {
    console.error('[WhatsApp] sendToMasterGroup error:', err.message);
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
    return sentMsg.id._serialized;
  } catch (err) {
    console.error('[WhatsApp] sendToMasterGroupWithId error:', err.message);
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
    console.log('[WhatsApp] Sent with mentions to master group:', result.text.substring(0, 60));
    return sentMsg.id._serialized;
  } catch (err) {
    // Fallback to plain send if mentions not supported
    console.warn('[WhatsApp] Mentions failed, sending plain:', err.message);
    try {
      const sentMsg = await client.sendMessage(masterGroupId, result.text);
      return sentMsg.id._serialized;
    } catch (e2) {
      console.error('[WhatsApp] sendToMasterGroupWithMentions error:', e2.message);
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
      .map(c => ({ id: c.id._serialized, name: c.name }));
  } catch (err) {
    console.error('[WhatsApp] getGroups error:', err.message);
    return [];
  }
}

/**
 * Initialize the WhatsApp client.
 */
function initWhatsApp() {
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1015901307-alpha.html',
    },
    puppeteer: {
      headless: true,
      executablePath: config.CHROMIUM_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
    },
  });

  client.on('qr', (qr) => {
    console.log('\n[WhatsApp] Scan the QR code below to connect:\n');
    qrcode.generate(qr, { small: true });
    // Also save as PNG so it can be shared
    try {
      const QRCode = require('qrcode');
      QRCode.toFile('/tmp/whatsapp-qr.png', qr, { width: 400 }, (err) => {
        if (!err) console.log('[WhatsApp] QR image saved to /tmp/whatsapp-qr.png');
      });
    } catch (_) {}
  });

  const { startReconciliation } = require('./groupReconciliation');

  let _lastDisconnectMs = 0;

  client.on('disconnected', () => {
    _lastDisconnectMs = Date.now();
  });

  client.on('ready', async () => {
    // Mark reconnect point — messages older than this are backlog
    _backlogCutoffMs = Date.now() - 60000; // 1min grace for in-flight messages
    if (_lastDisconnectMs > 0) {
      const offlineMs = Date.now() - _lastDisconnectMs;
      console.log(`[WhatsApp] Reconnected after ${Math.round(offlineMs/60000)}min offline. Backlog cutoff: ${new Date(_backlogCutoffMs).toISOString()}`);
    }
    console.log('[WhatsApp] ✅ Client connected and ready!');
    await resolveMasterGroup();

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

    // Start voice message HTTP server
    try {
      startVoiceServer(client, getHealthState);
    } catch (_) { console.error('[WhatsApp] Voice server failed to start:', _.message); }

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

    // Get all group chats
    const allChats = await client.getChats();
    const groupChats = allChats.filter(c => c.isGroup);

    console.log('[WhatsApp] Available groups:');
    groupChats.forEach(g => console.log(`  - "${g.name}" (${g.id._serialized})`));

    // â"€â"€ Feature 2: New group detection â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    for (const chat of groupChats) {
      const chatId = chat.id._serialized;
      const existing = getGroup(chatId);

      if (!existing) {
        // New group â€" save it
        saveGroup(chatId, chat.name);
        console.log(`[WhatsApp] New group detected: "${chat.name}"`);

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
            pendingGroupQuestions.set(sentMsg.id._serialized, chatId);
            savePendingGroupQuestion(sentMsg.id._serialized, chatId);
            addToHistory('assistant', question);
            console.log(`[WhatsApp] Asked master group about new group "${chat.name}"`);
          } catch (err) {
            console.error('[WhatsApp] Failed to send new-group question:', err.message);
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
          pendingGroupQuestions.set(sentMsg.id._serialized, grp.id);
          savePendingGroupQuestion(sentMsg.id._serialized, grp.id);
          addToHistory('assistant', question);
          console.log(`[WhatsApp] Asked about group context: "${grp.name}"`);
        } catch (err) {
          console.error(`[WhatsApp] Failed to ask about group "${grp.name}":`, err.message);
        }
        await new Promise(r => setTimeout(r, 1000)); // small delay between messages
      }
    }

    // ── Feature 1: Startup history scan ─────────────────────────────────────
    // Use DB-monitored groups (not just static groups.json list)
    const monitoredChats = groupChats.filter(c => {
      const rec = getGroup(c.id._serialized);
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
    console.log('[WhatsApp] Authenticated.');

    // Watchdog: if ready doesn't fire within 2 minutes, the WA page is stuck.
    // Uses module-level _readyFailureCount so retries don't reset the counter.
    const readyWatchdog = setTimeout(async () => {
      _readyFailureCount++;
      const backoffMs = Math.min(_readyFailureCount * 5000, 30000); // 5s, 10s, 15s, 20s, 30s
      console.error(`[WhatsApp] ⚠️ Ready event never fired (attempt ${_readyFailureCount}/${MAX_READY_FAILURES}) — will retry in ${backoffMs/1000}s`);

      if (_readyFailureCount >= MAX_READY_FAILURES) {
        // Stop the loop — write flag file for Lipa to detect and DM Aviv out-of-band
        // (can't use sendAlertDirect — WhatsApp is the broken thing)
        console.error('[WhatsApp] ❌ Giving up after max failures. Writing alert flag for Lipa.');
        try {
          require('fs').writeFileSync('/tmp/bot-stuck-alert.json', JSON.stringify({
            ts: Date.now(),
            failures: _readyFailureCount,
            message: `Tudat stuck in reconnection loop (${_readyFailureCount} failed attempts). WhatsApp not responding. Check linked devices, may need QR re-scan.`
          }));
        } catch (flagErr) {
          console.error('[WhatsApp] Failed to write alert flag:', flagErr.message);
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
      const chat = await notification.getChat();
      if (!chat || !chat.isGroup) return;
      const groupId = chat.id._serialized;
      if (groupId === masterGroupId) return; // ignore master group itself

      const existing = getGroup(groupId);
      if (!existing) {
        saveGroup(groupId, chat.name);
        console.log(`[WhatsApp] Added to new group: "${chat.name}" (${groupId})`);
        if (masterGroupId) {
          const question = `🆕 נוספתי לקבוצה חדשה: *${chat.name}*\nלמי הקבוצה קשורה? מעוניינים במעקב? (ענו בתגובה להודעה זו)`;
          const sentMsg = await client.sendMessage(masterGroupId, question);
          if (sentMsg) {
            pendingGroupQuestions.set(sentMsg.id._serialized, groupId);
            savePendingGroupQuestion(sentMsg.id._serialized, groupId);
            addToHistory('assistant', question);
          }
        }
      } else if (existing.related_to !== 'monitored') {
        console.log(`[WhatsApp] Re-added to known group: "${chat.name}"`);
      }
    } catch (err) {
      console.error('[WhatsApp] group_join handler error:', err.message);
    }
  });

  client.on('auth_failure', (msg) => {
    console.error('[WhatsApp] Authentication failed:', msg);
    // ISSUE-009: log with timestamp so exact drop time is always visible
    const { checkAndAlert } = require('./health');
    checkAndAlert().catch(() => {});
  });

  client.on('disconnected', (reason) => {
    // ISSUE-009: log with ISO timestamp so the exact drop time is always visible in logs
    console.warn(`[WhatsApp] Client disconnected at ${new Date().toISOString()}: ${reason}`);
    // Trigger health alert immediately (before client fully shuts down)
    const { sendAlertDirect } = require('./health');
    if (sendAlertDirect) {
      sendAlertDirect(`WhatsApp disconnected: ${reason}. Bot will stop receiving messages until re-linked.`).catch(() => {});
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[FamilyBot] Received SIGINT. Shutting down gracefully...');
    try { await client.destroy(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Pre-filter: skip non-text and trivially short/emoji-only messages
  const SKIP_MSG_TYPES = new Set(['sticker', 'image', 'audio', 'video', 'location', 'vcard']); // 'document' removed — PDFs/Word/Excel are parsed by media-parser
  const SKIP_REGEX = /^[\p{Emoji_Presentation}\s]{1,10}$|^(אוקיי|תודה|👍|ok|כן|לא|yes|no|ממ|יופי|ברור|בסדר|wow|nice)$/iu;

  client.on('message', async (msg) => {
    try {
      _lastActivityMs = Date.now(); // track last WA activity for health checks

      // Babysitter DM routing — forward to booking microservice
      if (!msg.from.endsWith('@g.us') && !msg.fromMe) {
        try {
          // Resolve JID to phone (handles both @c.us and @lid LID format)
          const phone = getPhoneByJid(msg.from);
          console.log('[WhatsApp] DM from JID:', msg.from, '→ phone:', phone || '(unknown)');
          if (phone) {
            const ts = new Date(msg.timestamp * 1000).toISOString();
            await forwardToBabysitterService(phone, msg.body || '', ts);
            console.log('[WhatsApp] Babysitter DM forwarded:', phone, msg.body?.substring(0, 30));
          }
        } catch (e) {
          console.error('[WhatsApp] DM routing error:', e.message);
        }
        return;
      }

      // Only handle group messages
      if (!msg.from.endsWith('@g.us')) return;

      // Skip non-actionable messages before any DB or API calls
      if (SKIP_MSG_TYPES.has(msg.type)) return;
      const msgText = msg.body?.trim() || '';
      if (msgText.length < 6 && msg.from !== masterGroupId) return;
      if (SKIP_REGEX.test(msgText) && msg.from !== masterGroupId) return;

      const msgId = msg.id._serialized;

      // â"€â"€ Feature 2c: Master group reply handling â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
      if (masterGroupId && msg.from === masterGroupId && msg.hasQuotedMsg) {
        try {
          const quotedMsg = await msg.getQuotedMessage();
          const quotedId = quotedMsg.id._serialized;

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
              console.log(`[WhatsApp] Group "${groupName}" context saved: "${relatedTo}"`);
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
                  console.log(`[WhatsApp] Group "${matchedGroup.name}" context saved (pattern match): "${relatedTo}"`);
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
              console.log(`[WhatsApp] Follow-up marked done: "${followUp.event_title}"`);
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
              const { events: fuEvents } = await extractFromText(msg.body, masterGroupHistory.slice(-5));
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
          console.error('[WhatsApp] Error handling master group reply:', err.message);
        }
      }

      // â"€â"€ Master group command handling â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
      // Any non-fromMe message in the master group (not a pending-question reply) is a command
      if (masterGroupId && msg.from === masterGroupId && !msg.fromMe) {
        if (isMessageProcessed(msgId)) return;
        markMsgProcessed(msgId);

        // Babysitter onboarding reply detection
        const handled = await handleOnboardingReply(msg.body || '', sendToMasterGroup).catch(() => false);
        if (handled) return;

        // Free-text yes/no fallback for active follow-up (user replied without quoting)
        const freeText = msg.body.trim();
        const freeIsYes = /^(\u2705|כן|כ|yes|done|ביצעתי|עשיתי|בוצע)$/i.test(freeText);
        const freeIsNo  = /^(\u274c|לא|ל|no|not yet|טרם)$/i.test(freeText);
        if (freeIsYes || freeIsNo) {
          try {
            const activeFollowUp = getDB().prepare(
              "SELECT * FROM follow_ups WHERE status='asked' ORDER BY id DESC LIMIT 1"
            ).get();
            if (activeFollowUp) {
              if (freeIsYes) {
                updateFollowUpStatus(activeFollowUp.id, 'done');
                await client.sendMessage(masterGroupId, '✅ מעולה! רשמתי שביצעת.');
                console.log(`[WhatsApp] Follow-up (free-text) marked done: "${activeFollowUp.event_title}"`);
              } else {
                updateFollowUpStatus(activeFollowUp.id, 'rescheduling');
                await client.sendMessage(masterGroupId, '⏰ בסדר. לאיזה יום ושעה לדחות?');
              }
              return;
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
            console.log('[Dismissal] Parsed:', JSON.stringify(parsed));

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
              console.log(`[Dismissal] Confirmed to master group: ${confirmMsg}`);
              return;
            }
          } catch (e) {
            console.error('[Dismissal] Error:', e.message);
            // Fall through to normal command handling
          }
        }
        // ── End dismissal detection ───────────────────────────────────────────

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
          saveMessage({ group_id: (ctxChat && ctxChat.id && ctxChat.id._serialized) || msg.from, sender: ctxSender, body: ctxBody, timestamp: msg.timestamp * 1000 });
        } catch (_) {}
        // Full parse+act only for substantial text messages
        if (msgText.length >= 6 && !SKIP_REGEX.test(msgText)) {
          await handleGroupMessage(msg, { alreadySaved: true });
        }
      } else if (msg.from !== masterGroupId) {
        // Message from unknown/unmonitored group -- notify master group if new
        try {
          const chat = await msg.getChat();
          if (chat.isGroup) {
            const existing = getGroup(chat.id._serialized);
            if (!existing && masterGroupId) {
              saveGroup(chat.id._serialized, chat.name);
              const question = `🆕 נוספתי לקבוצה: *${chat.name}*\nלמי הקבוצה קשורה? מעוניינת במעקב? (ענו בתגובה להודעה זו)`;
              const sentMsg = await client.sendMessage(masterGroupId, question);
              pendingGroupQuestions.set(sentMsg.id._serialized, chat.id._serialized);
              savePendingGroupQuestion(sentMsg.id._serialized, chat.id._serialized);
              console.log(`[WhatsApp] New group detected live: "${chat.name}"`);
            }
          }
        } catch (err) {
          console.error('[WhatsApp] New group detection error:', err.message);
        }
      }
    } catch (err) {
      console.error('[WhatsApp] message handler error:', err.message);
    }
  });

  console.log('[WhatsApp] Initializing client...');
  client.initialize();

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

