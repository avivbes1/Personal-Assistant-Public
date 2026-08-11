# Baileys Migration Plan

**Created:** 2026-08-11
**Status:** Planning
**Goal:** Replace whatsapp-web.js (Puppeteer-based) with @whiskeysockets/baileys (WebSocket protocol-based) to eliminate `_serialized`/minification breakage class entirely.

---

## Health Baseline (Pre-Migration — 2026-08-11)

### Bot Status
- Process: pm2 `besinsky-bot`, Node.js v22.22.2
- WhatsApp connected: ✅
- Ready failure count: 0

### Data Integrity
- Groups: 17 total (14 monitored)
- Total notices: 688
- Pending notices: 2
- Messages stored: 3,307
- Pending group questions: 3 in DB

### Feature Inventory (must all work post-migration)

| Feature | Current Implementation | Test Method |
|---|---|---|
| **Receive group messages** | `client.on('message_create')` | Send message in monitored group → appears in DB |
| **Send to master group** | `client.sendMessage(masterGroupId, text)` | VoiceServer `/send-message` → message appears in WhatsApp |
| **Send to DM** | `client.sendMessage(phone@c.us, text)` | Cron reminder fires → Aviv gets DM |
| **Message ID tracking** | `sentMsg.id._serialized` | Send message → msgId returned and non-null |
| **Quoted message reply** | `msg.getQuotedMessage()` | Reply to bot's message → bot detects quoted context |
| **Group join detection** | `client.on('group_join')` | Add bot to new group → question appears in master group |
| **Get chat list** | `client.getChats()` | Startup → all 17 groups listed |
| **Get chat by ID** | `client.getChatById(jid)` | Query specific group → returns chat object |
| **Send with @mentions** | `client.sendMessage(jid, text, {mentions})` | Morning digest sends @mention → renders in WhatsApp |
| **Read chat history** | `chat.fetchMessages({limit})` | `/chat-history` endpoint → returns messages |
| **Image messages** | `msg.downloadMedia()` for OCR | Image in monitored group → OCR extracts text |
| **Voice messages** | TTS via edge-tts → send as PTT | VoiceServer `/voice` endpoint → voice note sent |
| **Auth persistence** | `LocalAuth` (Puppeteer profile) | Restart bot → no QR scan needed |
| **Health endpoint** | Custom `/health` on port 3001 | `curl localhost:3001/health` → connected: true |
| **DM history** | `dm-history.jsonl` + chat.fetchMessages | `/chat-history` → returns recent messages |

### Cron Jobs (must continue working)
- Notice delivery immediate (every 5min) — Haiku
- Notice delivery batch (4x/day) — Haiku  
- Morning digest (7am Israel) — Kimi K2.6
- 17 event reminder jobs — various schedules
- Bot health watchdog (every 10min) — Gemini Flash

### External Integrations
- OpenClaw VoiceServer (port 3001) — HTTP API for sending messages
- OpenClaw WhatsApp plugin — receives/sends via the bot's WhatsApp connection
- Google Calendar API — token-aviv.json, token-liat.json
- Babysitter booking service (port 3002)

---

## Migration Strategy

### Approach: Parallel Run
1. Install Baileys alongside whatsapp-web.js
2. Build `BaileysClient` adapter with same interface as current `client`
3. Run both in parallel temporarily (read from both, write via Baileys)
4. Once Baileys is stable for 24h, remove whatsapp-web.js
5. **QR re-scan required** — Baileys uses different auth format

### Key Architectural Differences

| Aspect | whatsapp-web.js | Baileys |
|---|---|---|
| Protocol | Puppeteer → WhatsApp Web page | Direct WebSocket to WhatsApp servers |
| Auth | Browser profile (LocalAuth) | Multi-file auth state |
| Message IDs | `msg.id._serialized` (fragile) | `msg.key.id` (stable) |
| Group events | `group_join`, `group_update` events | `groups.upsert`, `groups.update` |
| Send message | `client.sendMessage(jid, text)` | `sock.sendMessage(jid, {text})` |
| Media | `msg.downloadMedia()` → base64 | `downloadMediaMessage(msg)` → Buffer |
| Mentions | `{mentions: [jid]}` option | `{mentions: [jid]}` in message content |
| Chat history | `chat.fetchMessages({limit})` | Store-based or `sock.chatModify()` |

