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

## Adding New Principles

When a production incident, architect consultation, or expert review concludes with a design rule:
1. Add an entry here with a P-XXX number
2. State: principle, source incident, rule, verification method
3. Add a corresponding test in `tests/check-principles.js`
4. Reference it in commit message and ISSUES.md if incident-driven
