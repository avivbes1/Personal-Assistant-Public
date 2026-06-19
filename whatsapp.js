/**
 * whatsapp.js â€" WhatsApp client using whatsapp-web.js with LocalAuth.
 * Monitors specified groups and handles incoming messages.
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const { saveMessage, saveEvent, saveActionItem, saveClarification, saveGroup, setGroupRelatedTo, setGroupDescription, getGroup, getMonitoredGroupsWithoutDescription, getAllPendingGroupQuestions, savePendingGroupQuestion, getPendingGroupQuestion, deletePendingGroupQuestion, isMessageProcessed, markMsgProcessed, getDB, addToConversationHistory, getConversationHistory, setPendingAction, getPendingAction, clearPendingAction, cancelRemindersForEvent } = require('./db');
const { resolveMembersInText } = require('./family-profiles');
const { extractFromText, detectMissingParams, buildClarificationQuestion, resolvePartialEvent } = require('./parser');
const { processMediaMessage, isSchoolGroup } = require('./media-parser');
const { addEvent, addSharedEvent, searchCalendarEvents, updateCalendarEvent, deleteCalendarEvent } = require('./calendar');
const { scheduleRemindersForEvent, scheduleFollowUpForEvent } = require('./scheduler');
const { answerQuery } = require('./query');
const { getFollowUpByBotMsgId, updateFollowUpStatus } = require('./db');

let client = null;
let masterGroupId = null;

// Rolling conversation history for master group (last 20 messages — in-memory fallback)
const masterGroupHistory = []; // { role: 'user'|'assistant', content: string }
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
    const isMedia = !body.trim() && ['image', 'sticker', 'document', 'audio', 'video', 'location', 'vcard'].includes(msg.type);
    if (isMedia) {
      const extracted = await processMediaMessage(msg, groupRecord, chat.name).catch(() => null);
      if (extracted) {
        body = extracted;
        console.log(`[WhatsApp] Media extracted from "${chat.name}": ${extracted.substring(0, 80)}`);
      } else {
        const mediaLabel = { image: '[תמונה]', video: '[וידאו]', audio: '[הקלטה קולית]', document: '[מסמך]', sticker: '[מדבקה]', location: '[מיקום]' };
        body = mediaLabel[msg.type] || '[מדיה]';
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

    // Build group context for parser (groupRecord already fetched above)
    const groupContext = (groupRecord && groupRecord.description)
      ? { name: chat.name, description: groupRecord.description }
      : null;

    // Parse for events and action items
    const { events, actionItems } = await extractFromText(body, [], groupContext);

    let responded = false;

    // Handle events
    for (const event of events) {
      const eventId = saveEvent({
        message_id: messageId,
        title: event.title,
        start_time: event.start_time,
        end_time: event.end_time,
        location: event.location,
        calendar_owner: 'both',
      });

      // Add as shared event (Aviv organizer, Liat invited)
      let gcalEvent = null;
      try {
        gcalEvent = await addSharedEvent(event, 'both');
        if (gcalEvent) { scheduleRemindersForEvent(gcalEvent, 'both'); scheduleFollowUpForEvent(gcalEvent, 'both'); }
      } catch (e) {
        console.error('[WhatsApp] Failed to add shared event:', e.message);
      }

      let dateStr = '';
      if (event.start_time) {
        const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(event.start_time.trim()) || event.start_time.includes('T00:00:00');
        dateStr = isDateOnly
          ? new Date(event.start_time).toLocaleDateString('he-IL', { timeZone: config.TIMEZONE, day: 'numeric', month: 'numeric', year: 'numeric' })
          : new Date(event.start_time).toLocaleString('he-IL', { timeZone: config.TIMEZONE });
      }
      let confirmMsg = `📅 *זיהיתי אירוע מ"${chat.name}"*\n`;
      confirmMsg += `${event.title}${dateStr ? ` - ${dateStr}` : ''}\n`;
      if (event.location) confirmMsg += `📍 ${event.location}\n`;
      confirmMsg += gcalEvent ? '✅ הוסף ליומן' : '❌ שגיאה בהוספה ליומן';
      await sendToMasterGroup(confirmMsg);
      responded = true;
    }

    // Handle action items
    for (const item of actionItems) {
      saveActionItem({
        message_id: messageId,
        description: item.description,
        due_date: item.due_date,
      });

      const actionMsg = `ðŸ" *Action item from "${chat.name}"*\n${item.description}${item.due_date ? `\nDue: ${new Date(item.due_date).toLocaleDateString('he-IL', { timeZone: config.TIMEZONE })}` : ''}`;
      await sendToMasterGroup(actionMsg);
      responded = true;
    }

    // Ask for clarification if the message seems event-like but no date was found
    if (events.length > 0) {
      const hasTime = events.some(e => e.start_time);
      if (!hasTime) {
        const question = `🆕 נוספתי לקבוצה חדשה: *${chat.name}*
למי הקבוצה קשורה? מעוניינים במעקב? (ענו בתגובה להודעה זו)`;
        saveClarification({ message_id: messageId, question });
        await sendToMasterGroup(question);
        responded = true;
      }
    }

  } catch (err) {
    console.error('[WhatsApp] handleGroupMessage error:', err.message);
  }
}

// Authorized identifiers - phone numbers OR WhatsApp LIDs (new privacy format)
const ALLOWED_NUMBERS = new Set([
  '972504606660', // Aviv phone
  '972509244401', // Liat phone
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
 * Handle a command message sent directly to the master group.
 * Only authorized family members can issue commands.
 * Only processes if explicitly addressed to the bot by name.
 */
