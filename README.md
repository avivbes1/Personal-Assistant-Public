# FamilyBot — Personal AI Assistant

A WhatsApp-native family assistant that monitors group chats, extracts events and tasks, syncs to Google Calendar, and posts digests to a master coordination group.

Built with Node.js + whatsapp-web.js + Claude (Anthropic). Runs as a single process on a small VPS.

---

## Architecture

```
WhatsApp Groups (school, activities, community)
        │
        │ messages
        ▼
  whatsapp.js  ─── client.on('message') ───►  agent.js
  (WA client)                                  (Haiku LLM)
        │                                           │
        │                                    action blocks
        │                                    (add_event, add_notice, ...)
        ▼                                           │
   voice-server.js                                  ▼
   (HTTP :3001)   ◄──── outbound sends ────  calendar.js / db.js
        │
        │ send to WA
        ▼
  Master Group ◄──── triage-engine.js ────  notices table
  (family hub)       (*/15 system cron)      (SQLite)
        │
        ▼
  Morning Digest (7:00 AM, daily cron)
```

**Key modules:**

| Module | Role |
|---|---|
| `src/whatsapp.js` | WhatsApp client, message routing |
| `src/agent.js` | LLM action extractor (Claude Haiku) |
| `src/calendar.js` | Google Calendar read/write |
| `src/calendarGate.js` | 4-stage dedup gate for calendar writes |
| `src/triage-engine.js` | Batches and delivers notices to master group |
| `src/scheduler.js` | Poll-based reminders (no setTimeout) |
| `src/db.js` | SQLite schema + helpers |
| `src/dismissal.js` | "Stop sending about X" handler |
| `src/voice-server.js` | Internal HTTP server (:3001) for outbound sends |

---

## Prerequisites

