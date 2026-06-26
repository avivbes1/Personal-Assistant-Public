# ISSUES.md - Lipa Bug & Incident Log

---

## ISSUE-020 — Feature Design: Family Context Layer

**Date:** 2026-06-25
**Type:** Feature design (not a bug)
**Status:** IN PROGRESS — AgentCouncil running

**Problem statement:**
Tudat (the WhatsApp bot) operates with zero persistent knowledge of the family it serves. Every message is processed cold — Haiku has to re-infer "who is this group relevant to?", "is this important for this family?", "what are their preferences?" from scratch on each call. This caused ISSUE-019 (a missed critical notice) and causes ongoing quality issues in the morning digest and notice classification.

**Idea:** Build and maintain a "family context layer" — a compact, structured, machine-readable profile of the family injected into the Haiku extraction system prompt. Maintained continuously, capped in size, never allowed to go stale.

**Scope of design question:**
1. What exactly goes in the profile (schema)
2. How it gets injected (which system prompts, how much of the token budget)
3. How it gets created (initial population)
4. How it stays current (4 maintenance triggers: automated extraction, weekly heartbeat, event-triggered, conversation-triggered)
5. How size is bounded (hard cap, TTL on time-bound fields, pruning rules)
6. What quality gates prevent noise from corrupting it
7. Whether there are any architectural risks (P-001 through P-008 conflicts, cost implications)

**AgentCouncil:** 2026-06-25 — running now

---

## ISSUE-019 — Critical Notice Silently Dropped (Token Truncation + No Pipeline Observability)

