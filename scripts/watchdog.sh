#!/bin/bash
# watchdog.sh — Besinsky Bot system watchdog
#
# No LLM. No OpenClaw. Runs in <2 seconds.
# Checks: PM2 status, WhatsApp health, triage log freshness, OpenClaw cron errors.
# Alerts via: localhost:3001/send-message (direct to WhatsApp, bypasses OpenClaw entirely).
#
# System cron: */15 * * * *
# (see: crontab -l)

LAST_ALERT_FILE=/tmp/besinsky-watchdog-last-alert
COOLDOWN_SECS=7200   # 2h between alerts to avoid spam
VOICE_SERVER=http://localhost:3001/send-message
ALERT_PHONE=+972504606660
TRIAGE_LOG=/home/ubuntu/besinsky-bot/logs/triage.log

issues=()

# ── 1. PM2 process health ────────────────────────────────────────────────────
PM2_INFO=$(pm2 jlist 2>/dev/null | node -e "
let d=''; process.stdin.on('data',c=>d+=c);
process.stdin.on('end',()=>{
  try {
    const procs = JSON.parse(d);
    const bot = procs.find(p=>p.name==='besinsky-bot');
    if (!bot) { console.log('NOT_FOUND:0'); return; }
    console.log(bot.pm2_env.status + ':' + (bot.pm2_env.restart_time||0));
  } catch(e) { console.log('PARSE_ERROR:0'); }
})" 2>/dev/null)

PM2_STATUS="${PM2_INFO%%:*}"
if [[ "$PM2_STATUS" != "online" ]]; then
  issues+=("🚨 Besinsky bot PM2 status: ${PM2_STATUS} (not online)")
fi

# ── 2. WhatsApp health endpoint ───────────────────────────────────────────────
HEALTH_JSON=$(curl -s --max-time 5 "$VOICE_SERVER/../health" 2>/dev/null ||
              curl -s --max-time 5 http://localhost:3001/health 2>/dev/null)

WA_CONNECTED=$(echo "$HEALTH_JSON" | node -e "
let d=''; process.stdin.on('data',c=>d+=c);
process.stdin.on('end',()=>{
  try {
    const r=JSON.parse(d);
    console.log(r.whatsapp_connected ? 'yes' : 'no');
  } catch(e){ console.log('error'); }
})" 2>/dev/null)

if [[ "$WA_CONNECTED" != "yes" ]]; then
  issues+=("🚨 WhatsApp disconnected (health endpoint returned: ${WA_CONNECTED:-no response})")
fi

# ── 3. Triage log freshness (system cron, should run every 15min) ─────────────
if [ -f "$TRIAGE_LOG" ]; then
  LAST_MODIFIED=$(stat -c %Y "$TRIAGE_LOG" 2>/dev/null || echo 0)
  NOW_S=$(date +%s)
  AGE_S=$((NOW_S - LAST_MODIFIED))
  if [ "$AGE_S" -gt 1800 ]; then   # 30 min = 2 missed runs
    MINS=$((AGE_S / 60))
    issues+=("⚠️ Triage hasn't run in ${MINS}m (expected every 15min)")
  fi
else
  # No log file yet — only warn if it's been >30min since this script started being deployed
  # (avoid false alarm on first deploy)
  :
fi

# ── 4. OpenClaw cron consecutive errors ───────────────────────────────────────
CRON_ISSUES=$(openclaw cron list 2>/dev/null | node -e "
let d=''; process.stdin.on('data',c=>d+=c);
process.stdin.on('end',()=>{
  try {
    const out = JSON.parse(d);
    const jobs = out.jobs || [];
    const failing = jobs.filter(j => j.enabled && (j.state?.consecutiveErrors||0) >= 3);
    if (failing.length > 0) {
      console.log(failing.map(j => j.name + ' (' + j.state.consecutiveErrors + 'x ' + (j.state.lastError||'') + ')').join(' | '));
    }
  } catch(e) {}
})" 2>/dev/null)

if [ -n "$CRON_ISSUES" ]; then
  issues+=("⚠️ OpenClaw cron failures: $CRON_ISSUES")
fi

# ── No issues → exit silently ─────────────────────────────────────────────────
if [ "${#issues[@]}" -eq 0 ]; then
  exit 0
fi

# ── Cooldown check ────────────────────────────────────────────────────────────
if [ -f "$LAST_ALERT_FILE" ]; then
  LAST_S=$(cat "$LAST_ALERT_FILE" 2>/dev/null || echo 0)
  NOW_S=$(date +%s)
  ELAPSED=$((NOW_S - LAST_S))
  if [ "$ELAPSED" -lt "$COOLDOWN_SECS" ]; then
    echo "[Watchdog] Suppressed (cooldown ${ELAPSED}s < ${COOLDOWN_SECS}s): ${issues[*]}" >&2
    exit 0
  fi
fi

# ── Build alert message ───────────────────────────────────────────────────────
ISSUE_TEXT=""
for issue in "${issues[@]}"; do
  ISSUE_TEXT="${ISSUE_TEXT}${issue}\n"
done

MSG="⚠️ *Besinsky Watchdog*\n${ISSUE_TEXT}\n$(date '+%H:%M UTC')"

# ── Send alert (direct to WhatsApp via voice server) ─────────────────────────
# Escape for JSON
MSG_ESCAPED=$(printf '%s' "$MSG" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null || echo "\"${MSG}\"")

RESPONSE=$(curl -s --max-time 10 -X POST "$VOICE_SERVER" \
  -H 'Content-Type: application/json' \
  -d "{\"to\":\"${ALERT_PHONE}\",\"text\":${MSG_ESCAPED}}" 2>/dev/null)

echo "[Watchdog] Alert sent: $RESPONSE" >&2

# Record last alert time
date +%s > "$LAST_ALERT_FILE"
