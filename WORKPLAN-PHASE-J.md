# Phase J — Digest Correctness (rev. 2, post-council)

> **Addendum to `WORKPLAN.md` (FINAL).** Supersedes the first Phase J.
> Verified against `a18c78a`. Council feedback incorporated; three deviations noted and argued below.

---

## 0. Answers to the council's open questions

**Q: Is `created_at` epoch ms or ISO string?**
**Epoch milliseconds, consistently.** Every table declares `created_at INTEGER NOT NULL` and every write passes `Date.now()`. All comparison sites (`db.js:1138`, `db.js:1729`, `repository.js:54`, `agent.js:329`, `whatsapp.js:1544`) compare against numeric cutoffs. No mixed-type hazard. **No action needed.**

**Q: Does anything query `notice_event` without joining `notices`?**
**Yes — five call sites, and this is the most valuable thing the council surfaced.** Only `voice-server.js:838` joins. These do not:

| Call site | Consequence |
|---|---|
| `heartbeat/contextBuilder.js:49` | **Reminders fire for events whose parent is `query_visible=0` or `dismissed=1`** |
| `calendar-bridge.js:209` | Calendar enrichment reads suppressed events |
| `calendar-bridge.js:427` | Calendar time-correction scan reads suppressed events |
| `scripts/adopt-orphan-events.js:111` | Orphan adoption pulls suppressed events |
| `scripts/check-calendar-disagreements.js:51` | Disagreement check compares against suppressed events |

This **changes J3's scope materially.** Setting `query_visible = 0` on 235 image-only notices will clean the digest and leave those notices reaching reminders and the calendar untouched. `query_visible` is being treated as a global suppression flag while only one consumer honours it. See **J6**.

**Q: How many `weekday_mismatch=1` notices have future events?**
Can't query the live DB from here. Run:

```
sqlite3 data/family.db "SELECT COUNT(DISTINCT n.id) AS notices, COUNT(e.id) AS events FROM notices n JOIN notice_event e ON e.notice_id=n.id WHERE n.weekday_mismatch=1 AND e.event_date >= date('now');"
```

---

## 1. On the "no CI pipeline" risk

**This is factually wrong, and I'd rather correct it than let it reorder the work.** `.github/workflows/ci.yml` exists and runs four jobs: `detect-pii.js` over `src/` and `prompts/`, the eval dry-run, the eval gate (`run-eval.js --gold-only --limit 40`), `tests/shim/run.js`, and `tests/run-all.js`. And `tests/run-all.js:13` auto-discovers every `.js` file in `tests/regression/`, so a regression test added in a PR runs without any wiring.

The underlying instinct — *a test nobody enforces is a test nobody keeps* — is right and already satisfied. Treating CI as a blocking prerequisite would delay J1 behind work that's done.

**The real gap is narrower:** J1 changes shared retrieval behaviour that a prior incident (ISSUE-024) depends on, and **that incident has no regression test pinning it.** That's J1 step 4, and it is a genuine prerequisite — for J1 specifically, not for the phase.

---

## 2. Where I'm deviating from the council