async function handleMasterGroupCommand(msg) {
  if (!(await isSenderAuthorized(msg))) return;
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

    // When user replies to a bot message, inject the quoted text so the parser has full context
    // e.g. "תמחק את זה" + quoted reminder → parser knows which event
    const parseText = quotedFromMe && quotedBody
      ? `${cleanBody} [ההודעה המצוטטת: ${quotedBody}]`
      : cleanBody;

    const { events, actionItems, intent, update, delete: deleteIntent } = await extractFromText(parseText, priorHistory);

    // ── Handle calendar event updates ──────────────────────────────────────────
    if (intent === 'update' && update) {
      const { search_title, changes } = update;
      if (!search_title) {
        await sendToMasterGroup('לא הבנתי איזה אירוע לעדכן — תוכלו לפרט יותר?');
      } else {
        await sendToMasterGroup(`🔍 מחפש בלוח שנה: "${search_title}"...`);
        const results = await searchCalendarEvents(search_title);
        if (results.length === 0) {
          await sendToMasterGroup(`לא מצאתי אירוע בשם "${search_title}" בלוח השנה. ייתכן שהוא לא קיים או הכותרת שונה.`);
        } else if (results.length > 3) {
          const list = results.slice(0, 5).map(r => {
            const dt = r.event.start?.dateTime || r.event.start?.date || '';
            const dateLabel = dt ? new Date(dt).toLocaleDateString('he-IL', { timeZone: config.TIMEZONE }) : '';
            return `• ${r.event.summary} (${dateLabel})`;
          }).join('\n');
          await sendToMasterGroup(`מצאתי כמה אירועים — תוכלו לפרט איזה מהם?\n${list}`);
        } else {
          // Build the patch object
          const patch = {};
          if (changes.title) patch.summary = changes.title;
          if (changes.description) patch.description = changes.description;
          if (changes.location) patch.location = changes.location;
          if (changes.start_time) {
            const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(changes.start_time);
            patch.start = isDateOnly
              ? { date: changes.start_time }
              : { dateTime: new Date(changes.start_time).toISOString(), timeZone: config.TIMEZONE };
          }
          if (changes.end_time) {
            const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(changes.end_time);
            patch.end = isDateOnly
              ? { date: changes.end_time }
              : { dateTime: new Date(changes.end_time).toISOString(), timeZone: config.TIMEZONE };
          }

          const updated = [];
          for (const r of results) {
            const res = await updateCalendarEvent(r.calendarId, r.tokenPath, r.event.id, patch);
            if (res) updated.push(res.summary || r.event.summary);
          }

          if (updated.length > 0) {
            const lines = updated.map(t => `• ${t}`).join('\n');
            const confirmMsg = `✅ עודכן בלוח שנה:\n${lines}`;
            await sendToMasterGroup(confirmMsg);
            addToHistory('assistant', confirmMsg);
          } else {
            await sendToMasterGroup('הייתה בעיה בעדכון האירוע — נסו שוב.');
          }
        }
      }
      return;
    }

    // ── Handle calendar event deletion ────────────────────────────────────────
    if (intent === 'delete' && deleteIntent) {
      const { search_title } = deleteIntent;
      if (!search_title) {
        const noTitle = 'לא הבנתי איזה אירוע למחוק — תוכל לפרט?';
        await sendToMasterGroup(noTitle);
        addToHistory('assistant', noTitle, userId);
      } else {
        await sendToMasterGroup(`🔍 מחפש בלוח שנה: "${search_title}"...`);
        const results = await searchCalendarEvents(search_title);
        if (results.length === 0) {
          const notFound = `לא מצאתי אירוע בשם "${search_title}" בלוח השנה.`;
          await sendToMasterGroup(notFound);
          addToHistory('assistant', notFound, userId);
        } else if (results.length > 3) {
          const list = results.slice(0, 5).map(r => {
            const dt = r.event.start?.dateTime || r.event.start?.date || '';
            const dateLabel = dt ? new Date(dt).toLocaleDateString('he-IL', { timeZone: config.TIMEZONE }) : '';
            return `• ${r.event.summary} (${dateLabel})`;
          }).join('\n');
          const tooMany = `מצאתי כמה אירועים — תוכל לפרט יותר?\n${list}`;
          await sendToMasterGroup(tooMany);
          addToHistory('assistant', tooMany, userId);
        } else {
          const deleted = [];
          for (const r of results) {
            const ok = await deleteCalendarEvent(r.calendarId, r.tokenPath, r.event.id);
            if (ok) {
              deleted.push(r.event.summary);
              // Cancel any pending reminders for this event so they don't fire
              const cancelled = cancelRemindersForEvent(r.event.id);
              if (cancelled > 0) console.log(`[WhatsApp] Cancelled ${cancelled} pending reminder(s) for "${r.event.summary}"`);
            }
          }
          if (deleted.length > 0) {
            const doneMsg = `🗑️ נמחק מהיומן:\n${deleted.map(t => `• ${t}`).join('\n')}`;
            await sendToMasterGroup(doneMsg);
            addToHistory('assistant', doneMsg, userId);
          } else {
            const errMsg = 'הייתה שגיאה במחיקה — נסה שוב.';
            await sendToMasterGroup(errMsg);
            addToHistory('assistant', errMsg, userId);
          }
        }
      }
      return;
    }

    if (events.length > 0) {
      // Phase 4: check for missing params before confirming
      if (config.FEATURE_CLARIFICATION_LOOP) {
        const missing = detectMissingParams(events, intent);
        if (missing.length > 0) {
          const q = buildClarificationQuestion(missing, events[0]);
          setPendingAction(userId, 'CLARIFY_EVENT', { partialEvent: events[0], followUpCount: 0 }, missing, q);
          await sendToMasterGroup(q);
          addToHistory('assistant', q, userId);
          console.log(`[Clarify] Asked for missing params (${missing.join(', ')}): "${q}"`);
          return;
        }
      }

      if (config.FEATURE_CONFIRM_ACTIONS) {
        // Phase 3: ask for confirmation before adding to calendar
        const confirmText = buildEventConfirmationText(events);
        setPendingAction(userId, 'ADD_EVENT', { events }, [], confirmText);
        await sendToMasterGroup(confirmText);
        addToHistory('assistant', confirmText, userId);
      } else {
        // Immediate execution (legacy behavior)
        const confirmLines = [];
        for (const event of events) {
          try {
            const owner = event.calendar_owner || 'both';
            const gcalEvent = await addSharedEvent(event, owner);
            if (gcalEvent) { scheduleRemindersForEvent(gcalEvent, owner); scheduleFollowUpForEvent(gcalEvent, owner); }
          } catch (e) {
            console.error('[WhatsApp] addSharedEvent error:', e.message);
          }
          const dt = formatEventDateTime(event.start_time);
          confirmLines.push(`• ${event.title}${dt ? ` – ${dt}` : ''}`);
        }
        const hasAllDay = events.some(e => !e.start_time || /^\d{4}-\d{2}-\d{2}$/.test(e.start_time) || e.start_time.includes('T00:00:00'));
        const reminderNote = hasAllDay
          ? 'תקבל תזכורת 3 ימים לפני, יום לפני, ובדייגסט הבוקר של יום האירוע.'
          : 'תקבל תזכורת ב-60/30/10 דקות לפני ובבוקר בדייגסט.';
        const confirmMsg = `✅ קיבלתי! הוספתי ליומן:\n${confirmLines.join('\n')}\n\n${reminderNote}`;
        await sendToMasterGroup(confirmMsg);
        addToHistory('assistant', confirmMsg, userId);
      }

    } else if (actionItems.length > 0) {
      if (config.FEATURE_CONFIRM_ACTIONS) {
        // Phase 3: ask for confirmation before saving task
        const confirmText = buildTaskConfirmationText(actionItems);
        setPendingAction(userId, 'ADD_TASK', { actionItems, body, senderName }, [], confirmText);
        await sendToMasterGroup(confirmText);
        addToHistory('assistant', confirmText, userId);
      } else {
        // Immediate execution (legacy behavior)
        const messageId = saveMessage({ group_id: masterGroupId, sender: senderName, body, timestamp: msg.timestamp * 1000 });
        const confirmLines = [];
        for (const item of actionItems) {
          saveActionItem({ message_id: messageId, description: item.description, due_date: item.due_date });
          confirmLines.push(`• ${item.description}`);
        }
        const confirmMsg = `✅ קי×'לתי! רשמתי משימ×":\n${confirmLines.join('\n')}`;
        await sendToMasterGroup(confirmMsg);
        addToHistory('assistant', confirmMsg, userId);
      }

    } else {
      // Nothing parsed â€" check if message has any time/date reference â†' treat as reminder
      const hasTimeRef = /\d{1,2}:\d{2}|מ×-ר|×"יום|tomorrow|today|\d{1,2}\/\d{1,2}/.test(cleanBody);
      const reminderKeywords = ['ת×-כורת', 'ל×"×-כיר', 'ת×-כור', 'ת×-כיר', 'remind', 'reminder'];
      const looksLikeReminder = reminderKeywords.some(kw => cleanBody.includes(kw));

      if (hasTimeRef || looksLikeReminder) {
        // Treat the whole message as an action item with a due date
        const messageId = saveMessage({
          group_id: masterGroupId,
          sender: senderName,
          body: cleanBody,
          timestamp: msg.timestamp * 1000,
        });
        saveActionItem({ message_id: messageId, description: cleanBody, due_date: null });
        const reminderMsg = `✅ קי×'לתי ת×-כורת:\n• ${body.substring(0, 100)}\n\nתופיע ×'×"יי×'׳סט של מ×-ר ×'×'וקר.`;
        await sendToMasterGroup(reminderMsg);
        addToHistory('assistant', reminderMsg, userId);
        console.log(`[WhatsApp] Saved as action item: ${body.substring(0, 60)}`);
      } else {
        // Free-form query -- answer conversationally
        // Phase 5 preview: if intent is 'unknown' and not a query → capability self-awareness
        const isQueryLike = intent === 'query' ||
          /\?|מה|איזה|מתי|איפה|כמה|מי|האם|יש לך|ספר|תגיד/.test(cleanBody);

        if (intent === 'unknown' && !isQueryLike && config.FEATURE_CAPABILITY_AWARE) {
          const unknown = 'אני לא יודע לעשות את זה עדיין 🤔';
          await sendToMasterGroup(unknown);
          addToHistory('assistant', unknown, userId);
        } else {
          try {
            console.log('[WhatsApp] No event/task parsed, treating as query.');
            const queryContext = parseText; // includes quoted body context if reply-to-bot
            const answer = await answerQuery(queryContext, priorHistory, resolvedMemberContext);
            await sendToMasterGroup(answer);
            addToHistory('assistant', answer, userId);
          } catch (qErr) {
            console.error('[WhatsApp] answerQuery error:', qErr.message);
          }
        }
      }
    }
  } catch (err) {
    console.error('[WhatsApp] handleMasterGroupCommand error:', err.message);
  }
}