**Date:** 2026-06-25
**Symptom:** Teacher sent "למחר" message in 🌼 הורי כיתה ו׳ 2 בני ודורית🌼 at 17:14 on June 24 with actionable instructions (what to send with Segev: costume, food, water bottle, pickup at 19:30). Message was received and processed by Haiku. No notice was saved to DB. Morning digest had no information about this event. Aviv found out by checking manually.
**Component:** `src/agent.js` — `handleGroupEvent()` (Haiku classification); `src/whatsapp.js` — message→notice pipeline
**Root Cause (confirmed):**
1. Haiku received the message and chose to emit 📨 question format (the instructions look calendar-worthy but optional)
2. System prompt has a "חובה: notice" rule — always emit `add_notice` JSON even when asking
3. `max_tokens=512` in `handleGroupEvent` API call is too tight. The 📨 question text alone consumed ~400 chars of budget. The `add_notice` JSON block (another ~200 chars) was never generated — truncated off the end.
4. Result: no notice in DB, triage never saw it, morning digest had nothing, no delivery.
5. No alert, no log warning, no self-detection. Aviv manually noticed.
**Secondary finding (same session):** Context bleeding — Haiku response for a ג׳3 message about musical instruments contained content about קימרון performance (from previous group context). Recent-messages context window bleeds across different messages.
**Systemic gap (Aviv's primary concern):** There is no pipeline observability. No checkpoints between:
  - message received → notice created → triage classified → sent
  Every stage fails silently. Lipa has no way to detect "I got a message from group X but no notice was created" without manually digging through logs. This means all previous incidents (ISSUE-014, ISSUE-017) also went undetected until Aviv reported them.
**AgentCouncil:** 2026-06-25 — complete, report at /home/ubuntu/AgentCouncil/runs/2026-06-25-issue-019/
**Stop-gap applied (autonomous, 2026-06-25):** `max_tokens` raised from 512 → 2048 in `src/agent.js` `handleGroupEvent()`. Bot restarted. This prevents truncation immediately.
**Status:** RESOLVED — Full fix shipped 2026-06-25.
**Fix shipped:**
- migrations/004_pipeline_state.sql: messages table gets pipeline_state, processing_started_at, processing_completed_at, notice_id, retry_count
- migrations/005_config_management.sql: bot_config + config_change_log tables; haiku_max_tokens, timeout, retry_max configurable by Lipa
- src/agent.js: handleGroupEvent refactored to tool calling API (GROUP_TOOLS), no more free-form JSON. tool_choice:any forces at least one tool call. Pipeline state: markMessageProcessing before API, markMessageTerminal/markMessageFailed on all code paths.
- src/db.js: markMessageProcessing, markMessageTerminal, markMessageFailed, getStuckMessages, getPipelineStats, getConfigValue, setConfigValue helpers
- src/whatsapp.js: passes messageId to handleGroupEvent; owner-guard marks NOT_ACTIONABLE; image-path upserts notice if not created by tool call
- src/voice-server.js: /health/pipeline endpoint + /config/propose endpoint
- src/pipeline-monitor.js: system cron */5 stuck-message scanner (warn at 5min, FAILED+alert at 30min, failure rate >20% alert)
- PRINCIPLES.md + tests/check-principles.js: P-008 added and checked (17/17 pass)
- System cron: */5 pipeline-monitor.js installed
- Lesson: tool calling API is the correct approach for structured extraction — no prose = no truncation risk

---

## ISSUE-007 — Calendar Duplicate Events (calendarGate)

**Date:** 2026-06-09
**Symptom:** Three calendar failures — "במקום" intent ignored (created new event instead of modifying), duplicate event from notice-scanner cron at wrong time, false confirmation.
**Component:** `src/calendar.js`, `src/agent.js`
**Root Cause:** LLMs as sole gate for calendar writes with no deterministic dedup or cross-source coordination.
**Status:** RESOLVED
**Fix:** Shipped 4-stage calendarGate (June 9-10): Stage 1 extracts intent, Stage 2 fetches real calendar ±1 day, Stage 3 semantic dedup, Stage 4 deterministic execution. Also added `calendar_intents` table for audit trail.
**2-week audit (2026-06-23):** 56 intents logged, 12 real writes, zero duplicate events. Phase 2 (enriched conflict prompt) NOT needed. System stable.

---

## ISSUE-008 - Confident Wrong Answer on Reminder Date (Lookup Discipline Failure)

**Date:** 2026-06-19
**Symptom:** Lipa said "ורמוקס לירדן ב-20:00 **הערב**" (tonight, June 19) when the actual cron job is scheduled for June 23 at 20:00. Only corrected when Aviv pushed back.
**Component:** Lipa conversational behavior / agent judgment
**Screenshot:** Incident report shared by Aviv 2026-06-19 ~14:16 Israel time

**Root Cause (initial):**
Lipa answered a factual question about a scheduled reminder WITHOUT querying the live cron system. The word "הערב" was asserted confidently from uncertain context/memory, not from `cron list`. When challenged, Lipa finally looked it up and corrected.

**Actual cron job:** `b795d969` - "תזכורת ורמוקס לירדן" - at `2026-06-23T17:00:00.000Z` (20:00 Israel)
**The claim:** "הערב" (tonight = June 19, 2026) - factually wrong by 4 days.

**Status:** RESOLVED - expert+architect double round complete
**Resolution:**
- [x] Rule added to AGENTS.md: "Lookup Discipline" section - tool-verifiable specific values must be looked up before asserting
- [x] NOT added to PRINCIPLES.md - architect confirmed behavioral rules belong in AGENTS.md, not with architectural invariants
- [x] Scope: all specific values (date/time/count/status) about system state, not just cron/reminders
- [x] Escape valves: most-recent-tool-call confirmations, general knowledge, qualitative questions
- [x] Tool-failure handling: don't fall back to memory when tool errors

**Lessons learned:**
- Architect Round 1: AGENTS.md is correct scope, not PRINCIPLES.md. Trigger is "specific value assertion," not domain.
- Architect Round 2: APPROVED. Tightened escape valve to "most recent tool call" (not "this session"). Added tool-failure pattern.
- "Incident report" (Aviv defined 2026-06-19): Aviv reports a problem → Lipa runs 2-round expert+architect drill → presents findings + solution plan → Aviv approves → only then execute. NOT a synonym for "screenshot of a bug."

---

## ISSUE-010 - Wrong Date: Relative Date Anchored to Processing Time Not Message Timestamp

**Date:** 2026-06-20
**Symptom:** Dance practice notice said "tomorrow (June 21)" when it was today (June 20). Two wrong notices (632, 635) were delivered_immediate before the correct one (640).
**Component:** `src/parser.js` L183
**Root Cause:** `resolveRelative()` uses `new Date()` (current clock) to compute מחר. Messages from June 19 saying מחר processed on June 20 → date becomes June 21. Should use `source_timestamp` as reference.
**Secondary:** No deduplication - 3 notices created for same event.
**AgentCouncil:** 2026-06-20, full report at /home/ubuntu/AgentCouncil/runs/2026-06-20-triple-incident/
**Status:** OPEN - awaiting Aviv's approval

---

## ISSUE-011 - Dismissal System: Two Bugs Causing Movie Notice Bypass + Hallucination

**Date:** 2026-06-20
**Symptom:** Aviv asked to stop movie notifications; 6+ movie notices were delivered_immediate anyway. Also: hallucinated "parents approval required" from source message "Segev probably won't go" (Michal's opinion).
**Component:** `src/triage-engine.js` L375, `src/dismissal.js`
**Root Cause:**
1. Immediates pass `null` as topicKey to `isTopicDismissed()` - topic_key dismissals never suppress immediates
2. Haiku misidentified a props/renovation dismissal as a movie dismissal - wrong scope_value stored. Aviv's actual movie dismissal was never stored.
3. Content hallucination: Haiku added normative content not present in source message
**AgentCouncil:** 2026-06-20, full report at /home/ubuntu/AgentCouncil/runs/2026-06-20-triple-incident/
**Status:** OPEN - awaiting Aviv's approval

---

## ISSUE-012 - Lipa Proactively Fired Vermox Reminder 3 Days Early

**Date:** 2026-06-20
**Symptom:** Lipa DM'd Aviv about giving Vermox to Yarden on June 20; cron job `b795d969` is scheduled for June 23 and has not fired.
**Component:** Lipa heartbeat/supervision behavior - no guardrail against duplicating scheduled cron jobs
**Root Cause:** Lipa agent reads cron list during heartbeat/supervision, sees upcoming reminder, and proactively fires it early without checking that a cron job will handle it on the correct date.
**AgentCouncil:** 2026-06-20, full report at /home/ubuntu/AgentCouncil/runs/2026-06-20-triple-incident/
**Status:** OPEN - awaiting Aviv's approval

---

## ISSUE-013 — Date Hallucination: Bot Said Tuesday = 24.6 (Actual: 23.6)

**Date:** 2026-06-21  
**Symptom:** When Aviv asked "יש לנבו משהו ביום שלישי?" from Sunday June 21, the bot responded with "Tuesday 24.6". June 24 is Wednesday; Tuesday is June 23. Wrong by 1 day.
**Component:** `src/query.js` — `buildContext()`, `src/agent.js` — event date validation
**Root Cause:** LLM (claude-sonnet-4-6) doing calendar math in its head. System prompt injected "Today is Sunday June 21" but no weekday→date map. LLM computed "next Tuesday" incorrectly.
**AgentCouncil:** 2026-06-21 — Architect R1 confirmed: "LLMs are not calculators." No OpenAI key so Expert done by Lipa.
**Fix:**
- A: Inject week map one-liner into `buildContext()`: `ימי השבוע הנוכחי: ראשון=21.6, שני=22.6...`
- B: Add `validateEventDate()` helper in agent.js — catches day/date mismatches and auto-corrects
**Status:** IN PROGRESS — subagent executing fixes A+B (2026-06-21)

---

## ISSUE-014 — End-of-Year Event Not Captured (Image + Agent Failure)

**Date:** 2026-06-21  
**Symptom:** Teacher sent "תזכורת" + image attachment in ג׳3 (Nevo's class) at 08:09. Event details (Pool Party, June 23, כפר הנופש קמא, towel+clothes) were in the image. Bot stored `[תמונה]`, no notice created.
**Component:** `src/whatsapp.js` L334 — image handling; `src/agent.js` — credit error handling
**Root Cause:**
1. Vision-on-demand pattern is circular: agent sees `[תמונה]` and can't know it contains critical info → never requests vision
2. Anthropic API credit errors (sk-ant-api03-00i...) were silently swallowed around same time — likely caused notice pipeline failures
3. One-word caption ("תזכורת") + image = classic signal that image IS the content; bot missed it
**AgentCouncil:** 2026-06-21 — Architect: "Vision-on-demand is fundamentally broken for school messages." Expert: "Multi-modal prompt pattern: text is label, image is payload."
**Fix:**
- C: Force vision OCR by default for all school groups (`isSchoolGroup()` already defined in media-parser.js)
- F: Surface Anthropic credit errors as DM to Aviv (via voice server localhost:3001)
**Status:** IN PROGRESS — subagent executing fixes C+F (2026-06-21)

---

## ISSUE-015 — Massive DB Message Duplication (11,490 duplicate rows)

**Date:** 2026-06-21  
**Symptom:** `messages` table has 12,909 rows but only 1,419 unique. 11,490 duplicates (8-10x per message average).
**Component:** `src/db.js` — `saveMessage()`; `src/whatsapp.js` — multiple save paths
**Root Cause:** `saveMessage()` called from multiple paths with no DB-level uniqueness:
1. `scanGroupHistory()` always calls `saveMessage()` unconditionally
2. Live handler saves, then calls `handleGroupMessage({ alreadySaved: true })` — but `alreadySaved` only skips ONE of the save paths
3. On reconnects, history scan replays messages the live handler already saved
4. `alreadySaved` flag is a code smell — any new code path must remember to thread it through
**AgentCouncil:** 2026-06-21 — Architect: "Add UNIQUE constraint + INSERT OR IGNORE. Remove the alreadySaved flag entirely."
**Fix:**
- D: Add `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedup ON messages(group_id, timestamp, body)` + change `saveMessage()` to `INSERT OR IGNORE`
- E: Delete 11,490 duplicate rows: `DELETE FROM messages WHERE id NOT IN (SELECT MIN(id) FROM messages GROUP BY group_id, timestamp, body)`
**Status:** IN PROGRESS — subagent executing fixes D+E (2026-06-21)

---

## ISSUE-017 — send_now Notices With null merge_group Stuck in Pending Forever

**Date:** 2026-06-24
**Symptom:** Notice #799 (ו׳2 — volunteer request for stage setup, tonight's show) classified as `send_now` but never delivered. `delivery_status` stuck at `pending`, `delivery_attempts=0`. Notices #800, #801 have the same symptom.
**Component:** `src/triage-engine.js` — `groupByMergeGroup()` (L150), `getPendingNotices()` (L86)
**Root Cause:**
1. LLM classification returns `send_now` with `merge_group: null`
2. `markNoticesTriaged()` writes `triage_decision='send_now'` to DB immediately
3. `groupByMergeGroup()` silently skips any decision where `merge_group` is null (line 150: `if (!d.merge_group || ...) continue`)
4. Result: 0 merge groups to synthesize → nothing sent
5. On next triage run: `getPendingNotices()` filters `WHERE triage_decision IS NULL` → notice is now invisible
6. **Dead letter**: triaged as urgent, never delivered, never retried. No log warning.
**AgentCouncil:** 2026-06-24 — full report at /home/ubuntu/AgentCouncil/runs/2026-06-24-issue-017
**Status:** RESOLVED — shipped 2026-06-24
**Fix shipped:**
- P0: Ajv schema validation on LLM output; `normalizeDecisions()` auto-generates `merge_group` fallback (`auto-{id}`) for send_now with null; commit order reordered (normalize+group BEFORE markNoticesTriaged); `groupByMergeGroup` now logs error instead of silent continue; notices 799/800/801 recovered and delivered
- P1: LLM prompt hardened (merge_group mandatory for send_now); dead-letter scanner cron (hourly, `src/dead-letter-scan.js`); P-007 added to PRINCIPLES.md
- Note: JSON mode (`response_format`) skipped — Anthropic API returns 'Extra inputs not permitted' for this field
**Lessons learned:** Never commit state transition before validating downstream can process it. `response_format` not supported by Anthropic API (confirmed 2026-06-24).

---

## ISSUE-018 — Bot Surfaces Messages Sent BY Aviv to Master Group

**Date:** 2026-06-24
**Symptom:** Notices 800+801 were messages Aviv himself sent in בית משפחת בסינסקי-רשפים 🏡. They were extracted as notices and forwarded to the master family group. Aviv's own messages were re-broadcast to Liat.
**Component:** `src/parser.js` or `src/whatsapp.js` — message extraction pipeline; no sender-based exclusion
**Root Cause:**
1. No filter: messages where `sender` = Aviv's phone number (+972504606660) or Liat's (+972509244401) are extracted and treated the same as teacher/school admin messages
2. The construction group (בית בסינסקי-רשפים) allows family member messages, which the bot sees and extracts
3. Triage LLM classified them as send_now (mentions schedules, dates) without knowing they were the owner's own messages
**Triggered by:** Smoke test with SHADOW=false as part of ISSUE-017 recovery (operator error — should have used shadow mode)
**Status:** RESOLVED — shipped 2026-06-24
**Fix:** Added owner-phone guard in `whatsapp.js` before `handleGroupEvent` call. If `contact.number` matches `config.AVIV_PHONE` or `config.LIAT_PHONE`, skip notice extraction entirely (message still saved to DB for context). Uses existing `config.AVIV_PHONE` / `config.LIAT_PHONE` env vars.

---

## ISSUE-009 - Migration Plan: Personal-Assistant repo → Public

**Date:** 2026-06-19
**Type:** Challenge (not a bug) - migration planning
**Status:** AgentCouncil drill in progress

**Challenge:** The Personal-Assistant WhatsApp bot is currently in a private GitHub repo. Goal is to make it open-source (public) so anyone can deploy it for their own family. The codebase is currently tightly coupled to the Besinsky family - hardcoded names, emails, phone numbers, group names, calendar IDs.

**Open ends:**
- [ ] Full audit of hardcoded values across all files
- [ ] Config schema design (.env vs config.json)
- [ ] Migration steps approved by Aviv

---

## ISSUE-016 — Images in Monitored Groups Not Read (Pre-Change-C Incident)

**Date:** 2026-06-21
**Symptom:** Liat sent an image in the master group (משימות בסינסקי) with calendar info. Lipa (OpenClaw master group session) did not read the image content — only saw the accompanying text message. Image content was missed.
**Component:** `src/whatsapp.js` — vision-on-demand not triggered for school group images (same root cause as ISSUE-014)
**Related:** ISSUE-014 fixed the same problem for Tudat's monitored school groups (Change C: force vision OCR). The master group uses a different code path — OpenClaw handles it directly, Tudat's handleMasterGroupCommand is disabled (no-op).
**Root Cause (initial):** AGENTS.md has no rule telling the master group session to analyze image attachments with the `image` tool before responding. When an image arrives, Lipa responds based on text only.
**Status:** RESOLVED — fix shipped 2026-06-21
**Fix:** Added image handling policy to AGENTS.md master group section. Silent analysis, no permission needed. Uses existing `image` tool.

---

## ISSUE-020 — One-Shot Reminder Jobs Lost on Timeout

**Date:** 2026-06-26
**Symptom:** "תזכורת חסכון ומסגר" cron job timed out and was permanently lost. deleteAfterRun removed it before delivery was confirmed.
**Component:** OpenClaw cron — one-shot reminder job lifecycle
**Root Cause:**
1. `timeoutSeconds: 30` too low — isolated session startup on this EC2 takes ~30-50s, consuming the full budget
2. `deleteAfterRun: true` removed the job on failure, with no retry or recovery
3. No supervision check caught the failure and self-healed
**Status:** RESOLVED — 2026-06-26
**Fix:**
1. **Detection:** Heartbeat Step A now checks `lastRunStatus=failed` and triggers self-heal
2. **Self-heal:** On timeout → raise `timeoutSeconds` up to 2× (max 120s) → re-trigger immediately → DM Aviv for transparency
3. **Delete only after confirmed delivery:** Removed `deleteAfterRun: true` from all active reminder jobs. Job deleted manually only after `lastDeliveryStatus=delivered` confirmed.
4. **Applied to existing jobs:** `5318620e` (קובי), `ae8d1e09` (טופס 3010) — both updated: deleteAfterRun=false, timeoutSeconds=90
5. **Standard going forward:** All new one-shot reminder jobs: no deleteAfterRun, timeoutSeconds=90 minimum
