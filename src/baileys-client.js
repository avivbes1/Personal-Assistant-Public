/**
 * baileys-client.js — Drop-in adapter wrapping @whiskeysockets/baileys
 * to provide a compatible interface with the whatsapp-web.js Client used
 * throughout whatsapp.js, voice-server.js, and other modules.
 *
 * Goal: minimal changes to existing bot code. This adapter translates
 * Baileys events/methods into the shapes the bot already expects.
 */

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  getContentType,
  jidDecode,
  Browsers,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidGroup,
  proto,
} = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const pino = require('pino');
const appLogger = require('./logger');
const { getGroup } = require('./db');
const { captureSystemMessages } = require('./system-message-capture');

const AUTH_DIR = path.join(__dirname, '..', '.baileys_auth');
const STORE_DIR = path.join(__dirname, '..', 'data', 'baileys-store');

// Silent logger for Baileys — prevents signal keys leaking to pm2 logs
const logger = pino({ level: 'silent' });

/**
 * Normalize a JID: strip :0 device suffix, ensure @s.whatsapp.net for users.
 */
function normalizeJid(jid) {
  if (!jid) return jid;
  // Ensure string
  if (typeof jid !== 'string') jid = String(jid);
  // Group JIDs stay as-is
  if (jid.endsWith('@g.us')) return jid;
  // Strip device suffix (e.g. <phone>:0@s.whatsapp.net → <phone>@s.whatsapp.net)
  try {
    const decoded = jidDecode(jid);
    if (decoded) {
      const base = decoded.user;
      const server = decoded.server || 's.whatsapp.net';
      return `${base}@${server}`;
    }
  } catch (_) {}
  return jid;
}

/**
 * Convert @s.whatsapp.net JID to @c.us format (for compatibility with existing code).
 * Normalizes first, so a device suffix (<phone>:0@…) never leaks into the
 * whatsapp-web.js surface and identity comparisons stay stable (H5). `@lid` JIDs
 * keep their server — they are resolved to a phone number elsewhere, not rewritten.
 */
function toWWebJid(jid) {
  if (!jid) return jid;
  if (jid.endsWith('@g.us')) return jid;
  jid = normalizeJid(jid);
  return jid.replace('@s.whatsapp.net', '@c.us');
}

/**
 * Extract the stanzaId (the stable WhatsApp message id) from either a serialized
 * id string (`fromMe_remoteJid_stanzaId[_participant]`) or an id object.
 * The stanzaId is the only identifier that is stable in both the sent-message
 * direction and the quoted-reply direction, so lookups fall back to it (H1).
 */
function stanzaIdOf(id) {
  if (!id) return null;
  if (typeof id === 'object') return id.id || null;
  const parts = String(id).split('_');
  return parts.length >= 3 ? parts[2] : null;
}

/**
 * Convert @c.us JID to @s.whatsapp.net (Baileys format).
 * Normalizes first (strips device suffix). `@lid` JIDs pass through with their
 * server intact — they are not phone numbers and must be resolved, not rewritten.
 */
function toBaileysJid(jid) {
  if (!jid) return jid;
  if (jid.endsWith('@g.us')) return jid;
  jid = normalizeJid(jid);
  if (jid.endsWith('@s.whatsapp.net')) return jid;
  if (jid.endsWith('@lid')) return jid;
  return jid.replace('@c.us', '@s.whatsapp.net');
}

/**
 * BaileysMessage — wraps a Baileys message to look like a whatsapp-web.js Message.
 */
