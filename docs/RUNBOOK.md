# FamilyBot — Operational Runbook

> On-call playbook for the WhatsApp family assistant ("besinsky-bot" / Lipa).
> Written after the 2026-09-09 outage (see `WORKPLAN-PHASE-I.md`). Everything
> below is grounded in the live host, not aspirational.

The bot is a **single Node.js process** (`src/index.js`) that talks to WhatsApp
over Baileys, extracts events/notices with Claude, writes to Google Calendar +
SQLite, and posts to the family "master group". If it goes down, the family
stops getting reminders and calendar entries silently — there is no user-facing
error, so **detection is the whole game**.

---

## 1. System map — what runs where

| Component | How it runs | Purpose |
|---|---|---|
| `besinsky-bot` | **PM2** (`pm2 status`) | The main bot process (`src/index.js`) |
| `voice-server.js` | in-process, HTTP `:3001` | Health endpoints + outbound send API |
| `openclaw-gateway` | `systemctl --user` | Separate WhatsApp channel gateway |
| `besinsky-watchdog` | **systemd timer**, every 5 min → `infra/watchdog.sh` | Out-of-band health probe + alerts |
| `bot-watchdog` | **cron** `/etc/cron.d/bot-watchdog`, every 5 min → `/home/ubuntu/watchdog.sh` | Second (legacy) watchdog copy |
| triage | crontab, `*/15` → `src/triage-engine.js` | Delivers group notices to master group |
| reminders | crontab, `*/30` → `scripts/run-reminder-job.js` | Fires due reminders |
| pipeline-monitor | crontab, `*/5` → `src/pipeline-monitor.js` | Pipeline health |
| consolidate / dead-letter | crontab, hourly | Notice cleanup + retry |
| backups | crontab, `0 3 * * *` → `backup-auth-session.sh`, `backup-sqlite.sh` | Daily session + DB backup |

> ⚠️ **Two watchdogs run.** The systemd timer executes the **repo** copy
> (`/home/ubuntu/besinsky-bot/infra/watchdog.sh`) and has the I3/I5 checks.
> The cron entry executes a **separate file** (`/home/ubuntu/watchdog.sh`) that
> can drift from the repo. When you change watchdog logic, edit
> `infra/watchdog.sh` and, if the cron copy is still active, sync it too:
> `cp infra/watchdog.sh /home/ubuntu/watchdog.sh`. Confirm which is authoritative
> before assuming an alert came from your latest code.

**Key paths**

- Repo / working dir: `/home/ubuntu/besinsky-bot`
- SQLite DB: `data/family.db` (override with `FAMILYBOT_DB_PATH` — see below)
- WhatsApp session: `whatsapp-session/`
- Google OAuth tokens: `token-aviv.json`, `token-liat.json`, `credentials.json`
- PM2 stdout log: `/home/ubuntu/.pm2/logs/besinsky-bot-out.log`
- Cron-job logs: `logs/` (`triage.log`, `reminder-job.log`, etc.)
- Watchdog state: `data/watchdog-state.json`; watchdog log: `/var/log/besinsky-watchdog.log`

> ⚠️ **`FAMILYBOT_DB_PATH`, not `DB_PATH`.** `initDB` only honors
> `FAMILYBOT_DB_PATH`. Setting the wrong var silently reads/writes the **live**
> prod DB. Always confirm the target before running any script that touches the DB.

---

## 2. Alert files — what each one means

Watchdogs and the in-process health monitor drop flag files in `/tmp` and send an
ntfy push. Learn these — they tell you *what kind* of failure you're looking at.

| File | Written by | Meaning | First move |
|---|---|---|---|
| `/tmp/watchdog-alert.json` | `infra/watchdog.sh` | 3+ consecutive watchdog failures (~15 min confirmed down) | Read `details`; check §4 by symptom |
| `/tmp/bot-stuck-alert.json` | `watchdog.js` escalation **and** `watchdog.sh` Check 1c/1d | Zombie socket, crash-loop, or frozen process | §4.2 / §4.3 |
| `/tmp/bot-startup.json` | `startup-marker.js` (I3) | `{phase: starting\|connected}` boot marker | See §3 |
| `/tmp/besinsky-restart-rate.json` | `watchdog.sh` Check 1c (I5) | Last-seen PM2 `restart_time` + ts | Diagnostic only |
| `/tmp/openclaw-channel-alert.json` | `health.js` | OpenClaw WA channel not linked/connected/healthy | §4.4 |
| `/tmp/anthropic-credit-alert.json` | `src/llm/fallback.js` | Anthropic returned 402/529 or "credit balance"/"insufficient_funds" — credits exhausted; the notice/summary path has fallen back to Gemini | Top up at console.anthropic.com; bot keeps working on Gemini meanwhile. Delete the file once resolved. |
| `/tmp/backup-sqlite-alert.json` | `backup-sqlite.sh` | Backup failed verification | §5 |

