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
| `src/llm/router.js` | Claude Code routing gate — ad-hoc tasks routed to CC first, falls back to direct API |
| `src/llm/classifier.js` | Tiered task classification (research / code / deep) with per-tier timeouts |
| `src/llm/circuit-breaker.js` | Failure isolation — opens after 3 consecutive CC failures, auto-resets after 5 min |

---

## Prerequisites

- **Node.js 18+**
- **A dedicated phone number** linked to WhatsApp — not your personal number. The bot owns this number as a linked device.
- **Anthropic API key** — [console.anthropic.com](https://console.anthropic.com)
- **Google Cloud project** with Calendar API + Gmail API + Drive API enabled and an OAuth 2.0 Desktop credential
- **Linux VPS** — 1 vCPU / 1–2 GB RAM is sufficient (tested on AWS t4g.small/medium)
- **Chromium** — whatsapp-web.js requires a Chromium installation (see below)
- **gog CLI** (optional) — for Gmail/Drive access: [gogcli.sh](https://gogcli.sh). Linux arm64 binary available at [github.com/openclaw/gogcli/releases](https://github.com/openclaw/gogcli/releases)

---

## Setup

### 1. System dependencies (headless VPS)

whatsapp-web.js runs a headless Chromium browser. On a fresh Ubuntu/Debian server:

```bash
sudo apt update && sudo apt install -y \
  chromium-browser \
  libgbm1 libxshmfence1 libnss3 libatk-bridge2.0-0 \
  libdrm2 libxkbcommon0 libxdamage1
```

Then set `CHROMIUM_PATH=/usr/bin/chromium-browser` in your `.env`.

### 2. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/Personal-Assistant-Public.git familybot
cd familybot
npm install

# Create required runtime directories
mkdir -p logs data backups whatsapp-session config
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env with your values
```

### 4. Configure groups

```bash
cp config/groups.example.json config/groups.json
# Edit config/groups.json — set "master" to your coordination group name
# and list the group names you want the bot to monitor under "monitored"
```

### 5. Configure family members (optional but recommended)

```bash
cp config/family-seed.example.json config/family-seed.json
# Edit config/family-seed.json — add family member names, roles, and calendar IDs
# This seeds the family_members table so the bot can resolve names in messages
```

### 6. Google Calendar OAuth

You need a Google Cloud OAuth 2.0 **Desktop app** credential:

1. Go to [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials
2. Create **OAuth 2.0 Client ID** → Desktop app → Download as `credentials.json` → place in project root (gitignored)
3. Enable the **Google Calendar API** for your project
4. Set the OAuth consent screen to **Production** (not Testing) — avoids 7-day token expiry
5. Generate tokens (run once per parent):

```bash
# Parent 1
node -e "
const {google} = require('googleapis');
const creds = require('./credentials.json').installed;
const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, creds.redirect_uris[0]);
console.log(oauth2.generateAuthUrl({access_type:'offline', scope:['https://www.googleapis.com/auth/calendar']}));
"
# Open the URL, authorize, then exchange the code:
node -e "
const {google} = require('googleapis');
const fs = require('fs');
const creds = require('./credentials.json').installed;
const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, creds.redirect_uris[0]);
oauth2.getToken('PASTE_CODE_HERE').then(({tokens}) => {
  fs.writeFileSync('./token-aviv.json', JSON.stringify(tokens));
  console.log('Token saved to token-aviv.json');
});
"
# Repeat for parent 2, saving to token-liat.json
```

Token paths are set via `AVIV_TOKEN_PATH` and `LIAT_TOKEN_PATH` in `.env`.

### 7. Find your WhatsApp group JIDs

After the bot connects once (step 8), list groups to find JIDs:

```bash
node -e "
const {Client, LocalAuth} = require('whatsapp-web.js');
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
  puppeteer: { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser', args: ['--no-sandbox'] }
});
client.on('ready', async () => {
  const chats = await client.getChats();
  chats.filter(c => c.isGroup).forEach(c => console.log(c.id._serialized, '\t', c.name));
  process.exit(0);
});
client.initialize();
" 2>/dev/null
```

Set `MASTER_GROUP_JID` in `.env` and group names in `config/groups.json`.

### 8. First run — WhatsApp QR scan

```bash
node src/index.js
```

A QR code appears in the terminal. Scan with WhatsApp on the bot's phone:
**WhatsApp → Settings → Linked Devices → Link a Device**

Once "Client ready" appears, the session is saved in `whatsapp-session/` (gitignored). You won't need to scan again unless explicitly logged out.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Anthropic API key |
| `AVIV_PHONE` | ✅ | E.164 phone of parent 1 |
| `LIAT_PHONE` | ✅ | E.164 phone of parent 2 |
| `PARENT1_NAME` | ✅ | Display name for parent 1 |
| `PARENT2_NAME` | ✅ | Display name for parent 2 |
| `MASTER_GROUP_NAME` | ✅ | Exact name of master coordination group |
| `MASTER_GROUP_JID` | ✅ | WhatsApp JID of master group (`xxx@g.us`) |
| `AVIV_CALENDAR_ID` | ✅ | Google Calendar ID for parent 1 |
| `LIAT_CALENDAR_ID` | ✅ | Google Calendar ID for parent 2 |
| `LIAT_WORK_CALENDAR_ID` | — | Work calendar for parent 2 (optional) |
| `GOOGLE_CREDENTIALS_PATH` | ✅ | Path to `credentials.json` |
| `AVIV_TOKEN_PATH` | ✅ | Path to OAuth token for parent 1 |
| `LIAT_TOKEN_PATH` | ✅ | Path to OAuth token for parent 2 |
| `TIMEZONE` | ✅ | IANA timezone (e.g. `Asia/Jerusalem`) |
| `CHROMIUM_PATH` | ✅ | Path to Chromium binary |
| `TOKEN_LIMIT_DAILY` | — | Daily LLM token budget (default: unlimited) |
| `S3_BACKUP_BUCKET` | — | S3 bucket for DB backups (optional) |
| `BOT_NAME` | — | Bot display name (default: `FamilyBot`) |
| `CC_ENABLED` | — | Set `true` to activate Claude Code routing gate (default: `false`) |
| `CC_LOG_ONLY` | — | Set `true` to classify + log without routing to CC (dark launch mode) |
| `CLAUDE_BIN` | — | Path to `claude` CLI binary (default: `/usr/bin/claude`) |
| `CLAUDE_CODE_CWD` | — | Working directory for Claude Code tasks (default: `/home/ubuntu`) |
| `GOG_KEYRING_PASSWORD` | — | Keyring password for gog CLI (required if using Gmail/Drive) |

---

## Running in Production

### With PM2 (recommended)

```bash
npm install -g pm2
pm2 start src/index.js --name familybot
pm2 save
pm2 startup   # installs as system service, follow the printed command
```

```bash
pm2 logs familybot --lines 50    # recent logs
pm2 restart familybot            # restart
pm2 status                       # process health
```

### System cron jobs (add via `crontab -e`)

```cron
# Notice triage — delivers group notices to master group every 15 minutes
*/15 * * * * cd /path/to/familybot && TRIAGE_SHADOW=false node src/triage-engine.js >> logs/triage.log 2>&1