class BaileysMessage {
  constructor(client, rawMsg) {
    this._client = client;
    this._raw = rawMsg;
    const key = rawMsg.key;
    const content = rawMsg.message || {};

    // ID object compatible with whatsapp-web.js
    const serialized = `${key.fromMe ? 'true' : 'false'}_${toWWebJid(key.remoteJid)}_${key.id}${key.participant ? '_' + toWWebJid(key.participant) : ''}`;
    this.id = {
      fromMe: key.fromMe || false,
      remote: toWWebJid(key.remoteJid),
      id: key.id,
      participant: key.participant ? toWWebJid(key.participant) : undefined,
      _serialized: serialized,
    };

    this.from = toWWebJid(key.remoteJid);
    this.to = key.fromMe ? toWWebJid(key.remoteJid) : toWWebJid(client._myJid);
    this.author = key.participant ? toWWebJid(key.participant) : (key.fromMe ? toWWebJid(client._myJid) : this.from);
    this.fromMe = key.fromMe || false;
    this.timestamp = rawMsg.messageTimestamp ? Number(rawMsg.messageTimestamp) : Math.floor(Date.now() / 1000);

    // Determine message type
    const contentType = getContentType(content);
    this.type = this._mapType(contentType, content);

    // Body text
    this.body = this._extractBody(content, contentType);

    // Media check
    this.hasMedia = ['image', 'video', 'audio', 'ptt', 'document', 'sticker'].includes(this.type);

    // Quoted message check
    const contextInfo = this._getContextInfo(content, contentType);
    this.hasQuotedMsg = !!(contextInfo && contextInfo.quotedMessage);
    this._contextInfo = contextInfo;

    // Mentions
    this.mentionedIds = (contextInfo && contextInfo.mentionedJid) ?
      contextInfo.mentionedJid.map(j => toWWebJid(j)) : [];
  }

  _mapType(contentType, content) {
    if (!contentType) return 'chat';
    if (contentType.includes('image')) return 'image';
    if (contentType.includes('video')) return 'video';
    if (contentType.includes('audio') || contentType.includes('ptt')) return 'ptt';
    if (contentType.includes('document')) return 'document';
    if (contentType.includes('sticker')) return 'sticker';
    if (contentType.includes('location')) return 'location';
    if (contentType.includes('contact')) return 'vcard';
    if (contentType.includes('reaction')) return 'reaction_message';
    if (contentType.includes('poll')) return 'poll_creation';
    return 'chat';
  }

  _extractBody(content, contentType) {
    if (!content || !contentType) return '';
    const inner = content[contentType];
    if (!inner) return '';
    // Text messages
    if (typeof inner === 'string') return inner;
    // Extended text
    if (inner.text) return inner.text;
    // Caption for media
    if (inner.caption) return inner.caption;
    // Conversation
    if (content.conversation) return content.conversation;
    return '';
  }

  _getContextInfo(content, contentType) {
    if (!content || !contentType) return null;
    const inner = content[contentType];
    if (inner && inner.contextInfo) return inner.contextInfo;
    return null;
  }

  /**
   * Get the quoted message (compatible with whatsapp-web.js msg.getQuotedMessage()).
   *
   * ISSUE-023 (H1): fromMe must be determined BEFORE constructing BaileysMessage,
   * because the constructor computes id._serialized once from key.fromMe/participant
   * and never recomputes it. When the quoted message was sent by the bot, we omit
   * the participant from the key so the reconstructed _serialized matches exactly
   * what sendMessage() returned for that message (bot sends carry no participant).
   */
  async getQuotedMessage() {
    if (!this.hasQuotedMsg || !this._contextInfo) {
      throw new Error('No quoted message');
    }
    const ci = this._contextInfo;
    // Determine fromMe up front by comparing the quoted participant to the bot JID.
    // H5: a LID-form participant (<n>@lid) never equals the phone-form bot JID, so
    // resolve it to a phone JID first — otherwise every quoted reply to the bot in a
    // privacy-mode group looks like it came from a human (a silent ISSUE-023 repeat).
    const myJid = normalizeJid(this._client._myJid);
    let quotedParticipant = ci.participant ? normalizeJid(ci.participant) : null;
    if (quotedParticipant && quotedParticipant.endsWith('@lid') &&
        typeof this._client._resolveLidToPhone === 'function') {
      const resolved = await this._client._resolveLidToPhone(quotedParticipant);
      if (resolved) quotedParticipant = normalizeJid(resolved);
    }
    const fromMe = quotedParticipant ? (quotedParticipant === myJid) : false;

    // Build a pseudo-message from the quoted context. When fromMe, omit participant
    // so _serialized mirrors sendMessage()'s return (true_<group>_<stanzaId>).
    const quotedKey = {
      fromMe,
      remoteJid: this._raw.key.remoteJid,
      id: ci.stanzaId,
      participant: fromMe ? undefined : ci.participant,
    };
    const quotedRaw = {
      key: quotedKey,
      message: ci.quotedMessage,
      messageTimestamp: 0,
    };
    return new BaileysMessage(this._client, quotedRaw);
  }