ntfy topic (Aviv's backup push): `besinsky-watchdog-af40ab37`
(`curl -d "test" ntfy.sh/besinsky-watchdog-af40ab37` to sanity-check delivery).

---

## 3. Startup-phase marker (I3) — how to read it

`/tmp/bot-startup.json` is written at boot **before** any slow init and
flipped to `connected` once WhatsApp opens:

- `markStarting()` at the top of `src/index.js` → `{phase:"starting"}`
- `markConnected()` in `src/whatsapp.js` on connection open → `{phase:"connected"}`
- `clear()` on SIGINT/SIGTERM (clean shutdown) → file removed

The watchdog (Check 1b) alerts when:
- `phase === "starting"` and marker is **>5 min old** → `startup-stuck(N min)` — the
  bot wedged during boot (DB init, profile load, or Baileys handshake).
- marker **missing** while PM2 says `online` → `startup-marker-missing` — it never
  got far enough to write it, i.e. **crashing before boot completes** (crash-loop).

```bash
cat /tmp/bot-startup.json          # phase + age
pm2 logs besinsky-bot --lines 100       # find where boot dies
```

A pre-connect crash-loop is the failure the outage exposed — before I3 it was
completely invisible because the HTTP health probe only answers *after* connect.

---

## 4. Symptom → diagnosis → fix

### 4.1 Bot process down / missing / errored
**Signals:** `bot-missing`, `bot-<status>`, `bot-pm2_error` in the alert;
`pm2 status` shows `stopped`/`errored` or no entry.

```bash
pm2 status
pm2 logs besinsky-bot --lines 100 --err
df -h /home/ubuntu                       # disk full? bot refuses to boot <1GB free (I1)
pm2 restart besinsky-bot
```
If it won't stay up, read the boot log — the most common non-crash cause is a
disk-space preflight abort (see §6) or a missing prod-only file (§7).

### 4.2 Crash loop (I5 — Check 1c)
**Signal:** `crash-loop(N/Mmin)` and `/tmp/bot-stuck-alert.json`.
The watchdog saw PM2 `restart_time` jump by **>3 in ~5 min**.

```bash
pm2 describe besinsky-bot | grep -i restart      # confirm the count
pm2 logs besinsky-bot --lines 200 --err          # find the repeating stack
cat /tmp/bot-startup.json                    # stuck in 'starting'? → §3
```
Fix the crash cause before restarting — a bare `pm2 restart` just resumes the
loop. Common causes: bad token/credential file, DB lock, prod-only file missing (§7).
The alert file clears automatically on the next successful connect
(`whatsapp.js` unlinks it).

### 4.3 Process frozen / zombie socket
**Signals:** `log-frozen(N min)` (I5 Check 1d — no stdout for >30 min during
08–22 Israel while `online`), or a zombie escalation from the in-process
`watchdog.js` (3 zombie resets in 1h → stops auto-reconnect + writes the stuck file).

The process is "up" but not processing anything.
```bash
curl -s localhost:3001/health | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(d))'
ls -l /home/ubuntu/.pm2/logs/besinsky-bot-out.log   # mtime = last output
pm2 restart besinsky-bot
```
A restart is the correct fix for a wedged socket. If it re-wedges within the hour,
suspect the WhatsApp session (§4.5).

### 4.4 WhatsApp disconnected / not receiving
**Signals:** `wa-disconnected`, `probe-fail(...)`, `/tmp/openclaw-channel-alert.json`,
or the in-process "global outage" DM (all groups silent for >9 active hours).

```bash
curl -s localhost:3001/health        # whatsapp_connected + whatsapp_state
curl -s localhost:3001/health-probe  # active round-trip probe
```
`whatsapp_state` is one of `connected | stale | awaiting_qr | disconnected` (I2).
- `stale` / `disconnected` → restart the bot; it auto-reconnects.
- `awaiting_qr` → **session invalidated**, needs a human QR scan (§4.5).

### 4.5 Needs QR / session invalidated
If a QR appears on an existing session, that means WhatsApp dropped the linked
device. There is no way around a physical re-scan:
1. `pm2 logs besinsky-bot` — the QR renders in the terminal (`qrcode-terminal`).
2. On the bot's phone: WhatsApp → **Linked Devices** → **Link a device** → scan.
3. Confirm `whatsapp_state` returns to `connected`.
If the session is corrupt, restore from backup (§5) before re-scanning.

### 4.6 Volume anomaly
**Signal:** `volume-<name>` from `scripts/volume-check.js`. Message/notice
throughput is off (spike or drop). Usually downstream of a connection problem —
resolve §4.4 first, then re-check. Not on its own an emergency.

---

## 5. Backups & restore

Daily at 03:00 UTC (crontab):
- `scripts/backup-auth-session.sh` → WhatsApp session tarball
- `scripts/backup-sqlite.sh` → `backups/family-YYYY-MM-DD.db`, 7-day retention,
  optional S3 upload if `S3_BACKUP_BUCKET` is set.

Both **verify after write** (size + decrypt + tar/integrity) and only prune old
backups after a verified-good new one (I4). On failure they write
`/tmp/backup-sqlite-alert.json` and skip pruning — so a broken backup never
deletes your good ones.

```bash
tail -50 backups/backup.log            # last run result
ls -lt backups/                        # newest good backup

# Restore DB (STOP the bot first — never swap a live DB):
pm2 stop besinsky-bot
cp data/family.db data/family.db.bak.$(date +%s)
cp backups/family-YYYY-MM-DD.db data/family.db
pm2 start besinsky-bot
```
Restore the session tarball into `whatsapp-session/` the same way (stop → swap →
start). Expect a QR re-scan if the session is stale.

---

## 6. Disk space (I1)

A full disk silently corrupts the Baileys session and SQLite DB — this was a root
cause on 2026-09-09. Guards now in place:
- `health.js` monitors the app partition: **warn 80%, alert 85%, critical >90%**
  (critical = immediate DM to Aviv, hourly-rate-limited).
- `index.js` **refuses to boot with <1GB free** rather than truncate the session.
- `/health` exposes `disk_free_pct` / `disk_used_pct` / `disk_free_gb`.

```bash
df -h /home/ubuntu
du -sh whatsapp-session/ ~/.npm ~/.pm2/logs 2>/dev/null   # usual space hogs
pm2 flush                                                  # truncate PM2 logs
```
Weekly cleanup runs Sundays (`/home/ubuntu/scripts/weekly-disk-cleanup.sh`).
If the bot won't start and the log says the disk preflight aborted, free space
**before** restarting.

---

## 7. Gotchas (learned the hard way)

- **Prod-only files.** `lib/voice-client.js` and `consolidate-notices.js` may exist
  on prod but not in git. A fresh checkout without them crash-loops on boot. If the
  bot crash-loops right after a deploy, check these exist. (B1 added an HTTP fallback.)
- **Wrong DB var.** `FAMILYBOT_DB_PATH`, not `DB_PATH` (§1). Wrong var → you edit prod.
- **Two watchdogs** (§1) — don't assume an alert reflects your latest code until you
  know which watchdog fired.
- **Schema drift.** Prod has had columns `db.js` never migrated. Before trusting a
  column exists, verify on the actual DB: `sqlite3 data/family.db "PRAGMA table_info(<table>);"`.
- **`notice_event` has no `location` column** — queries that need it must `SELECT NULL AS location`.
- **Health-check quiet hours.** In-process checks are skipped Fri/Sat (Shabbat) and
  night gaps are excluded from outage math — a quiet night is not an outage.

---

## 8. Quick command reference

```bash
# Process
pm2 status
pm2 logs besinsky-bot --lines 100
pm2 restart besinsky-bot
pm2 describe besinsky-bot | grep -i restart

# Health
curl -s localhost:3001/health
curl -s localhost:3001/health-probe

# Watchdog (out-of-band)
systemctl status besinsky-watchdog.timer
cat data/watchdog-state.json
tail -50 /var/log/besinsky-watchdog.log
ls -l /tmp/*alert*.json /tmp/bot-startup.json 2>/dev/null

# OpenClaw channel
systemctl --user status openclaw-gateway
openclaw channels status --json

# Disk
df -h /home/ubuntu

# Manual watchdog run (dry sanity check)
/home/ubuntu/besinsky-bot/infra/watchdog.sh
```

---

## 9. Emergency — disable the bot entirely

When the bot is doing harm (spamming groups, corrupt state, mid-incident) and you
need it fully off — not just restarted:

```bash
# 1. Stop the process. `pm2 stop` keeps it in PM2's list (fast to resume);
#    `pm2 delete` removes it so nothing can auto-revive it.
pm2 stop besinsky-bot           # pause
#   or, to remove entirely:
pm2 delete besinsky-bot
pm2 save                         # persist so a host reboot doesn't resurrect it

# 2. Silence the watchdogs so they don't page or restart-nag while it's down.
sudo systemctl stop besinsky-watchdog.timer   # systemd copy (repo watchdog)
# If the legacy cron watchdog is active, disable it too:
sudo rm -f /etc/cron.d/bot-watchdog            # (§1 — the /home/ubuntu/watchdog.sh copy)

# 3. (Optional) stop the cron jobs that assume the bot is up.
crontab -l                       # review; comment out triage/reminders/backups as needed
```

A clean `pm2 stop`/SIGTERM clears `/tmp/bot-startup.json` (I3), so the
startup-marker check won't false-alarm while the bot is intentionally down.

**To bring it back:** re-enable the watchdog timer, restore any cron entries, then
`pm2 start besinsky-bot` (or `pm2 start src/index.js --name besinsky-bot` if it was
deleted) and verify with §8.

---

## 10. Escalation

1. Try the by-symptom fix above (usually `pm2 restart besinsky-bot`).
2. If it won't stay up: read `pm2 logs --err`, check disk (§6), check startup marker (§3).
3. If the session is dead: QR re-scan (§4.5), restore from backup if corrupt (§5).
4. Persistent crash-loop with a clean disk and valid session → capture
   `pm2 logs --err --lines 300`, the startup marker, and `data/watchdog-state.json`,
   then investigate the stack. Do not leave auto-reconnect disabled silently — the
   in-process watchdog stops it after 3 escalations in an hour; a restart re-arms it.