### Files That Need Changes

| File | Changes Required |
|---|---|
| `src/whatsapp.js` | Replace Client init, event handlers, sendMessage, getChats |
| `src/voice-server.js` | Update sendMessage call, health state |
| `src/agent.js` | No changes (doesn't touch WhatsApp directly) |
| `src/health.js` | Update health state checks |
| `src/scheduler.js` | Update sendMessage calls |
| `src/delivery/guardedSend.js` | Update sendMessage calls |
| `ecosystem.config.js` | No changes |

### Migration Checklist

- [ ] Install @whiskeysockets/baileys
- [ ] Create `src/baileys-client.js` — adapter wrapping Baileys with same interface
- [ ] Implement auth state management (useMultiFileAuthState)
- [ ] Implement message sending (text, media, voice, mentions)
- [ ] Implement message receiving (all types)
- [ ] Implement group event handlers (join, leave, update)
- [ ] Implement chat list / chat by ID
- [ ] Implement message history fetching
- [ ] Implement media download
- [ ] Update VoiceServer to use new client
- [ ] Update health endpoint
- [ ] QR scan for Baileys auth
- [ ] Parallel run: verify all 17 groups receive messages
- [ ] Parallel run: verify send to master group works
- [ ] Parallel run: verify DM sending works
- [ ] Parallel run: verify message IDs are tracked
- [ ] Parallel run: verify quoted reply detection works
- [ ] Remove whatsapp-web.js dependency
- [ ] Clean up old auth files
- [ ] Run full test suite (14/14 passing)
- [ ] Monitor for 24h post-migration

### Health Checks Post-Migration

```bash
# 1. All groups visible
curl -sf localhost:3001/health | jq '.whatsapp_connected'
# Expected: true

# 2. Messages flowing
cd /home/ubuntu/besinsky-bot && node -e "
const {initDB,getDB}=require('./src/db');initDB();
const recent=getDB().prepare('SELECT COUNT(*) as c FROM messages WHERE timestamp > ?').get(Date.now()-3600000);
console.log('Messages in last hour:', recent.c);
"

# 3. Notices being created
cd /home/ubuntu/besinsky-bot && node -e "
const {initDB,getDB}=require('./src/db');initDB();
const recent=getDB().prepare('SELECT COUNT(*) as c FROM notices WHERE created_at > ?').get(Date.now()-3600000);
console.log('Notices in last hour:', recent.c);
"

# 4. Message IDs present
# Send test message, verify msgId is non-null
curl -sf -X POST localhost:3001/send-message -H 'Content-Type: application/json' \
  -d '{"to":"120363426770765539@g.us","text":"health check"}' | jq '.msgId'

# 5. No error spikes
pm2 logs besinsky-bot --lines 50 --nostream 2>/dev/null | grep -c "error\|Error"
```

### Rollback Plan
If Baileys migration fails:
1. Stop bot: `pm2 stop besinsky-bot`
2. Revert to whatsapp-web.js branch: `git checkout pre-baileys`
3. Restart: `pm2 start besinsky-bot`
4. QR re-scan for whatsapp-web.js auth (may be needed)
5. Verify health baseline matches pre-migration numbers

---

## Timeline

| Day | Task |
|---|---|
| Day 1 | Install Baileys, build adapter, implement core messaging |
| Day 2 | Group events, media, voice, mentions |
| Day 3 | Chat history, health checks, VoiceServer updates |
| Day 4 | QR scan, parallel run, testing all features |
| Day 5 | Remove whatsapp-web.js, cleanup, 24h monitoring |

---

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| QR scan needed during switchover | 5min downtime | Schedule during low-activity hours |
| Baileys WebSocket protocol changes | Bot goes down | Pin known-good version, monitor GitHub |
| WhatsApp account ban risk | Total loss | Same risk as whatsapp-web.js; Cloud API is only TOS-compliant option |
| Feature parity gaps in Baileys | Missing functionality | Test each feature against checklist before cutover |
| Auth state corruption | Repeated QR scans | Backup auth state files regularly |