# SQLite backup — daily at 3 AM UTC, 7-day local retention
0 3 * * * /path/to/familybot/scripts/backup-sqlite.sh >> /path/to/familybot/backups/backup.log 2>&1
```

---

## Data & Security

### What stays on your server (never in the repo)

| File/Dir | Contents |
|---|---|
| `.env` | All secrets and personal config |
| `credentials.json` | Google OAuth client secret |
| `token-aviv.json`, `token-liat.json` | Google OAuth tokens |
| `config/groups.json` | Group JIDs and descriptions |
| `config/family-seed.json` | Family member names/phones |
| `whatsapp-session/` | WhatsApp auth state |
| `data/*.db` | All messages, notices, events |
| `backups/` | SQLite backups |
| `logs/` | Runtime logs |

**The `.gitignore` enforces all of the above.** Run `node scripts/detect-pii.js src/` before any commit to catch personal data in source files.

### WhatsApp session security

`whatsapp-session/` contains your WhatsApp linked-device credentials. Treat it like a private key — back it up, never commit it, restrict server access.

### Google tokens

`token-*.json` files contain OAuth refresh tokens. If exposed, revoke immediately at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

### Database privacy

SQLite stores all monitored group messages. Back up with `scripts/backup-sqlite.sh`. Enable `S3_BACKUP_BUCKET` in `.env` for cloud backups (requires IAM `s3:PutObject` on the bucket).

---

## Tests

```bash
npm test                  # run all regression tests (no API calls)
node tests/run-all.js     # same, verbose output
```

Tests use a mock LLM provider and run safely in CI. Model-validation tests skip automatically in CI (require live API keys). To add a regression test for a new fix:

```bash
# Create tests/regression/YYYY-MM-DD-description.js
# Export: module.exports = { async run() { return { pass: bool, message: string }; } }
```

---

## Architecture Principles

See [PRINCIPLES.md](./PRINCIPLES.md) for design rules derived from production incidents. Read before making architectural changes.

---

## Contributing / Adapting

The main things to change for your own family:

1. `config/family-seed.json` — family member names, roles, calendar IDs
2. `config/groups.json` — which WhatsApp groups to monitor
3. `.env` — calendar IDs, phones, API keys, timezone
4. `prompts/` — the Hebrew prompt templates (most family-specific content lives here)

The codebase has Hebrew in several places — prompts, templates, and some log messages are tightly coupled to an Israeli family context and will need localisation for other languages.

---

## License

ISC
