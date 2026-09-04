# FamilyBot — Architecture Principles

These are concluded, non-negotiable design principles derived from real production incidents.
Each principle has a source incident and a rationale.

Before any commit: run `node tests/check-principles.js` to verify no principle is violated.
Before any architect/expert consultation: include this file as context.

---

## P-001 — Single Actor for Notices

**Principle:** Exactly one process is responsible for reading `notices WHERE posted_to_master=0` and sending to the master group. No two scripts may simultaneously query and act on the same notice queue.

**Source incident:** 2026-06-18 — `send-unposted-notices.js` (*/5 cron) and `triage-engine.js` (*/15 cron) both fired at :30, both queried `posted_to_master=0` before either committed, both sent the same שלפים trip notice to the family.

**Root cause:** SQLite WAL mode allows concurrent reads. Flags written after the side effect (send) cannot prevent races at simultaneous start. No amount of flag-checking in the reader query fixes this — only having one reader fixes it.

**Rule:**
- `triage-engine.js` is the sole authorized sender to the master group from the notices queue
- All other scripts that previously read `notices WHERE posted_to_master=0` must be disabled or converted to read-only analysis tools
- `consolidate-notices.js` may only touch notices where `posted_to_master=0 AND triage_decision IS NULL` (unprocessed notices only)
- Any new script that needs to query the notices queue must first check: is triage still the sole sender? If not, coordinate explicitly

**Verification (automated):**
```bash
# Check: no other cron script reads posted_to_master=0 and sends
grep -r "posted_to_master" . --include="*.js" \
  | grep -v "triage-engine\|consolidate-notices\|noticeDelivery\|db.js\|tests\|node_modules"
# Expected: no output (no unauthorized readers)
```

---

## P-002 — No Timeout as Normal Operation

**Principle:** A cron job or scheduled task that consistently times out is not "working but slow" — it is broken. A timeout is a failure, not an acceptable outcome.

**Source incident:** 2026-06-18 — triage cron ran inside an OpenClaw isolated agentTurn session. Session startup consumed 30–50s of a 120s budget before a single line of triage code ran. With 8+ buckets × sequential 30s LLM calls, worst-case runtime was ~380s against a 120s limit. The job timed out 20 consecutive times and was never retried.

**Rule:**
- Any job that runs LLM calls must be sized for worst-case N calls, not average-case
- Jobs with variable LLM call counts must have a wall-clock budget guard that gracefully defers overflow work
- Session startup overhead must be excluded from the job's computational budget — if overhead is >20% of the timeout, move the job to system cron
- 3 consecutive errors on a job triggers an investigation, not a retry increase

---

## P-003 — Watchdog Must Be Independent of What It Watches

**Principle:** A monitoring/alerting system cannot use the same infrastructure as the system it monitors.

**Source incident:** 2026-06-18 — The OpenClaw cron health watchdog was itself an agentTurn job with a 120s timeout. It failed with 16 consecutive timeouts for the same reason as the system it was watching (session startup overhead). Aviv had no alerts for 16 consecutive failures.

**Rule:**
- Watchdogs must be pure bash or minimal Node.js — no LLM sessions, no OpenClaw scheduling
- Watchdogs must alert via an independent channel (e.g., direct HTTP to voice server → WhatsApp) not through the system being watched
- Alert delivery must not depend on WhatsApp being connected (file-based fallback required)

---

## P-004 — Notices Are Immutable Once Sent

**Principle:** A notice that has been sent to the master group (`posted_to_master=1`) must not be modified, merged, deleted, or resurfaced by any pipeline.

**Source incident (risk, not yet triggered):** `consolidate-notices.js` was querying all non-dismissed notices regardless of `posted_to_master`. It could delete already-sent notices and re-insert merged rows with `posted_to_master=0`, causing triage to re-send them.

**Rule:**
- Any query that writes to the notices table must filter `AND posted_to_master=0`
- Any query that deletes from notices must filter `AND posted_to_master=0`
- Consolidation (merging duplicate notices) must only operate on `triage_decision IS NULL AND posted_to_master=0`
- Historical notices (posted_to_master=1) are audit records — read-only

---

## P-005 — Dismissal Is Respected Immediately

**Principle:** When a user says "stop sending about X" in the master group, all pending notices matching that dismissal must be suppressed in the same transaction — not on the next triage run.

**Source incident:** 2026-06-18 — Aviv explicitly asked in the master group to stop sending about a movie event. The bot had no dismissal mechanism. The message was received and silently ignored.

