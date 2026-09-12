# Phase K — Delivery Liveness (2026-09-12 pipeline outage)

> **Addendum to `WORKPLAN.md` (FINAL).** Verified against `92247cf`.
> The fixes in `92247cf` are correct and the diagnosis is sound. This phase closes the monitoring gap that let the outage run for ten days, plus two defects in the fix itself.

---

## 1. What the incident actually proves

228 notices sat undelivered from Sept 2 to Sept 12. `runTriage()` had not run since **Aug 14**. Every health check passed the entire time.

The report's "why no alerts fired" section is right and understates it. I checked `health-throughput.js`: **there is no delivery check at all.** Its only `pending` reference is `pending_group_questions` — config state, not notices. Every A4 check is input-side:

| Existing check | Watches |
|---|---|
| Ingestion volume | messages in |
| Terminal-state rate | messages processed |
| Media parse rate | messages parsed |
| Duplicate canary | sent messages, for duplicates |
| Config integrity | group config |
| Monitored-group silence | messages in, per group |

Not one asks whether notices are going **out**. The system could extract perfectly and deliver nothing, forever, and report healthy — which is precisely what it did.

And the root cause of Bug 1 is invisible to error-based monitoring by construction. A cron job that was **never created** throws no errors. It produces nothing, and nothing is exactly what a passing check looks like. `runImmediate()` returning "Nothing urgent" and `runDigest()` returning "No deferred notices" were both *true* and both *success*.

**Seventh instance of the recurring pattern, in a new form:** previously the defect was a capability that existed and wasn't called. Here it's a capability that was never scheduled — and the difference is undetectable from inside the process.

---

## 2. Two defects in the applied fix

### 2a. `computeDeadline` reintroduces the bug J5 just removed

`triage-engine.js:281`:

```javascript
const relDateMs = new Date(`${notice.relevance_date}T00:00:00Z`).getTime();
```

Hardcoded UTC, one commit after `f3b7dc2` removed a hardcoded `+03:00` from `saveNoticeEvents`. Israel midnight is 21:00 UTC the previous day, so this threshold sits **3 hours late** (2 in winter).

Consequence: a notice for an event legitimately at 00:30 Israel time on the relevance date has `relevant_datetime` = 21:30 UTC the prior day. That is `< relDateMs`, so the sanity check fires on a **correctly set** datetime, discards it, and silently falls through to end-of-day. The notice still gets delivered, but with the wrong deadline — so an early-morning event is treated as having all day.

**Fix:** use the `timeUtils` helpers from task **C1** (`israelDateIso` / an `israelStartOfDayMs`). Never construct a date boundary from a literal offset — that's the third occurrence of this exact mistake in the codebase.

### 2b. Bug 2 was fixed at the consumer, not the producer

The LLM still writes `relevant_datetime` = message posting time. `computeDeadline` now defends itself, but **every other reader of that field does not**: `contextBuilder.js` (reminders), `calendar-bridge.js`, `/api/context`, and `computeUrgencyHint`'s 3-hour window all still read the bad value.

This is the pattern from ISSUE-025 and ISSUE-026 again — patch the consumer, leave the bad data for the next consumer to rediscover. The producer fix is the same shape as J2: validate at write time.

---

## PHASE K

### K1. Job heartbeats ⭐ highest value, closes Bug 1's class
**Goal:** a job that never runs is louder than a job that errors.
**Why:** `grep -rn "job_runs\|last_run" src/db.js` returns nothing. There is no record of when any scheduled job last succeeded. `runTriage` was absent for 29 days and the only way to discover it was a human noticing missing messages.
**Steps:**
1. Add a `job_runs` table: `job_name TEXT PRIMARY KEY, last_success_ms INTEGER, last_result TEXT, consecutive_empty INTEGER`.
2. Every scheduled entry point — `runTriage`, `runImmediate`, `runDigest`, the digest generator, both backup scripts, the reconciliation and disagreement checks — writes a heartbeat on completion, recording whether it did work or found nothing.
3. Add a health check: for each registered job, alert when `now - last_success_ms` exceeds its expected interval times a tolerance factor. **Absence of a heartbeat is the alert.** This is the dead-man's-switch pattern; it catches the "job was never scheduled" case that error-based monitoring cannot see.
4. Track `consecutive_empty`. A job succeeding with "nothing to do" 96 times in a row is a signal, not health. Alert at a threshold tuned per job.
5. Add **P-021:** *"Every scheduled job writes a heartbeat on success. Absence of a heartbeat is an alert. 'Nothing to do' is not the same as 'ran successfully'."*
**Acceptance:** disable the `runTriage` cron in a test environment; an alert fires within one expected interval plus tolerance. Leave `runDigest` scheduled with an empty queue for a day; the `consecutive_empty` alert fires.
**Effort:** one weekend. **Do first.**

### K2. Delivery throughput checks
**Goal:** notice the backlog without a human reading the master group.
**Steps:** add to `health-throughput.js`:
1. **Stale pending** — count `notices` with `delivery_status='pending'` and `created_at` older than 2 hours during daytime. Alert above a small threshold; include the oldest notice's age and ID.
2. **Created-vs-delivered ratio** — over a rolling 24h, compare notices created against notices reaching a terminal delivery state. A ratio near zero with non-zero creation is the exact signature of this outage.
3. **Untriaged age** — oldest notice with `triage_decision IS NULL`. This is the single number that would have caught Bug 1 on Sept 2; it would have read "10 days" by the end.
4. Surface all three in `/health` and `health-metrics.jsonl`.
**Acceptance:** insert 20 pending notices dated 3 hours ago; all three checks fire. Clear them; checks pass.
**Effort:** one evening. **Cheapest task here — do it alongside K1.**

