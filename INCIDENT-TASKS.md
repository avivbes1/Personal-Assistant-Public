# Incident Remediation Tasks (2026-07-20)

Approved by Aviv. Implement all items below. Use best judgment on implementation details.

---

## TASK 0.2 — Health server starts at module load, NOT inside ready handler

**File:** `src/voice-server.js`

Move the HTTP server startup so it binds to port 3001 immediately when the module is first required — before WhatsApp even connects. The health endpoint should report `whatsapp_connected: false` / `status: "initializing"` until the client is ready, and report actual state once connected.

Changes needed:
- `startVoiceServer(client, getHealthState)` is currently called inside `client.on('ready', ...)` in whatsapp.js
- Refactor so the HTTP server starts on `require('./voice-server')` (module load)
- Export a `setClient(client, getHealthState)` function that whatsapp.js calls from the ready handler to wire in the actual client
- The health endpoint must work (return JSON, report initializing state) even before `setClient` is called
- Add an `init_errors` array to the health response — whatsapp.js should push errors into it via an exported `addInitError(err)` function
- Keep all existing endpoints (`/health`, `/health/pipeline`, `/config/propose`, `/send-message`, `/voice`) working

**File:** `src/whatsapp.js`
- Remove `startVoiceServer(client, getHealthState)` from inside `client.on('ready', ...)`
- Instead, call `require('./voice-server')` near the top of the file (module load) so the server starts immediately
- In the ready handler, call `setClient(client, getHealthState)` (the new exported function)
- Wrap `client.initialize()` call with `.catch(err => { addInitError(err); console.error('[WhatsApp] initialize failed:', err.message); })`
- The try-catch around `resolveMasterGroup()` is already there — keep it, also call `addInitError(err)` in the catch

---

## TASK 0.3 — Fix claimReminder atomicity

**Problem:** `claimReminder(id)` atomically marks `sent=1` in the DB BEFORE the actual WhatsApp send happens. If the send fails, the reminder is permanently lost.

**File:** `src/db.js`
- Rename `claimReminder(id)` to something like `reserveReminder(id)` — same atomic CAS logic (`UPDATE SET sent=1 WHERE id=? AND sent=0`, return `changes > 0`)
- Add a new function `releaseReminder(id)` — resets `sent=0` for a given id (used if send fails)
- Add a new function `confirmReminderSent(id)` — sets a new `confirmed_at` timestamp column (for audit)
- Add `confirmed_at INTEGER` column to the reminders table if it doesn't exist (use `ALTER TABLE IF NOT EXISTS` pattern via `try/catch`)

**File:** `src/scheduler.js`
In `fireReminder(reminder)`:
- Replace the current pattern (claim → send → done) with: claim → try send → if send fails → release claim → rethrow
- Specifically:
  ```
  if (!reserveReminder(reminder.id)) return; // already claimed
  try {
    await sendToMasterGroup(msg);
    confirmReminderSent(reminder.id);
  } catch (err) {
    releaseReminder(reminder.id);  // allow retry on next poll
    throw err;
  }
  ```

---

## TASK 1.1 — Provider abstraction: Gemini fallback for LLM calls

The bot makes direct HTTPS calls to Anthropic API in `src/noticeDelivery.js` (the `summarizeCluster()` function). When Anthropic credits run out, this fails silently.

**File:** `src/llm.js` (NEW FILE)

Create a provider-abstracted LLM client:
```javascript
// src/llm.js
// Thin LLM wrapper with Gemini fallback when Anthropic fails.
// Used by noticeDelivery.js and any other bot code needing LLM.

const https = require('https');

const ANTHROPIC_MODEL = 'claude-haiku-4-5';
const GEMINI_MODEL = 'gemini-2.5-flash';

async function callLLM(prompt, { maxTokens = 300, timeout = 12000 } = {}) {
  // Try Anthropic first
  try {
    return await callAnthropic(prompt, { maxTokens, timeout });
  } catch (err) {
    console.warn('[LLM] Anthropic failed, trying Gemini fallback:', err.message);
    return await callGemini(prompt, { maxTokens, timeout });
  }
}

async function callAnthropic(prompt, { maxTokens, timeout }) {
  // Move the existing HTTPS call from noticeDelivery.js summarizeCluster() here
  // Respect the existing timeout pattern (req.setTimeout + req.destroy)
}

async function callGemini(prompt, { maxTokens, timeout }) {
  // Call Gemini API: POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=GEMINI_API_KEY
  // Use process.env.GEMINI_API_KEY
  // Map the response to a plain string (same return type as callAnthropic)
}

module.exports = { callLLM };
```

**File:** `src/noticeDelivery.js`
- Replace the inline `summarizeCluster()` HTTPS call to Anthropic with `const { callLLM } = require('./llm'); return callLLM(prompt);`
- Keep the timeout behavior

---

## TASK 1.2 — Anthropic credit watchdog flag

**File:** `src/llm.js` (in the same file as 1.1)

When `callAnthropic()` fails with a credit-related error (response body contains "credit balance" or "insufficient_funds" or status 402/529), write `/tmp/anthropic-credit-alert.json`:
```json
{ "ts": <timestamp>, "message": "Anthropic credits exhausted", "error": "<err.message>" }
```

The heartbeat (Lipa) already checks `/tmp/bot-stuck-alert.json`. Add `/tmp/anthropic-credit-alert.json` to the same check routine (the heartbeat reads the file and DMs Aviv).

---

## TASK 2.1 — Docker containerization

Create a `Dockerfile` and `docker-compose.yml` for besinsky-bot that:
- Uses a base image that has Chromium pre-installed WITHOUT snap (`node:22-slim` + `apt-get install -y chromium`)
- Sets `CHROMIUM_PATH=/usr/bin/chromium` in the Docker env
- Mounts `./data` and `./whatsapp-session` as volumes (persistent data)
- Mounts `.env` as a volume or env_file
- Exposes port 3001
- Has a healthcheck: `curl -f http://localhost:3001/health`
- Uses `--no-sandbox` and other Puppeteer headless flags appropriate for Docker

Note: The Dockerfile should work on arm64 (the server is AWS ARM). Verify the base image supports arm64.

Also create a `docker-compose.yml` with:
- Service: `besinsky-bot`
- Restart policy: `unless-stopped`
- Health check matching the Dockerfile healthcheck
- Volume mounts for data persistence
- The `.env` file as env_file

**DO NOT** migrate to Docker yet — just create the files. Leave a `## HOW TO MIGRATE` section at the top of `docker-compose.yml` with the pm2 → docker migration steps.

---

## NOTES

- Run `node -e "require('./src/db'); require('./src/scheduler')"` from the bot dir after changes to verify no syntax errors
- Do not restart pm2 — Lipa will handle that after reviewing diffs
- Write a brief summary of what you changed to `/home/ubuntu/besinsky-bot/INCIDENT-CHANGES.md`