**Accepted in full:** the `mode` parameter (J1), `matched_via: 'error'` (J1 — and it's a prerequisite, not an add-on, see below), the `is_image_origin` compromise (J3), shipping J4 in parallel (J4), inheriting the parent's correction delta (J2).

**Accepted with a constraint: `weekday_he` in the extraction schema.**

The plain version of this proposal repeats a mistake you just finished undoing. `urgency_hint` was removed from `GROUP_TOOLS` under **P-016** — *"Urgency is computed by `computeUrgencyHint()`. No other component may set it"* — precisely because an LLM field that looks authoritative alongside a deterministic function produces two sources of truth and months of tuning a value nothing reads. `date-parse.js` already exports `extractHebrewWeekday`, which reads the same source text deterministically.

**But the council identified a real gap I'd missed.** A regex over the whole notice cannot attribute a weekday to a *specific* event in a multi-event notice. Given `"שלישי 12.9 - הכתבה באנגלית, חמישי 14.9 - מבחן"`, only the model knows which weekday attaches to which event. That's genuine information the deterministic path cannot recover.

So: adopt it, **scoped and subordinate**.
- `weekday_he` goes on each element of `events[]`, never at notice level — the notice already has `extractHebrewWeekday` over its own text.
- It is **advisory input** to `nearestWeekdayIso()`, never a stored authority. The corrector decides; the field only tells it which weekday was asserted for that event.
- Where the deterministic extractor and `weekday_he` disagree, trust the deterministic one and log the divergence — that log is how you find out whether the field is worth keeping.
- Add to **P-016**: *"Event dates are computed by the date corrector. `weekday_he` is advisory extraction input and is never stored as the event's weekday."*

---

## PHASE J (revised)

### J1. Intent-gated retrieval + honest error signalling ⭐
**Goal:** a date-bounded request returns its window, empty included — and a failure never looks like an empty window.

**Why the error handling is a prerequisite, not an extra:** `NoticeRepository.findUpcoming()` catches its exception, logs, and returns `[]`. Today a locked or corrupt DB yields an empty first leg, the cascade fires, and the user gets 14 days of stale notices — visibly wrong, so someone notices. **After J1 gates the fallback off, that same failure renders a clean, confident "nothing scheduled today."** J1 makes a silent failure quieter unless the error path ships with it. Same defect class as the health endpoint reporting `whatsapp_connected: true` for 11 hours.

**Steps:**
1. Add `mode: 'question' | 'digest'` to `noticeSearch()`. `'question'` cascades to `findByContent()`; `'digest'` returns the date window as-is. Default to `'question'` so existing callers are unchanged. `generate-digest.js` passes `mode: 'digest'`.
2. Have `findUpcoming()` and `findByContent()` distinguish "no rows" from "query failed" — return a discriminated result rather than `[]`. Propagate as `matched_via: 'error'` with the error string.
3. `generate-digest.js` on `matched_via: 'error'` must **not** render "nothing scheduled". Emit an explicit failure notice to the master group and raise a health alert.
4. Replace the `voice-server.js:190` comment — it documents the current behaviour as deliberate, and future-you will believe it.
5. **Write the ISSUE-024 regression test first** (`tests/regression/2026-08-31-child-query-cascade.js`): a child-scoped question with no date window must still cascade and find notice 1678. It lands in CI automatically via `tests/run-all.js`.
**Acceptance:** digest mode on 2026-09-12 returns 0 notices, `matched_via: 'upcoming_empty'`. Question mode still finds 1678. Chmod the DB unreadable → `matched_via: 'error'`, alert fires, no "nothing scheduled" message.
**Effort:** one evening plus the regression test.

### J2. Weekday correction on events
**Goal:** the English essay lands on Tuesday, not Saturday, and not nowhere.
**Why not skip:** D1 landed — `agent.js:398` sets `relevance_date_source = 'weekday_corrected'`. So notice 2807's own date was likely corrected to Sept 15 while its `notice_event` kept the literal Sept 12, because `saveNoticeEvents()` writes `ev.date` raw. **The correction runs on the notice and not on its events.** Skipping discards a real assignment; correcting keeps it.
**Steps:**
1. Add `weekday_he` to each element of the `events[]` schema, per the constraint in §2.
2. Before `saveNoticeEvents()`, map each event date through `nearestWeekdayIso()` using `weekday_he` as advisory input, with the message timestamp as reference.
3. Where an event carries no weekday, **inherit the parent's delta**: if `relevance_date_source = 'weekday_corrected'` and the event date equals `relevance_date_raw`, shift by the same amount.
4. Add `event_date_source` and `event_date_raw` to `notice_event`, mirroring the notice columns.
5. Skip only when no correction is derivable — and log it, never drop silently.
6. Backfill future events whose parent has `weekday_mismatch = 1` (count them with the query in §0 first).
**Acceptance:** notice 2807's content yields `event_date = 2026-09-15`, `event_date_source = 'weekday_corrected'`. Regression test pins it.
**Effort:** one weekend.

### J3. Image-only notices — prompt, metadata, and guard
**Steps:**
1. Tag messages with `is_image_origin` before the LLM call, so the prompt has explicit context rather than inferring from `[תמונה:`.
2. Prompt: classroom activity photos — kids playing, sitting, Kahoot, crafts — are `no_action`. Call `add_notice` only when the image carries a date, time, deadline, form, or instruction. **Keep the LLM in the loop**; some captions do carry scheduling info.
3. Post-save guard: content matching `^\[תמונה:` with no date, time, or instruction keyword → `query_visible = 0`.
4. Backfill the 235 existing rows; verify counts before and after.
5. Eval case: a classroom photo must produce `no_action`. `add_notice` precision is already one of your weakest classes.
6. **Do not** add `query_visible` to the tool schema — it asks the model to predict downstream consumption, which it has no basis to judge. Keep it derived.
**Acceptance:** `SELECT COUNT(*) FROM notices WHERE content LIKE '[תמונה:%' AND query_visible=1` → 0. Digest shows no image-description lines.
**Effort:** one evening. **Incomplete without J6.**

### J4. Digest date discipline — ship parallel with J1
**Goal:** the digest defends itself regardless of upstream behaviour.
**Why:** `generate-digest.js:213` filters only by `surfacedNoticeIds` — **no date filter at all.** It renders whatever it's handed. J1 fixes today's cause; J4 makes the next upstream change harmless. Independent, so build them side by side.
**Steps:** filter `attentionNotices` to `relevance_date` within the requested window (or null with a recent `created_at`); log and count drops; surface a non-zero drop count in health metrics as a broken-contract signal.
**Acceptance:** hand the digest a deliberately over-wide result set; it renders only today and logs the drops.
**Effort:** one evening.

### J6. Make `query_visible` actually suppress ⭐ new, from the council's second question
**Goal:** one suppression flag that every consumer honours.
**Why:** five of six `notice_event` readers skip the join to `notices`, so `query_visible` and `dismissed` are ignored by the reminder path, both calendar paths, and two scripts. J3 without this cleans the digest and leaves reminders firing for image-only notices.
**Steps:**
1. Add a single `getVisibleNoticeEvents({ from, to, noticeId })` helper in `db.js` that always joins `notices` and filters `query_visible = 1 AND dismissed = 0`.
2. Replace all five direct readers with it. `contextBuilder.js:49` first — that one drives reminders.
3. Add **P-020:** *"`notice_event` is never queried without joining `notices` for visibility. Use `getVisibleNoticeEvents()`."* Add the grep to `check-principles.js`: no `FROM notice_event` outside `db.js`.
4. Decide deliberately whether calendar paths should honour `dismissed` — a dismissed notice whose event is already on the calendar may warrant leaving the event alone rather than deleting it. Document whichever you choose.
**Acceptance:** `grep -rn "FROM notice_event" --include=*.js src/ scripts/ | grep -v "src/db.js"` returns nothing. An image-only notice with `query_visible=0` produces no reminder.
**Effort:** one evening. **Do with or immediately after J3.**

### J5. Fix the hardcoded `+03:00`
`db.js:1218` and `:1223` build `expires_at` with a literal `+03:00`. Israel is UTC+2 in winter, so from late October every event expires an hour early. Fold into task **C1** (single date utility).
**Effort:** 20 minutes once C1 lands.

---

## Order

| When | Task |
|---|---|
| **Today** | J1 step 5 (ISSUE-024 regression test) — prerequisite |
| **This week** | J1 and J4 in parallel; then J3 + J6 together |
| **Next** | J2, then J5 with C1 |

---

## Principles to record

- **P-019** — A fallback is conditioned on the caller's declared intent, not on the first attempt returning empty. An empty result is a valid answer to a bounded question.
- **P-020** — `notice_event` is never queried without joining `notices` for visibility.
- **P-016 (extend)** — Event dates are computed by the date corrector. `weekday_he` is advisory extraction input and is never stored as the event's weekday.

And the process note that produced this phase: J1 exists because A2 generalised a fix past its evidence — validated against one caller, then made unconditional for all. When a fix changes shared retrieval behaviour, the incident that motivated it needs a regression test **in the same PR**.

## Verification

```
sqlite3 data/family.db "SELECT COUNT(DISTINCT n.id), COUNT(e.id) FROM notices n JOIN notice_event e ON e.notice_id=n.id WHERE n.weekday_mismatch=1 AND e.event_date >= date('now');"
curl -s 'localhost:3001/api/context?from=2026-09-12&to=2026-09-12&mode=digest' | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['matched_via'], len(d['notices']))"
curl -s 'localhost:3001/api/context?query=כדורגל&days=14' | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['matched_via'], len(d['notices']))"
grep -rn "FROM notice_event" --include=*.js src/ scripts/ | grep -v "src/db.js"
sqlite3 data/family.db "SELECT COUNT(*) FROM notices WHERE content LIKE '[תמונה:%' AND query_visible=1;"
grep -n "relevance_date" scripts/generate-digest.js
grep -n "+03:00" src/db.js
node tests/run-all.js
```