### K3. A cron manifest in version control ⚠️
**Goal:** the B1 refactor's failure mode becomes impossible.
**Why:** cron jobs live in OpenClaw, outside the repo. There is no version-controlled statement of what *should* be running. The B1 refactor consolidated delivery into `triage-engine.js`, created crons for `deliver-immediate` and `deliver-batch`, and missed `runTriage` — and nothing could detect the omission, because nothing declares the expected set. `infra/` contains only `watchdog.sh`.
**Steps:**
1. `infra/jobs.json` — the authoritative list: job name, schedule, command, expected interval, owner. This is also K1's registry.
2. `scripts/verify-cron.js` compares the manifest against what's actually scheduled and reports drift in both directions — missing jobs and orphan jobs.
3. Run it at startup and on a daily schedule; alert on drift.
4. Add to the runbook: any change to the delivery topology updates `infra/jobs.json` in the same PR.
**Acceptance:** delete a cron entry; `verify-cron.js` reports it missing. Add an unlisted one; it reports an orphan.
**Effort:** one weekend. **Depends:** K1 for the registry shape.

### K4. Fix `relevant_datetime` at the producer
**Goal:** stop storing a value five consumers must each learn to distrust.
**Steps:**
1. At extraction in `agent.js`, if `relevant_datetime` falls before the start of `relevance_date` in Israel time, discard it, log the discard, and record `relevant_datetime_source: 'discarded_posting_time'`.
2. Prompt fix: state explicitly that `relevant_datetime` is the **event's** time, never the message's. This is the same failure the urgency work hit — the model defaults to what it can see most easily.
3. Backfill: null out `relevant_datetime` on notices where it precedes `relevance_date`. Count them first:
   ```
   sqlite3 data/family.db "SELECT COUNT(*) FROM notices WHERE relevant_datetime IS NOT NULL AND relevance_date IS NOT NULL AND relevant_datetime < strftime('%s', relevance_date || ' 00:00:00')*1000;"
   ```
4. Keep `computeDeadline`'s sanity check as belt-and-braces — but once K4 lands it should stop firing. Log when it does; a non-zero rate means the producer fix regressed.
**Acceptance:** a notice whose message timestamp precedes its event date stores `relevant_datetime = NULL`. The `computeDeadline` fallback logs zero hits over a week.
**Effort:** one weekend.

### K5. Fix the UTC boundary in `computeDeadline`
Replace `new Date(\`${notice.relevance_date}T00:00:00Z\`)` at `triage-engine.js:281` with the Israel start-of-day helper from **C1**. Audit for other literal `Z` and `+03:00` boundaries in the same pass — this is the third occurrence of the same mistake.
**Acceptance:** `grep -rn "T00:00:00Z\|+03:00" --include=*.js src/` returns nothing outside `timeUtils.js`. A DST-boundary fixture covers an event at 00:30 Israel time.
**Effort:** 30 minutes once C1 lands. **Bundle with K4.**

### K6. Make the backlog cleanup repeatable
**Goal:** the manual recovery becomes a script.
**Why:** the fix required marking 225 notices `dead_letter` and correcting 66 rows where `posted_to_master=0` despite delivery — the latter were clogging the queue against the `LIMIT 50`. Both were done by hand. The `LIMIT 50` interacting with stuck rows is a live starvation risk: enough bad rows at the head of the queue and good notices never get read.
**Steps:**
1. `scripts/reconcile-delivery-state.js` — find notices delivered per `sent_messages` but still `posted_to_master=0`, and pending notices past their deadline. Report by default, `--apply` to fix.
2. Run it nightly in report mode; alert when it finds anything, since a non-zero count means the pipeline is leaking state.
3. Change the queue read to order by age and skip rows already in a terminal state, so a poisoned head can't starve the queue regardless.
**Acceptance:** seed 60 stuck rows plus 5 good ones; the good ones still get triaged. The script reports and fixes the 60.
**Effort:** one evening.

---

## Order

| When | Task |
|---|---|
| **This week** | K2 (one evening, catches the whole class), then K1 |
| **Next** | K3, K6 |
| **With C1** | K4 + K5 together |

K2 is first because it's the cheapest and would have caught this specific outage on day one. K1 is the general fix and covers the next scheduling gap too.

---

## Principle

**P-021 — Every scheduled job writes a heartbeat on success. Absence of a heartbeat is an alert. "Nothing to do" is not the same as "ran successfully."**

The through-line across this incident and the Sept 9 outage: **the system monitors its inputs and its errors, and not its outputs.** Ingestion stalling alerts. Messages failing alerts. Notices never being delivered does not, because nothing was broken — the work simply never happened. Health checks that only watch for failure cannot see absence.

## Verification

```
sqlite3 data/family.db "SELECT COUNT(*), MIN(created_at) FROM notices WHERE delivery_status='pending';"
sqlite3 data/family.db "SELECT COUNT(*) FROM notices WHERE triage_decision IS NULL AND created_at < (strftime('%s','now','-2 hours')*1000);"
sqlite3 data/family.db "SELECT COUNT(*) FROM notices WHERE relevant_datetime IS NOT NULL AND relevance_date IS NOT NULL AND relevant_datetime < strftime('%s', relevance_date || ' 00:00:00')*1000;"
sqlite3 data/family.db "SELECT job_name, datetime(last_success_ms/1000,'unixepoch'), consecutive_empty FROM job_runs ORDER BY last_success_ms;"
node scripts/verify-cron.js
node scripts/reconcile-delivery-state.js
grep -rn "T00:00:00Z\|+03:00" --include=*.js src/ | grep -v timeUtils
curl -s localhost:3001/health | python3 -c "import json,sys;d=json.load(sys.stdin);print({k:v for k,v in d.items() if 'deliver' in k or 'pending' in k or 'job' in k})"
```