  /**
   * Get contact info for the message sender.
   */
  async getContact() {
    const jid = this.author || this.from;
    return this._client._getContact(jid);
  }

  /**
   * Get the chat this message belongs to.
   */
  async getChat() {
    return this._client.getChatById(this.from);
  }

  /**
   * Download media from the message.
   * Returns { mimetype, data (base64), filename } compatible with whatsapp-web.js.
   */
  async downloadMedia() {
    if (!this.hasMedia) throw new Error('No media in message');
    const buffer = await downloadMediaMessage(this._raw, 'buffer', {}, {
      logger,
      reuploadRequest: this._client._sock.updateMediaMessage,
    });
    const contentType = getContentType(this._raw.message);
    const inner = this._raw.message[contentType] || {};
    return {
      mimetype: inner.mimetype || 'application/octet-stream',
      data: buffer.toString('base64'),
      filename: inner.fileName || null,
    };
  }
}

/**
 * BaileysChat — wraps group/chat metadata to look like a whatsapp-web.js Chat.
 */
class BaileysChat {
  constructor(client, jid, metadata) {
    this._client = client;
    const wwebJid = toWWebJid(jid);
    this.id = {
      _serialized: wwebJid,
      server: jid.endsWith('@g.us') ? 'g.us' : 'c.us',
      user: jid.split('@')[0],
    };
    this.isGroup = jid.endsWith('@g.us');
    this.name = (metadata && metadata.subject) || (metadata && metadata.name) || wwebJid;

    if (this.isGroup && metadata) {
      this.groupMetadata = {
        participants: (metadata.participants || []).map(p => ({
          id: { _serialized: toWWebJid(p.id), user: p.id.split('@')[0] },
          isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
          isSuperAdmin: p.admin === 'superadmin',
        })),
        desc: metadata.desc || '',
        owner: metadata.owner ? toWWebJid(metadata.owner) : undefined,
      };
    }
  }

  async fetchMessages(opts = {}) {
    // Baileys doesn't have a direct fetchMessages equivalent
    // Return empty for now — chat history is handled via store
    return [];
  }
}

/**
 * BaileysClient — main adapter class. Drop-in replacement for whatsapp-web.js Client.
 */
class BaileysClient extends EventEmitter {
  constructor() {
    super();
    this._sock = null;
    this._myJid = null;
    this._groupCache = new Map(); // jid → metadata
    this._contactCache = new Map(); // jid → {pushname, number, ...}
    this._ready = false;
    this._qrEmitted = false;

    // Compatibility: whatsapp-web.js client.info
    this.info = {
      wid: { _serialized: null, user: null },
      pushname: process.env.BOT_PUSH_NAME || 'WhatsApp Bot',
    };
  }