**Rule:**
- `DISMISSAL_REGEX` must be checked on every master group message before any other command handling
- On dismissal match: pending notices matching scope must be marked `triage_decision='skip', posted_to_master=1` synchronously in the same handler
- Confirmation must be sent back to the user
- Dismissal records must be stored with an expiry (default 48h) and checked by triage on every run

---

## P-006 — Cross-Day Dedup for Notices

**Principle:** The same real-world event discussed across multiple days must produce at most one sent message per topic, regardless of which day's messages generated the notice.

**Source incident:** 2026-06-18 — A movie event on June 19 was discussed on both June 17 and June 18. Each day's discussion created a separate bucket (by creation date) in triage, generating two separate sent messages.

**Rule:**
- Sent message dedup window must cover at least 72 hours, not just the current calendar day
- Triage's `sentToday` (renamed `sentRecent`) must look back 72h
- The `immediate` bypass must also check recent sent context before firing

---

## P-007 — Validate External Output Before State Commit

**Principle:** External system output (LLM responses, API calls) is untrusted input. The system must validate against an explicit schema BEFORE committing any state transition. Never persist a state that makes an artifact unreachable (i.e., no exit path in the state machine).

**Source incident:** 2026-06-24 — ISSUE-017: triage-engine committed `triage_decision='send_now'` before validating that `merge_group` was non-null. Notices with `merge_group: null` were then invisible to the queue (filtered by `triage_decision IS NULL`) and never delivered. Dead letter.

**Rule:**
- Validate LLM output against an explicit schema before any DB write
- Normalize invalid-but-recoverable output (e.g., null merge_group → auto-generated key) with a warning
- Commit state transitions AFTER validation, not before
- Never use `continue` silently in a loop processing external data — always log why an item was skipped
- Every non-terminal state in the system must have a defined exit path

**Verification:**
```bash
# Check: groupByMergeGroup logs errors for missing merge_group (no silent continue)
grep -n "BUG: send_now" src/triage-engine.js
# Expected: one matching line with console.error

# Check: normalizeDecisions is called before markNoticesTriaged in runTriage
grep -n "normalizeDecisions\|markNoticesTriaged\|groupByMergeGroup" src/triage-engine.js
# Expected: normalizeDecisions appears before markNoticesTriaged
```

---

---

## P-008 — Every Message Must Reach a Terminal Pipeline State

**Principle:** Every incoming WhatsApp message that enters the notice extraction pipeline must transition through a defined state machine and reach a terminal state (`NOT_ACTIONABLE`, `NOTICE_CREATED`, or `FAILED`) within 30 minutes. Messages stuck in intermediate states are system failures. Silent success (returning without a state transition) is forbidden.

**Source incident:** 2026-06-24 — ISSUE-019: Token truncation caused `handleGroupEvent` to produce no output and return with no error. The message had no corresponding pipeline state, making it completely invisible to monitoring. Aviv found out only by manually checking his phone the next day.

**Rule:**
- The `messages.pipeline_state` column is the single source of truth for extraction status
- `handleGroupEvent` MUST call `markMessageProcessing(messageId)` before any API call
- Every code path in `handleGroupEvent` MUST end with `markMessageTerminal()` or `markMessageFailed()`
- A message in `PROCESSING` for >5 minutes triggers a logged warning
- A message in `PROCESSING` for >30 minutes triggers `markMessageFailed()` + alert
- "Silent success" (function returns without state transition) is a P-008 violation
- `pipeline-monitor.js` (system cron `*/5`) enforces these time limits

**Verification:**
```bash
# Check: handleGroupEvent marks processing before API call
grep -n "markMessageProcessing" src/agent.js
# Expected: at least one line in handleGroupEvent

# Check: pipeline monitor is registered in crontab
crontab -l | grep pipeline-monitor
# Expected: */5 * * * * ... pipeline-monitor.js
```

---

## P-009 — Notice State Coherence

**Principle:** A notice must have a coherent, consistent state at all times. A notice marked `triage_decision='skip'` must simultaneously have `delivery_status='skipped'`. The batch delivery system (`noticeDelivery.js`) must never re-process or re-send a notice that the triage engine has already decided to skip or defer.

**Source incident:** 2026-07-16 — AgentCouncil FYI-Noise incident. Triage engine correctly classified costume-party photo dumps as `skip`, but `noticeDelivery.js` batch ignored `triage_decision` entirely and re-summarized and sent them anyway. The LLM itself noted "no payment details, no deadlines" in its own output — then sent it regardless.

