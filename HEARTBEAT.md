# HEARTBEAT.md

## Every heartbeat — do these checks:

### 1. Scan Tudat's monitored group DB
Lipa and Tudat are on the same server — run locally:
```
cd /home/ubuntu/besinsky-bot && node check-msgs.js --since=TIMESTAMP 2>/dev/null
```
Replace TIMESTAMP with the `monitoredGroups` value from memory/heartbeat-state.json (milliseconds).

After scanning:
- Update `memory/heartbeat-state.json` with new `monitoredGroups` timestamp
- Update the "Recent Monitored Group Activity" section in GROUP_CONTEXT.md with a concise summary of what's new
- If anything is genuinely important (upcoming event, time-sensitive notice), post it to the master group via sessions_send to session `agent:personal:whatsapp:group:120363426994367917@g.us`

### 2. Decide what to surface
Surface to master group if:
- Event with a clear date in the next 7 days
- Urgent notice (today/tomorrow)
- Something the family needs to act on

Stay silent if:
- Construction updates (בית בסינסקי-רשפים) — unless truly urgent
- Chit-chat, reactions, "thanks"
- Duplicates of what was already surfaced
- **Anything covered by a pending cron job** — see sendGuard rule below

## 🛑 sendGuard — Never pre-fire a scheduled cron reminder

**RULE: If a cron job already exists to send a reminder on date X, do NOT send that reminder early via heartbeat or conversation.**

When you see an upcoming reminder in the cron list (e.g. ורמוקס לירדן, June 23), the correct behavior is:
- Acknowledge it in conversation if asked ("Yes, reminder is set for June 23")
- Do NOT DM Aviv about it proactively before it fires
- Do NOT include it in a heartbeat summary
- Let the cron fire at the scheduled time

This applies to ALL cron jobs with payload type `agentTurn` or `systemEvent`.
Violation pattern: reading the cron list, seeing an upcoming reminder, and DMing Aviv about it yourself — this causes duplicate delivery and confuses the user about timing.

### 3. Update GROUP_CONTEXT.md
Keep the "Recent Monitored Group Activity" section fresh — 3-5 bullet points max, covering the last 48 hours.



## State tracking
File: memory/heartbeat-state.json
Key: `monitoredGroups` — unix timestamp in ms of last check

---

## 4. Supervision Check (run every heartbeat, after steps 1-3)

You are the supervisor. Sub-agents (Gemini, Haiku, etc.) are workers. Your job: catch what they broke.

### Step A — Cron job health
Use the `cron` tool (action=list) to get all enabled jobs. For each:
- **Missed run?** lastRunAtMs is more than 2× the schedule interval ago → investigate
- **Failed run?** lastRunStatus != 'ok' → **self-heal** (see below)
- **Delivery failed?** delivery.mode != none AND lastDeliveryStatus != 'delivered' → re-trigger job

#### Self-heal protocol for failed/timed-out jobs (ISSUE-020)

**On timeout failure:**
1. Check current `timeoutSeconds` on the job
2. Double it, up to 120s max (same bounds as max_tokens self-heal)
3. Apply via `cron(action=update, jobId=..., patch={payload: {timeoutSeconds: <new>}})`
4. Re-trigger immediately via `cron(action=run, jobId=...)`
5. DM Aviv: "🔧 Auto-fix: [job name] timed out → raised timeoutSeconds [old]→[new], re-triggered ✅"

**On delivery failure after successful run:**
1. Re-trigger job via `cron(action=run, jobId=...)`
2. DM Aviv: "🔧 Auto-retry: [job name] ran but delivery failed → re-triggered ✅"

**Delete only after confirmed delivery:**
- Standard: one-shot reminder jobs must NOT use `deleteAfterRun: true`
- Job stays alive until `lastDeliveryStatus = delivered` is confirmed
- Once confirmed delivered: `cron(action=remove, jobId=...)` to clean up
- Never delete a job that has `lastRunStatus=failed` or `lastDeliveryStatus` not 'delivered'

### Step B — Tudat (besinsky-bot) connectivity