  /**
   * Initialize the Baileys connection. Call this instead of client.initialize().
   */
  async initialize() {
    // Ensure auth dir exists
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const { version } = await fetchLatestBaileysVersion();
    appLogger.info({ component: 'Baileys', waVersion: version.join('.') }, 'Using WA version');

    this._sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: [process.env.BOT_PUSH_NAME || 'WhatsApp Bot', 'Chrome', '131.0.0'],
      printQRInTerminal: false, // We handle QR ourselves
      logger,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: true,
    });

    // ── Health probe: track the live socket (attach once, update on reconnect) ──
    try {
      const healthProbe = require('./health-probe');
      if (this._healthProbeAttached) {
        healthProbe.updateSocket(this._sock);
      } else {
        healthProbe.attachSocket(this._sock);
        this._healthProbeAttached = true;
      }
    } catch (_) {}

        // ── Connection events ──
    this._sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        appLogger.info({ component: 'Baileys' }, 'QR code received');
        this.emit('qr', qr);
        this._qrEmitted = true;
      }

      if (connection === 'open') {
        this._myJid = normalizeJid(this._sock.user.id);
        this.info.wid._serialized = toWWebJid(this._myJid);
        this.info.wid.user = this._myJid.split('@')[0];
        this.info.pushname = this._sock.user.name || process.env.BOT_PUSH_NAME || 'WhatsApp Bot';
        this._ready = true;
        appLogger.info({ component: 'Baileys', jid: this.info.wid._serialized }, 'Connected');
        this.emit('authenticated');
        this.emit('ready');

        // ── System message capture: attach inbound-DM capture to this socket.
        // initialize() creates a fresh socket on every (re)connect, so guard by
        // socket identity to avoid double-attaching if 'open' fires twice on the
        // same socket (updateSocket pattern).
        try {
          if (this._captureSocket !== this._sock) {
            captureSystemMessages(this._sock);
            this._captureSocket = this._sock;
          }
        } catch (err) {
          appLogger.error({ component: 'Baileys', err: err.message }, 'Failed to attach system message capture');
        }

        // ── Watchdog: attach to socket on connection open ──
        const watchdog = require('./watchdog');
        watchdog.attachToSocket(this._sock, (action, reason) => {
          console.error(`[Watchdog] Zombie detected: ${reason}, action: ${action}`);
          if (action === 'reconnect') {
            try { this._sock.ws.close(); } catch (_) {}
            // reconnect logic in connection close handler will handle re-init
          } else if (action === 'escalate') {
            fs.writeFileSync('/tmp/bot-stuck-alert.json', JSON.stringify({
              ts: Date.now(), msg: `Bot zombie 3x in 1h: ${reason}. Needs manual re-pair.`
            }));
          }
        });
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        appLogger.warn({ component: 'Baileys', statusCode, shouldReconnect }, 'Connection closed');

        if (statusCode === DisconnectReason.loggedOut) {
          appLogger.error({ component: 'Baileys' }, 'Logged out. Need to re-authenticate.');
          this.emit('auth_failure', 'Logged out');
        } else if (shouldReconnect) {
          appLogger.info({ component: 'Baileys', statusCode }, 'Transient disconnect. Reconnecting...');
          this._ready = false;
          // Baileys v7 does NOT auto-reconnect — we must create a new socket
          const delay = statusCode === 515 ? 2000 : 5000;
          setTimeout(() => {
            appLogger.info({ component: 'Baileys', statusCode }, 'Reconnecting now');
            this.initialize().catch(err => {
              appLogger.error({ component: 'Baileys', err: err.message }, 'Reconnect failed');
            });
          }, delay);
          if (this._disconnectTimer) clearTimeout(this._disconnectTimer);
          this._disconnectTimer = setTimeout(() => {
            if (!this._ready) {
              appLogger.warn({ component: 'Baileys' }, 'Still disconnected after 5min — alerting');
              this.emit('disconnected', `status_${statusCode}`);
            }
            this._disconnectTimer = null;
          }, 300000);
        }
      }
    });

    // ── Credentials update ──
    this._sock.ev.on('creds.update', (creds) => {
      saveCreds(creds);
      try { require('./watchdog').onHeartbeat(); } catch (_) {}
    });

    // ── Incoming messages ──
    this._sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return; // Only process new messages, not history sync

      // Watchdog: track real-time message receipt
      try { require('./watchdog').onNotify(); } catch (_) {}

      for (const rawMsg of messages) {
        try {
          // Skip own messages to prevent infinite self-reply loops
          if (rawMsg.key.fromMe) continue;

          // ── D1: Reaction capture ──
          // Reactions arrive as ordinary messages carrying a reactionMessage payload
          // (its .key identifies the message being reacted to). Emit a dedicated
          // event BEFORE the no-content skip below, then stop — a reaction is never a
          // normal chat message. targetFromMe lets whatsapp.js gate on bot messages
          // without a DB round-trip; an empty emoji means the reaction was removed.
          const reaction = rawMsg.message && rawMsg.message.reactionMessage;
          if (reaction) {
            try {
              const targetKey = reaction.key || {};
              this.emit('message_reaction', {
                emoji: reaction.text || '',
                targetStanzaId: targetKey.id || null,
                targetGroupId: toWWebJid(targetKey.remoteJid || rawMsg.key.remoteJid),
                targetFromMe: !!targetKey.fromMe,
                reactorJid: toWWebJid(rawMsg.key.participant || rawMsg.key.remoteJid),
              });
            } catch (err) {
              appLogger.error({ component: 'Baileys', err: err.message }, 'Error processing reaction');
            }
            continue;
          }

          // Skip protocol messages, status updates
          if (!rawMsg.message) continue;
          if (rawMsg.key.remoteJid === 'status@broadcast') continue;

          const msg = new BaileysMessage(this, rawMsg);

          // Cache contact info from pushName
          if (rawMsg.pushName && rawMsg.key.participant) {
            this._contactCache.set(toWWebJid(rawMsg.key.participant), {
              pushname: rawMsg.pushName,
              number: rawMsg.key.participant.split('@')[0],
              id: { _serialized: toWWebJid(rawMsg.key.participant), user: rawMsg.key.participant.split('@')[0] },
            });
          } else if (rawMsg.pushName && !rawMsg.key.fromMe) {
            this._contactCache.set(toWWebJid(rawMsg.key.remoteJid), {
              pushname: rawMsg.pushName,
              number: rawMsg.key.remoteJid.split('@')[0],
              id: { _serialized: toWWebJid(rawMsg.key.remoteJid), user: rawMsg.key.remoteJid.split('@')[0] },
            });
          }

          // Emit whatsapp-web.js compatible event
          this.emit('message_create', msg);
        } catch (err) {
          appLogger.error({ component: 'Baileys', err: err.message }, 'Error processing message');
        }
      }
    });

    // ── Message edits (E1) ──
    // Baileys delivers edits via messages.update, not messages.upsert. The edited
    // payload can arrive under a couple of shapes depending on the WA version, so
    // detection is deliberately defensive. We emit message_edit with the new body;
    // whatsapp.js re-queues the stored message for extraction.
    this._sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        try {
          const editMsg = update.update?.message?.editedMessage
            || update.update?.message?.protocolMessage?.editedMessage
            || update.update?.message?.protocolMessage?.editedMessage?.message;
          if (!editMsg) continue;

          const key = update.key;
          const stanzaId = key?.id;
          const groupId = key?.remoteJid;
          if (!stanzaId || !groupId) continue;

          // The edited content may be nested one level under .message (protocol edits).
          const inner = editMsg.message || editMsg;
          const newBody = inner.conversation
            || inner.extendedTextMessage?.text
            || inner.imageMessage?.caption
            || inner.videoMessage?.caption
            || '';

          if (!newBody) continue;

          this.emit('message_edit', { stanzaId, groupId, newBody, key, update });
        } catch (err) {
          appLogger.error({ component: 'Baileys', err: err.message }, 'Error processing message edit');
        }
      }
    });

    // ── Group events ──
    this._sock.ev.on('groups.upsert', (groups) => {
      for (const group of groups) {
        appLogger.info({ component: 'Baileys', groupSubject: group.subject, groupId: group.id }, 'Group upsert');
        this._groupCache.set(group.id, group);

        // Fallback new-group detection: when the bot is added to a group, Baileys
        // often fires groups.upsert WITHOUT group-participants.update, so the
        // group_join handler below never runs. If this group is unknown to us,
        // emit group_join here (same shape as the group-participants.update path).
        try {
          if (!getGroup(group.id)) {
            appLogger.info({ component: 'Baileys', groupId: group.id }, 'New group detected via upsert (participants.update did not fire)');
            this.emit('group_join', {
              chatId: group.id,
              participants: [],
              type: 'add',
              // Compatibility method
              getChat: async () => this.getChatById(group.id),
            });
          }
        } catch (err) {
          appLogger.error({ component: 'Baileys', err: err.message, groupId: group.id }, 'Error in groups.upsert new-group detection');
        }
      }
      try { require('./watchdog').onHeartbeat(); } catch (_) {}
    });

    this._sock.ev.on('groups.update', (updates) => {
      for (const update of updates) {
        const existing = this._groupCache.get(update.id);
        if (existing) {
          Object.assign(existing, update);
        }
        appLogger.info({ component: 'Baileys', groupId: update.id, subject: update.subject || '' }, 'Group update');
      }
      try { require('./watchdog').onHeartbeat(); } catch (_) {}
    });

    // Group participant events → emit group_join for bot additions
    this._sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
      const myJid = normalizeJid(this._myJid);
      const iAmIncluded = participants.some(p => normalizeJid(typeof p === "string" ? p : (p?.id || p?.jid || p?.lid || "")) === myJid);

      if (action === 'add' && iAmIncluded) {
        appLogger.info({ component: 'Baileys', groupId: id }, 'Bot added to group');
        // Emit group_join compatible event
        this.emit('group_join', {
          chatId: id,
          participants,
          type: 'add',
          // Compatibility method
          getChat: async () => this.getChatById(id),
        });
      }

      if (action === 'remove' && iAmIncluded) {
        appLogger.info({ component: 'Baileys', groupId: id }, 'Bot removed from group');
      }
    });

    // ── Contacts update ──
    this._sock.ev.on('contacts.upsert', (contacts) => {
      try { require('./watchdog').onHeartbeat(); } catch (_) {}
      for (const contact of contacts) {
        if (contact.id) {
          this._contactCache.set(toWWebJid(contact.id), {
            pushname: contact.notify || contact.name || contact.id.split('@')[0],
            number: contact.id.split('@')[0],
            id: { _serialized: toWWebJid(contact.id), user: contact.id.split('@')[0] },
            name: contact.name,
          });
        }
      }
    });

    // Pre-load group metadata for all groups
    this._preloadGroups();
  }

  async _preloadGroups() {
    // Wait for connection
    const waitForReady = () => new Promise(resolve => {
      if (this._ready) return resolve();
      this.once('ready', resolve);
    });
    await waitForReady();

    try {
      const groups = await this._sock.groupFetchAllParticipating();
      for (const [jid, meta] of Object.entries(groups)) {
        this._groupCache.set(jid, meta);
      }
      appLogger.info({ component: 'Baileys', count: Object.keys(groups).length }, 'Pre-loaded groups');
    } catch (err) {
      appLogger.error({ component: 'Baileys', err: err.message }, 'Failed to preload groups');
    }
  }

  /**
   * Send a message. Compatible with whatsapp-web.js client.sendMessage().
   * @param {string} chatId — JID in either @c.us or @s.whatsapp.net format
   * @param {string|object} content — text string or MessageMedia object
   * @param {object} options — { mentions: [jid], ... }
   * @returns {BaileysMessage}
   */
  async sendMessage(chatId, content, options = {}) {
    const jid = toBaileysJid(chatId);

    let msgContent;

    if (typeof content === 'string') {
      // Text message
      msgContent = { text: content };

      // Handle mentions
      if (options.mentions && options.mentions.length > 0) {
        msgContent.mentions = options.mentions.map(m => toBaileysJid(m));
      }
    } else if (content && content.mimetype) {
      // MessageMedia-like object (base64 data)
      const buffer = Buffer.from(content.data, 'base64');
      if (content.mimetype.startsWith('audio/')) {
        msgContent = {
          audio: buffer,
          mimetype: content.mimetype,
          ptt: options.sendAudioAsVoice || content.mimetype.includes('ogg'),
        };
      } else if (content.mimetype.startsWith('image/')) {
        msgContent = {
          image: buffer,
          mimetype: content.mimetype,
          caption: options.caption || '',
        };
      } else if (content.mimetype.startsWith('video/')) {
        msgContent = {
          video: buffer,
          mimetype: content.mimetype,
          caption: options.caption || '',
        };
      } else {
        msgContent = {
          document: buffer,
          mimetype: content.mimetype,
          fileName: content.filename || 'file',
        };
      }
    } else {
      // Fallback: treat as text
      msgContent = { text: String(content) };
    }

    const sent = await this._sock.sendMessage(jid, msgContent);

    // Build compatible return value
    const sentMsg = new BaileysMessage(this, {
      key: sent.key,
      message: sent.message || msgContent,
      messageTimestamp: Math.floor(Date.now() / 1000),
    });

    return sentMsg;
  }

  /**
   * Get all chats. Compatible with whatsapp-web.js client.getChats().
   */
  async getChats() {
    const chats = [];

    // Groups from cache
    for (const [jid, meta] of this._groupCache) {
      chats.push(new BaileysChat(this, jid, meta));
    }

    return chats;
  }

  /**
   * Get a chat by ID. Compatible with whatsapp-web.js client.getChatById().
   */
  async getChatById(chatId) {
    const jid = toBaileysJid(chatId);

    if (isJidGroup(jid)) {
      let meta = this._groupCache.get(jid);
      if (!meta) {
        try {
          meta = await this._sock.groupMetadata(jid);
          this._groupCache.set(jid, meta);
        } catch (err) {
          appLogger.warn({ component: 'Baileys', jid, err: err.message }, 'getChatById failed');
          // Return a minimal chat object
          return new BaileysChat(this, jid, { subject: jid });
        }
      }
      return new BaileysChat(this, jid, meta);
    }

    // Individual chat
    return new BaileysChat(this, jid, { name: chatId.split('@')[0] });
  }

  /**
   * Get a contact by ID.
   */
  async getContactById(contactId) {
    return this._getContact(contactId);
  }

  _getContact(jid) {
    const wwebJid = toWWebJid(jid);
    const cached = this._contactCache.get(wwebJid);
    if (cached) return cached;

    // Return a minimal contact
    const number = wwebJid.replace('@c.us', '').replace('@s.whatsapp.net', '');
    return {
      pushname: number,
      number,
      name: null,
      id: { _serialized: wwebJid, user: number },
    };
  }

  /**
   * Check if a phone number is registered on WhatsApp.
   * Compatible with whatsapp-web.js client.getNumberId().
   */
  async getNumberId(jid) {
    try {
      const baileysJid = toBaileysJid(jid);
      const [result] = await this._sock.onWhatsApp(baileysJid);
      if (result && result.exists) {
        const wwebJid = toWWebJid(result.jid);
        return {
          _serialized: wwebJid,
          user: result.jid.split('@')[0],
          server: 'c.us',
        };
      }
      return null;
    } catch (err) {
      appLogger.warn({ component: 'Baileys', err: err.message }, 'getNumberId failed');
      return null;
    }
  }

  /**
   * Mark chat as seen. Compatible with whatsapp-web.js client.sendSeen().
   */
  async sendSeen(chatId) {
    try {
      const jid = toBaileysJid(chatId);
      await this._sock.readMessages([{ remoteJid: jid, id: undefined }]);
    } catch (_) {}
  }

  /**
   * Send a reaction. Compatible with whatsapp-web.js client.sendReaction().
   */
  async sendReaction(messageId, reaction) {
    // Parse the serialized message ID back into a key
    // Format: true/false_jid_id_participant
    const parts = messageId.split('_');
    const fromMe = parts[0] === 'true';
    const remoteJid = toBaileysJid(parts[1]);
    const id = parts[2];

    await this._sock.sendMessage(remoteJid, {
      react: {
        text: reaction,
        key: { fromMe, remoteJid, id },
      },
    });
  }

  /**
   * Destroy the client connection.
   */
  async destroy() {
    if (this._sock) {
      this._sock.end();
      this._sock = null;
    }
    this._ready = false;
  }

  /**
   * Check if client is ready.
   */
  get isReady() {
    return this._ready;
  }

  /**
   * Access Baileys signalRepository (for LID↔PN mapping).
   * Returns null if socket not initialized.
   */
  get signalRepository() {
    return this._sock ? this._sock.signalRepository : null;
  }

  /**
   * Resolve a LID-form JID (<n>@lid) to a phone-number JID (<phone>@s.whatsapp.net).
   *
   * H5: Baileys hands out LID participants in privacy-mode groups. Those strings
   * never match phone-based identity lookups (FAMILY_PHONES, the myJid quoted-reply
   * check ISSUE-023 depended on). We resolve once via the signal repository and
   * cache the mapping in the `lid_map` table so it survives restarts. Resolution
   * failures are logged loudly rather than silently passing the raw LID downstream.
   *
   * @param {string} lidJid — a JID; non-LID input is returned unchanged.
   * @returns {Promise<string|null>} the resolved phone JID, or null if unresolved.
   */
  async _resolveLidToPhone(lidJid) {
    if (!lidJid) return null;
    const lid = normalizeJid(lidJid);
    if (!lid.endsWith('@lid')) return lid; // already a phone/other JID

    // 1) Cache (survives restarts).
    try {
      const { getLidMapping } = require('./db');
      const cached = getLidMapping(lid);
      if (cached) return cached;
    } catch (_) { /* DB not initialized (e.g. a unit test) — fall through */ }

    // 2) Live resolution via the signal repository's LID mapping store.
    const repo = this.signalRepository;
    if (!repo || !repo.lidMapping || typeof repo.lidMapping.getPNForLID !== 'function') {
      appLogger.warn({ component: 'Baileys', lid },
        'LID resolution unavailable (no signalRepository) — passing raw LID downstream');
      return null;
    }
    try {
      const pnRaw = await repo.lidMapping.getPNForLID(lid);
      if (!pnRaw) {
        appLogger.warn({ component: 'Baileys', lid },
          'LID → phone resolution returned nothing — identity comparison will fail');
        return null;
      }
      const pn = normalizeJid(pnRaw);
      try { require('./db').saveLidMapping(lid, pn); } catch (_) {}
      return pn;
    } catch (err) {
      appLogger.error({ component: 'Baileys', lid, err: err.message },
        'LID → phone resolution threw — passing raw LID downstream');
      return null;
    }
  }

  /**
   * Get connection state. Compatible with whatsapp-web.js client.getState().
   * Checks actual socket state, not just the _ready flag.
   */
  async getState() {
    if (this._sock && this._sock.ws && this._sock.ws.readyState === 1) return 'CONNECTED';
    if (this._ready) return 'CONNECTED';
    return 'DISCONNECTED';
  }
}

module.exports = {
  BaileysClient,
  BaileysMessage,
  BaileysChat,
  toBaileysJid,
  toWWebJid,
  normalizeJid,
  stanzaIdOf,
};