**Root causes (three independent):**
1. `noticeDelivery.js:getPendingNotices` queried only `delivery_status='pending'`, ignoring `triage_decision`
2. `triage-engine.js` set `triage_decision='skip'` but did NOT update `delivery_status` — states were incoherent
3. No cluster gate existed: batch delivery would send any non-empty pending list regardless of actionability

**Rule:**
- When triage sets `triage_decision='skip'`, it MUST also set `delivery_status='skipped'` in the same statement
- `noticeDelivery.js:getPendingNotices` MUST filter `triage_decision NOT IN ('skip', 'defer')` in addition to `delivery_status='pending'`
- Batch delivery MUST have a cluster gate: if no notice in the batch has `urgency_hint IN ('immediate','time_sensitive')` or a `relevance_date`, skip the batch entirely
- `delivery_status` values: `pending`, `skipped`, `delivered_immediate`, `delivered_batch`, `dead_letter`
- Any code path that skips/dismisses a notice must update BOTH `triage_decision` AND `delivery_status` atomically

**Verification:**
```bash
# Check: getPendingNotices filters triage_decision
grep -A5 "getPendingNotices" src/noticeDelivery.js | grep "triage_decision"
# Expected: triage_decision NOT IN

# Check: skip decisions set delivery_status='skipped'
grep -n "delivery_status.*skipped" src/triage-engine.js
# Expected: at least 3 lines (end loop, dismissal path, immediate dismissal path)

# Check: cluster gate exists in deliverBatch
grep -n "Cluster gate" src/noticeDelivery.js
# Expected: one matching line
```

---

## P-013 — No Direct Agent Writes to SQLite

**Principle:** OpenClaw and any agent write to SQLite only through sanctioned functions exported by `db.js` or endpoints on `voice-server.js` (port 3001). Direct SQL from an agent session is forbidden.

**Source incident:** ISSUE-023, 2026-08-30 — an LLM agent performed a direct DB write (`UPDATE groups SET related_to='<child-name>'`) with a plausible-but-wrong column convention. The write passed silently because nothing validated the value. The group stopped being monitored for nine hours.

**Root cause:** the agent wrote a child name into a column that the reader (`isMonitoredGroup`) checked for the exact string `'monitored'`. No validation layer existed between the agent's SQL and the DB because the agent bypassed every sanctioned function. Any schema with enum-like columns is vulnerable to the same pattern.

**Rule:**
- All writes to the `groups` table go through `setGroupMonitoring()` or the `POST /api/groups/monitoring` endpoint.
- All writes to other tables with enum columns (`notices.delivery_status`, `notices.triage_decision`, `messages.pipeline_state`) go through the corresponding sanctioned functions in `db.js`.
- OpenClaw config must not include raw `sqlite3` or `UPDATE`/`INSERT`/`DELETE` commands targeting `family.db`.
- A nightly integrity check (`checkEnumIntegrity()` / `GET /api/integrity/enums`) asserts no out-of-vocabulary values exist.

**Verification:**
```bash
# Check: no direct UPDATE/INSERT to groups outside db.js
grep -rn "UPDATE groups" --include=*.js . | grep -v node_modules | grep -v "src/db.js"
# Expected: no output

# Check: integrity endpoint exists
curl -s http://localhost:3001/api/integrity/enums | jq .ok
# Expected: true
```

---

## Adding New Principles

When a production incident, architect consultation, or expert review concludes with a design rule:
1. Add an entry here with a P-XXX number
2. State: principle, source incident, rule, verification method
3. Add a corresponding test in `tests/check-principles.js`
4. Reference it in commit message and ISSUES.md if incident-driven

---

## P-010 — Single Owner Per Group (Conversation Continuity)

**Principle:** Each WhatsApp group must have exactly one owning component responsible for message handling. Dual-consumer architectures (where two components both partially handle the same group) create gaps where neither handles a message.

**Source incident:** ISSUE-022, 2026-07-26 — Liat's "תכניס ליומן" was ignored because Tudat's `handleMasterGroupCommand()` is a no-op and OpenClaw's mention-gate blocked messages without "ליפא". Follow-up question "ל2 היומנים?" was also dropped (no context + same gate). Aviv had to tag the bot by name for every single request.

**Root causes:**
1. OpenClaw mention-gate (`mentionPatterns: ["ליפא", "lipa"]`) required explicit name tagging even from authorized family members
2. No `historyLimit` set → each session turn started with no prior context → follow-up questions had no connection to previous actions
3. `handleMasterGroupCommand()` in Tudat was a no-op, so Tudat did nothing, and OpenClaw was mention-gated → gap