/**
 * Scan the last 72 hours of messages from a group chat and process them.
 */
async function scanGroupHistory(chat) {
  try {
    const msgs = await chat.fetchMessages({ limit: 200 });
    // Save up to 7 days for context; only parse+act on last 24h
    const saveCutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const parseCutoff = Date.now() - (24 * 60 * 60 * 1000);
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

  try {
    await client.sendMessage(masterGroupId, text);
    console.log('[WhatsApp] Sent to master group:', text.substring(0, 60));
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
  try {
    const sentMsg = await client.sendMessage(masterGroupId, text);
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
  try {
    const sentMsg = await client.sendMessage(masterGroupId, text, { mentions: mentionIds });
    console.log('[WhatsApp] Sent with mentions to master group:', text.substring(0, 60));
    return sentMsg.id._serialized;
  } catch (err) {
    // Fallback to plain send if mentions not supported
    console.warn('[WhatsApp] Mentions failed, sending plain:', err.message);
    try {
      const sentMsg = await client.sendMessage(masterGroupId, text);
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
    puppeteer: {
      headless: true,
      executablePath: config.CHROMIUM_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  });

  client.on('qr', (qr) => {
    console.log('\n[WhatsApp] Scan the QR code below to connect:\n');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', async () => {
    console.log('[WhatsApp] ✅ Client connected and ready!');
    await resolveMasterGroup();

    // Wire health monitor with client + master group
    try {
      const { initHealth } = require('./health');
      initHealth(client, masterGroupId);
    } catch (_) {}

    loadPendingGroupQuestionsFromDB();

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
  });

  client.on('authenticated', () => {
    console.log('[WhatsApp] Authenticated.');
  });

  // Detect when the bot is added to a new group (fires even with no text message)
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
  });

  client.on('disconnected', (reason) => {
    console.warn('[WhatsApp] Client disconnected:', reason);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[Besinsky Bot] Received SIGINT. Shutting down gracefully...');
    try { await client.destroy(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Pre-filter: skip non-text and trivially short/emoji-only messages
  const SKIP_MSG_TYPES = new Set(['sticker', 'image', 'audio', 'video', 'document', 'location', 'vcard']);
  const SKIP_REGEX = /^[\p{Emoji_Presentation}\s]{1,10}$|^(אוקיי|תודה|👍|ok|כן|לא|yes|no|ממ|יופי|ברור|בסדר|wow|nice)$/iu;

  client.on('message', async (msg) => {
    try {
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
                  return;
                }
              }
            }
          }

          // -- Follow-up reply --
          const followUp = getFollowUpByBotMsgId(quotedId);
          if (followUp && followUp.status === 'asked') {
            const reply = msg.body.trim();
            const isYes = /^(\u2705|כן|yes|done|ביצעתי|עשיתי)$/i.test(reply);
            const isNo = /^(\u274c|לא|no|not yet)$/i.test(reply);
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
        if (process.env.FEAT_HANDLE_QUESTIONS !== '0') await handleMasterGroupCommand(msg);
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
};