- Node.js 18+
- A dedicated phone number linked to WhatsApp (not your personal number — the bot owns this number)
- An Anthropic API key ([console.anthropic.com](https://console.anthropic.com))
- A Google Cloud project with Calendar API enabled
- A Linux VPS (1 vCPU / 1–2 GB RAM is sufficient — tested on AWS t4g.small/medium)

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/Personal-Assistant-Public.git familybot
cd familybot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values. See [Environment Variables](#environment-variables) below.

### 3. Google Calendar OAuth

You need a Google Cloud OAuth 2.0 **Desktop app** credential.

1. Go to [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials
2. Create OAuth 2.0 Client ID → Desktop app
3. Download as `credentials.json` and place it in the project root (gitignored)
4. Enable the Google Calendar API for your project
5. Run the auth flow once to generate tokens:

```bash
node -e "require('./src/calendar').getAuthUrl().then(url => console.log('Open this URL:', url))"
# Open the URL, authorize, paste the code back:
node -e "require('./src/calendar').exchangeCode('PASTE_CODE_HERE')"
# This writes token-parent1.json and token-parent2.json (gitignored)
```

> **Note:** Use Google OAuth in "production" mode (not "testing") to avoid 7-day token expiry.

### 4. Find your WhatsApp group JIDs

JIDs look like `120363426994367917@g.us`. After the bot connects once, list groups:

```bash
node -e "
const {Client, LocalAuth} = require('whatsapp-web.js');
const client = new Client({ authStrategy: new LocalAuth() });
client.on('ready', async () => {
  const chats = await client.getChats();
  chats.filter(c => c.isGroup).forEach(c => console.log(c.id._serialized, c.name));
  process.exit(0);
});
client.initialize();
"
```

Set `MASTER_GROUP_JID` and monitored group JIDs in `config/groups.json` (gitignored, see `config/groups.example.json`).

### 5. First run — WhatsApp QR scan

```bash
node src/index.js
```

A QR code will appear in the terminal. Scan it with WhatsApp on the bot's phone:
- WhatsApp → Settings → Linked Devices → Link a Device

Once "Client ready" appears, the session is saved in `whatsapp-session/` (gitignored). You won't need to scan again unless you log out.

---

## Environment Variables

| Variable | Description | Example |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key | `sk-ant-...` |
| `MASTER_GROUP_NAME` | Display name of your coordination group | `Family Tasks` |
| `MASTER_GROUP_JID` | WhatsApp JID of the master group | `120363...@g.us` |
| `AVIV_CALENDAR_ID` | Google Calendar ID for parent 1 | `parent1@gmail.com` |
| `LIAT_CALENDAR_ID` | Google Calendar ID for parent 2 | `parent2@gmail.com` |
| `AVIV_PHONE` | E.164 phone of parent 1 | `+972501234567` |
| `LIAT_PHONE` | E.164 phone of parent 2 | `+972509876543` |
| `TIMEZONE` | IANA timezone | `Asia/Jerusalem` |
| `PARENT1_NAME` | Display name for parent 1 calendar | `Parent 1` |
| `PARENT2_NAME` | Display name for parent 2 calendar | `Parent 2` |
| `TOKEN_LIMIT_DAILY` | Daily LLM token budget (optional) | `200000` |

---

## Running in Production

### With PM2 (recommended)

```bash
npm install -g pm2
pm2 start src/index.js --name familybot
pm2 save
pm2 startup   # install as system service
```

Useful commands:
```bash
pm2 logs familybot          # live logs
pm2 logs familybot --lines 100 --nostream   # last 100 lines
pm2 restart familybot       # restart
pm2 status                  # process status
```

### System cron jobs

Two cron jobs run outside PM2 (add via `crontab -e`):

```cron
# Notice triage — runs every 15 minutes
*/15 * * * * cd /path/to/familybot && TRIAGE_SHADOW=false node src/triage-engine.js >> logs/triage.log 2>&1

# SQLite backup — daily at 3 AM UTC
0 3 * * * /path/to/familybot/scripts/backup-sqlite.sh >> /path/to/familybot/backups/backup.log 2>&1
```

### Logs

```bash
tail -f logs/triage.log          # triage delivery log
pm2 logs familybot --lines 50    # main process log
```

---

## Data & Security

### What stays on your server (never in the repo)

| File/Dir | Contents |
|---|---|
| `.env` | All secrets and personal config |
| `credentials.json` | Google OAuth client secret |
| `token-*.json` | Google OAuth tokens |
| `config/groups.json` | Group JIDs and descriptions |
| `config/family-seed.json` | Family member names/phones |
| `whatsapp-session/` | WhatsApp auth state |
| `data/*.sqlite` | All messages, notices, events |
| `backups/` | SQLite backups |

**The `.gitignore` enforces all of the above.** Run `node scripts/detect-pii.js src/` before any commit to verify no personal data crept into source files.

### WhatsApp session security

The `whatsapp-session/` directory contains your WhatsApp linked-device credentials. If this is compromised, someone can impersonate the bot number. Keep it on a server you control, backed up, not version-controlled.

### Google tokens

`token-*.json` files contain OAuth refresh tokens. If exposed, revoke them immediately at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

### SQLite privacy

The database stores all monitored group messages. It is **not** backed up to any cloud by default. Configure `S3_BACKUP_BUCKET` in `.env` to enable encrypted S3 backups.

---

## Tests

```bash
npm test                  # run all regression tests
node tests/run-all.js     # same, with more output
```

Tests use a mock LLM provider (no API calls) and are safe to run in CI. The model validation test (`2026-05-26-model-validation.js`) requires live API keys and skips automatically in CI.

To add a test for a new bug fix, create `tests/regression/YYYY-MM-DD-description.js` and export a `run()` function returning `{ pass: bool, message: string }`.

---

## Architecture Principles

See [PRINCIPLES.md](./PRINCIPLES.md) for concluded, non-negotiable design rules derived from production incidents. Read it before making architectural changes.

---

## Contributing

This is a personal project shared for reference. If you adapt it for your own family, the main things to configure are:

1. Family member names/phones in `config/family-seed.json`
2. Monitored group JIDs in `config/groups.json`
3. Calendar IDs in `.env`
4. The master group name/JID in `.env`

The codebase is in Hebrew in several places (prompts, templates) — those are the parts most tightly coupled to the Israeli family context.