**Rule:**
- **Master group (משימות בסינסקי):** Owned by Lipa (OpenClaw). `requireMention: false` in OpenClaw group config. Tudat's `handleMasterGroupCommand()` remains a no-op.
- **School/class groups:** Owned by Tudat for extraction. OpenClaw provides tools on request.
- OpenClaw must have `historyLimit >= 20` on `messages.groupChat` so follow-up questions have context.
- Tudat logs all master group messages (inbound + outbound) to `dm-history.jsonl` via `appendDMHistory()` for audit and fallback context.

**Verification:**
- `openclaw.json`: `channels.whatsapp.groups["120363426994367917@g.us"].requireMention === false`
- `openclaw.json`: `messages.groupChat.historyLimit >= 20`
- `whatsapp.js`: `appendDMHistory` called on master group inbound messages and `sendToMasterGroup` outbound

---

## P-011 — No Silent Fall-Through in Master-Group Handlers

**Principle:** Every master-group message reaching a handler must exit through a logged branch. Silent fall-through is a P-011 violation.

**Source incident:** ISSUE-023, 2026-08-30 — a quoted reply in the master group failed to match any pending group question because `getQuotedMessage()` reconstructed the lookup id incorrectly. The reply then fell out of the quoted-reply block with no log line and no alert. Three layers failed silently in sequence and nine hours passed before anyone noticed the group was never configured.

**Root cause:** the quoted-reply block returned only on a positive match (pending question, delimiter fallback, or follow-up). The no-match path just ran off the end of the `try` into the next block, producing no signal. Invisible failures cannot be noticed, so they persist.

**Rule:**
- A quoted reply in the master group that matches no handler must emit `logger.warn(..., 'Quoted reply matched no handler')` before falling through.
- When the quoted message was sent by the bot (`quotedMsg.fromMe`), DM Aviv (rate-limited hourly) so a lost command becomes noisy, not invisible.
- Any new branch added to the master-group reply/command handling must end in an explicit logged outcome — never an implicit fall-through.

**Verification:**
```bash
# Check: the no-match warn exists in the master-group quoted-reply block
grep -n "Quoted reply matched no handler" src/whatsapp.js
# Expected: one matching line

# Check: the unmatched-reply DM alert exists and is rate-limited
grep -n "alertUnmatchedReply\|_unmatchedReplyAlertAt" src/whatsapp.js
# Expected: definition + rate-limit guard + call site
```

---

## P-012 — Exactly One Sender for the Master Group

**Principle:** Exactly one process reads the notices queue and calls `voiceSend` for the master group. `deliver-batch.js` and `deliver-immediate.js` are formatters invoked by triage, never independent readers.

**Source incident:** WORKPLAN-V4 B1, 2026-08-31 — two independent readers of the notices queue ran with divergent policy. `triage-engine.js` (`*/15`) claimed via `send_attempted_at`, applied the 72h `sent_messages` window, `GROUP_DAILY_CAP=3`, topic dismissals, quiet hours, and thread-continuity downgrade. `noticeDelivery.js` via `deliver-batch.js` (07/12/16/20) selected `delivery_status='pending' AND (triage_decision IS NULL OR triage_decision NOT IN ('skip','defer'))` and sent with **no `send_attempted_at` check, no 72h context, no daily cap, no dismissal check**. The overlap (`triage_decision IS NULL`) included notices triage had claimed seconds earlier and was mid-LLM-call on — every Phase 2.3 guardrail was bypassed four times a day. Same structural bug as P-001 and ISSUE-023, in the delivery layer.

**Root cause:** two components each partially owned delivery, so neither owned it and the guardrails leaked. A second reader cannot be made safe by adding flag checks to its query (see P-001) — only having one reader fixes it.

**Rule:**
- `triage-engine.js` is the sole process that reads the notices queue and calls `voiceSend` for the master group. It owns the `*/15` triage run, the `TRIAGE_MODE=digest` drain (07/12/16/20), and the `TRIAGE_MODE=immediate` drain (every 5 min).
- The digest drains `triage_decision='defer'` notices — it does **not** re-read `delivery_status='pending'`. Deferred notices are triage-approved for the morning/daytime digest; the digest is their only delivery path.
- `deliver-batch.js` and `deliver-immediate.js` are thin launchers that invoke triage (`TRIAGE_MODE=digest` / `TRIAGE_MODE=immediate`). They must not read the notices queue and must not call `voiceSend`/`sendToMasterGroup` themselves.
- `noticeDelivery.js` provides pure formatters (`deliverBatch(notices)` builds the digest text; `deliverImmediate(notice)` builds the immediate text). A formatter takes an explicit notice list, returns text, reads nothing, and sends nothing.
- Any new script that needs to deliver to the master group must delegate to triage, never open a second send path.