Run these three checks in order. If any fail → DM Aviv immediately via your own session (not the bot's).

**Check B1 — Process status:**
```bash
pm2 describe besinsky-bot --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const p=JSON.parse(d)[0];console.log('status:',p.pm2_env.status,'restarts:',p.pm2_env.restart_time,'uptime:',Math.round((Date.now()-p.pm2_env.pm_uptime)/60000)+'min');}catch(e){console.log('parse error',e.message);}})"
```
Alert if: `status` is not `online`, OR restart count increased significantly in last hour.

**Check B1b — Bot stuck flag (out-of-band alert):**
```bash
cat /tmp/bot-stuck-alert.json 2>/dev/null
```
If file exists and `ts` is within last 2h → **DM Aviv immediately** with the message content, then delete the file:
```bash
rm -f /tmp/bot-stuck-alert.json
```
This is how the bot alerts when WhatsApp itself is broken (can't use WhatsApp to say WhatsApp is down).

**Check B1c — Anthropic credit exhaustion flag (out-of-band alert):**
```bash
cat /tmp/anthropic-credit-alert.json 2>/dev/null
```
If file exists and `ts` is within last 6h → **DM Aviv immediately** with the message ("Anthropic credits exhausted — the bot has fallen back to Gemini for summaries; top up Anthropic credits"), then delete the file:
```bash
rm -f /tmp/anthropic-credit-alert.json
```
The bot writes this when an Anthropic API call fails with a credit error (402/529 or "credit balance"/"insufficient_funds"). LLM summaries auto-fall-back to Gemini, so the bot keeps working — but Anthropic credits need topping up.

**Check B2 — Health endpoint (primary connectivity check):**
```bash
curl -s --max-time 5 http://localhost:3001/health 2>/dev/null || echo '{"whatsapp_connected":false,"error":"server_down"}'
```
Parse the JSON and check:
- `whatsapp_connected: false` → **alert immediately** (do not wait for next heartbeat)
- `ready_failure_count > 0` → **alert immediately** — bot is in a reconnection loop
- `last_activity_ms` gap > 2h during 08:00–20:00 Israel → **alert**
- `last_activity_ms` gap > 6h during 20:00–08:00 Israel → **alert**

If the health endpoint is unreachable → treat as `whatsapp_connected: false`.

**Check B3 — Log scan for disconnection signals (fallback if /health unreachable):**
```bash
pm2 logs besinsky-bot --lines 15 --nostream 2>/dev/null | grep -iE 'QR|LOGOUT|disconnected|Ready event never fired|auth_failure'
```
Alert if: any of those strings appear in recent logs.

**If any check triggers — DM Aviv:**
```
⚠️ Tudat connectivity issue detected:
[paste what the check showed]
לא מקבל הודעות מהקבוצות. ייתכן שהבוט מנותק (QR code?). בודק...
```
Then investigate further (pm2 logs, restart attempt if appropriate).

### Step C — Master group content quality
Use sessions_history on `agent:personal:whatsapp:group:120363426994367917@g.us` (last 20 messages).
For each assistant message sent in the last 24h, check:
- Contains `<exec>`, `<tool`, `<function`, `<thinking`, raw JSON/XML? → **content error**
- Contains `Error:`, `TypeError:`, `undefined`, `null`, `traceback`? → **runtime error**
- Empty or under 20 chars when context expects a real message? → **empty delivery**

### Step C — Action protocol
If any anomaly found:
1. Investigate root cause (cron runs, last error, logs)
2. If trivial fix (e.g., re-run a timed-out job): do it
3. DM Aviv via sessions_send to `agent:personal:whatsapp:direct:+972504606660`:
   > "⚠️ [what happened]. שורש: [why]. רוצה לעשות: [proposed fix]. מאשר?"
4. Do NOT make significant config changes without Aviv's approval

### What counts as significant (needs approval):
- Changing a cron job's model, schedule, or payload
- Disabling or deleting a job
- Any change to delivery targets

### Step D — Stuck notice watchdog
Run:
```bash
cd /home/ubuntu/besinsky-bot && node -e "
const {initDB,getDB}=require('./src/db');initDB();
// Cutoff = 8 active daytime hours ago, ignoring 20:00-08:00 Israel (17:00-05:00 UTC)
const DAY_START=5,DAY_END=17; // UTC: 08:00-20:00 Israel
let rem=8*3600000,t=Date.now();
while(rem>0){
  const h=new Date(t).getUTCHours();
  if(h>=DAY_START&&h<DAY_END){
    const snap=new Date(t);snap.setUTCHours(DAY_START,0,0,0);
    const ms=t-snap.getTime();
    if(ms===0){t-=1;}else{const step=Math.min(rem,ms);t-=step;rem-=step;}
  }else{
    const snap=new Date(t);snap.setUTCHours(DAY_END,0,0,0);
    if(snap.getTime()>=t)snap.setUTCDate(snap.getUTCDate()-1);
    t=snap.getTime()-1;
  }
}
const cutoff=t;
const stuck=getDB().prepare(\"SELECT id,group_name,content,created_at FROM notices WHERE delivery_status='pending' AND dismissed=0 AND created_at<?\").all(cutoff);
if(stuck.length>0){console.log('STUCK:',stuck.length);stuck.forEach(n=>console.log(' -',n.group_name,n.content.substring(0,60)));}
else console.log('OK');
" 2>/dev/null
```
If output starts with 'STUCK:' → DM Aviv with the stuck count and oldest notice. Then investigate why delivery failed.

### Step E — Notice pipeline health (catch silent breakage)
Run:
```bash
cd /home/ubuntu/besinsky-bot && node -e "
const {initDB,getDB}=require('./src/db');initDB();
const israelHour=new Date(Date.now()+3*3600000).getUTCHours();
const windowH=israelHour>=8&&israelHour<23?12:24;
const cutoff=Date.now()-windowH*3600000;
const row=getDB().prepare('SELECT COUNT(*) as cnt FROM notices WHERE created_at>?').get(cutoff);
const total=getDB().prepare('SELECT COUNT(*) as cnt FROM notices').get();
console.log('notices_in_window:'+row.cnt+' window_h:'+windowH+' total:'+total.cnt);
" 2>/dev/null
```
Alert if `notices_in_window:0` AND it's daytime (08:00–23:00 Israel) AND `total` > 0 (DB is not fresh).
This means the notice pipeline is broken — messages are arriving but nothing is being extracted.
DM Aviv: "⚠️ אפס notices נוצרו ב-X שעות האחרונות. הבוט מקבל הודעות אבל לא מעבד אותן — ייתכן שיש crash בpipeline. בודק..."
Then check pm2 error log for repeated errors in handleGroupMessage.

### What you can do without approval:
- Re-running a failed job once
- Logging the issue to memory/YYYY-MM-DD.md
- Sending the DM itself