**Verification:**
```bash
# Check: exactly one queue reader that sends (files in src/ that read the queue AND send)
grep -rln "posted_to_master\|delivery_status = 'pending'" --include=*.js src/ \
  | xargs grep -ln "voiceSend\|sendToMasterGroup"
# Expected: src/triage-engine.js only

# Check: the delivery launchers delegate to triage and never send directly
grep -c "TRIAGE_MODE" deliver-batch.js deliver-immediate.js   # Expected: >=1 each
grep -c "voiceSend\|/send-message" deliver-batch.js deliver-immediate.js  # Expected: 0 each
```

---

## P-015 — No Calendar Event Without a Validated Source

**Principle:** No calendar event, reminder, or family-facing factual claim is written without a validated source row. A value absent from the source is reported as absent, never inferred.

**Source incident:** ISSUE-025 — Lipa fabricated an 18:30 time for a parent meeting (אסיפת הורים) when the source notice only carried a date. `guardedSend` + `sourceValidator` covered reminder sends, but calendar writes went through `calendarGate.js:processEventAction()` with no source validation, so an agent-proposed time that appeared nowhere in the source was written to the family calendar.

**Root cause:** the guard boundary stopped at reminder sends. Calendar writes — the other outbound factual surface — had no equivalent grounding check, so any field an agent proposed (date, time, location) was trusted verbatim.

**Rule:**
- Agent-proposed calendar writes carry a `source_notice_id`. `processEventAction()` calls `validateCalendarWrite(source_notice_id, {date, time, location, summary})` before proceeding.
- Each non-null proposed field must be grounded in the source notice: `date` matches `relevance_date` or appears in `content`; `time` matches `relevance_time` or appears in `content`; `location` appears in `content`. A field the source never states (e.g. a time it never mentioned) is a rejection.
- On rejection: `logBlocked('calendar_write', action, reason)` and return `{ action: 'blocked' }` — nothing is written.
- Writes with no `source_notice_id` (e.g. a direct user request through Lipa) proceed but log a warning, so the ungrounded path stays visible.
- `calendar-bridge.js:createCalendarForNotice()` derives its fields from the notice row itself and is not an agent proposal — it is out of scope for this guard.

**Verification:**
```bash
# Check: the grounding validator exists and calendarGate calls it before writing
grep -n "function validateCalendarWrite" src/validation/sourceValidator.js
grep -n "validateCalendarWrite" src/calendarGate.js
# Expected: a definition in sourceValidator.js and a call in calendarGate.js
```

---

## P-014 — Every Shim Field Has a Fixture Test

**Principle:** Every field of the whatsapp-web.js compatibility surface in `src/baileys-client.js` has a fixture test. No shim field may be added or changed without one.

**Source incident:** ISSUE-023, 2026-08-30 — `baileys-client.js` is a translation layer that makes Baileys objects impersonate whatsapp-web.js objects (`BaileysMessage`, `BaileysChat`, `normalizeJid`/`toWWebJid`/`toBaileysJid`), built on a release-candidate dependency (`7.0.0-rc14`) with **zero tests**. ISSUE-023 (a wrong `getQuotedMessage()` id) lived here. A second latent defect was found while mapping it: `@lid` participants passed through the JID converters untouched and never matched phone-based identity lookups — a silent ISSUE-023 repeat waiting to happen.

**Root cause:** the riskiest file in the repo — another library's conventions reproduced on top of an RC — had no net. Nothing pinned the shape it emits, so a shape change (or a missed JID form) could not be caught.

**Rule:**
- Every whatsapp-web.js-shaped field the shim emits (`id._serialized`, `id.fromMe`, `from`, `to`, `author`, `type`, `body`, `hasMedia`, `hasQuotedMsg`, `getQuotedMessage()` round-trip) is pinned by a hand-authored fixture in `tests/shim/fixtures/`.
- Fixture expectations are written **by hand**, never generated from the shim's own output — a self-labelled fixture only proves the shim agrees with itself.
- Adding or changing a shim field requires adding/updating a fixture in the same change. LID-form participant variants are mandatory: any new message shape gets a `@lid` fixture too.
- The suite runs in `npm test` and CI (pure fixtures, no API calls).

**Verification:**
```bash
# Check: the shim suite exists, passes, and covers LID cases
node tests/shim/run.js
grep -rl "@lid" tests/shim/fixtures/ | wc -l   # Expected: > 0

# Check: the suite is wired into npm test
test -f tests/regression/2026-08-30-baileys-shim.js && echo "bridged into npm test"
```
