# ISSUE-2026-09-08 — Calendar Time Correction: Phase H

> **Addendum to `WORKPLAN.md` (FINAL).** Verified against `ed8239f` (2026-09-08).
> Everything else in `WORKPLAN.md` stands. This adds Phase H.

---

## 1. First, the framing correction

**This is not a new incident. It is the ISSUE-025 event, rediscovered four days later.**

The report gives the creation time as **Sep 4 07:20 UTC**. That is the same fabricated 18:30 event from the ISSUE-025 report of 2026-09-04 — the one where Lipa searched, found no time, and told Aviv *"שמתי 18:30 כי זו השעה הסטנדרטית של אסיפות ההורים ברימון."* Same event ID, same origin, same fabrication.

So the interesting question is not "why did Lipa fabricate a time" — that was diagnosed on Sep 4 and the fix has since shipped. The interesting question is:

**Why did four days pass, with three separate messages in the group stating 18:00, and the system never corrected itself or flagged the discrepancy?**

That reframes the priorities. Bug 1 is largely closed. Bug 2 is the real finding, and it is worse than the report describes.

## 2. What has already shipped

| Report's fix | Status |
|---|---|
| R3 — agent-created events must go through calendarGate | ◐ `voice-server.js:612` now calls `validateCalendarWrite` before an agent calendar write. **The endpoint exists; the bypasses do not yet block.** |
| R4 — prevent time hallucination | ✅ `validateCalendarWrite` rejects any `time` not grounded in the source notice. Against notice 1839 (no time), 18:30 would now be blocked and logged. |
| All-day events when time unknown | ✅ `calendar-bridge.js:93` titles them `— שעה טרם פורסמה`, `time_status: 'unknown'` |
| Missing-time prompt | ✅ `proactive.js:171` |

The report's claim that calendarGate *"already has logic to drop inferred times (`timeSource === 'inferred'`)"* is **correct** — `calendarGate.js:160–168`. Good catch.

## 3. The two real gaps

### Gap A — the endpoint is not a boundary

`validateCalendarWrite` is reachable from `voice-server.js:612`, but nothing prevents OpenClaw from doing what the report says it did: calling `gog cal` directly, or requiring `src/calendar.js` and calling `addSharedEvent()` with Aviv's OAuth token. Both paths sit on the same box with the same credentials.

**An endpoint is only a boundary if the alternatives are removed.** This is the same lesson as P-013 (agents write to SQLite only through sanctioned functions) — which was written, and which calendar writes were never brought under.

### Gap B — the correction loop exists and structurally cannot see agent-created events ⭐

This is the finding. The machinery is all built:

- `calendar.js:599` — `events.patch`, a working update path
- `proactive.js:220` — `resolveMissingTime()` patches the calendar when a time later arrives
- `calendar-bridge.js:106` — `time_status: 'known' | 'unknown'` recorded on every intent

And `calendar-bridge.js:91` carries this comment, written by whoever built it:

> `// record time_status so a later update can fill it in.`

But `proactive.js:210` gates the patch:

```javascript
// Best-effort calendar patch: only if a calendar event was already created.
if (notice.calendar_event_id && notice.relevance_date) {
```

Notice 1839 has `calendar_status = 'n/a'`, `calendar_attempts = 0`, and **`calendar_event_id` NULL** — because the pipeline never created this event; Lipa did, outside it. So `resolveMissingTime()` has nothing to patch, and never will.

**Every event an agent creates outside the pipeline is permanently orphaned from every correction mechanism the system has.** Not "there is no feedback loop" — there is one, and it is blind to exactly the events most likely to be wrong.

There is a second blocker behind it. Even for a pipeline-created event, `calendar-bridge.js:171` returns `already_applied` and does nothing when a later notice matches an existing fingerprint. So notice 2252 (Sep 3, 18:00) and notice 2724 (Sep 8, 18:00) would have been skipped as duplicates regardless.

### Gap C — `notice_event` rows never reach the calendar

`grep -c notice_event src/calendar-bridge.js` → **0**. The two rows carrying the correct time — #99 (Sep 3, 18:00) and #121 (Sep 8, 18:00) — are invisible to the calendar path. This is the same `notice_event` gap already open as task **B1** in `WORKPLAN.md`, surfacing in a second consumer.

**Seventh instance of the recurring pattern:** `updateCalendarEvent`, `time_status`, `resolveMissingTime`, and `notice_event` all exist and all work. The wiring between them doesn't.

---

## PHASE H

### H1. Close the calendar write bypasses ⭐ do first
**Goal:** make `validateCalendarWrite` unavoidable rather than merely available.
**Steps:**
1. Remove OpenClaw's ability to write the calendar directly: revoke or scope the `gog` keyring credential available to agent sessions, and remove `gog cal` from OpenClaw's allowed tool list. If `gog` is needed for reads, keep read scopes only.
2. Make `addSharedEvent()` and `updateCalendarEvent()` refuse a call that carries no `source_notice_id`. Route the two legitimate internal callers (`calendarGate.js:357`, `whatsapp.js:207`) through the same argument.
3. Extend **P-015** to name the mechanism, not just the rule: *"Calendar writes occur only via `calendarGate` or `POST /api/calendar/propose`. No agent holds direct calendar credentials."*
4. Add the grep to `check-principles.js`: no file outside `calendar.js`, `calendarGate.js` and `voice-server.js` may import `addSharedEvent`.
**Acceptance:** an OpenClaw session attempting a direct calendar write fails with a logged reason. `grep -rn "addSharedEvent" --include=*.js src/` shows only the three sanctioned files. Replay ISSUE-025 — the 18:30 write is blocked and appears in `logBlocked`.
**Effort:** one weekend.

### H2. Adopt orphaned calendar events into the pipeline
**Goal:** make the correction loop able to see events it didn't create — including everything already on the calendar.
**Steps:**
1. Reconciliation job: for each future calendar event with no `calendar_intents` row, compute the `calendar-bridge` fingerprint from its title and date and try to match a notice. On match, write `notices.calendar_event_id` and a `calendar_intents` row with `status='adopted'`, `time_status` derived from the notice.
2. Run it on a schedule and once as a backfill over existing future events.
3. Where no notice matches, log to a `orphan_calendar_events` table rather than guessing — that list is itself a signal about what's being created outside the pipeline.
**Acceptance:** the parents-meeting event is adopted and linked to notice 1839; `resolveMissingTime()` can now reach it. The backfill report lists every adopted and every orphaned event.
**Effort:** one weekend. **Unblocks H3.**

### H3. Correct the time when a later message supplies it
**Goal:** the case this incident is actually about.
**Steps:**
1. In `calendar-bridge`, replace the bare `already_applied` early-return with a comparison: if the existing intent has `time_status='unknown'` (or a time differing from the new notice's) and the new notice has an explicit, source-grounded time, patch the event via `updateCalendarEvent`, set `time_status='known'`, and record both the old and new value on the intent.
2. Feed `notice_event` rows into this path, not only notice-level `relevance_time` — that is what makes #99 and #121 usable. Reuse the query shape from `heartbeat/contextBuilder.js`; do not write a new one.
3. Every patch must pass `validateCalendarWrite` against the notice supplying the new time. A correction is a calendar write like any other.
4. Notify on change: *"עדכנתי — אסיפת הורים כיתה ד׳ 9.9 מ-18:30 ל-18:00 (לפי הודעה מהקבוצה)."* Render it through `guardedSend`, citing the source notice.
**Acceptance:** regression test — create an all-day/inferred-time event from notice 1839, then feed notices 2252 and 2724; the event ends at 18:00, exactly one notification is sent, and a second identical notice produces no further message.
**Effort:** one weekend. **Depends:** H2.

### H4. Detect disagreement between calendar and source
**Goal:** catch the next one within a day instead of four.
**Steps:** nightly job comparing every future calendar event against its linked notice and `notice_event` rows. Any mismatch in date, time or location → alert with both values and the notice ID. Include events adopted in H2. Add the count to the existing health metrics.
**Acceptance:** manually skew an event's time by 30 minutes → next run alerts naming both values.
**Effort:** one evening. **Depends:** H2. **This is the task that would have caught this incident on Sep 5.**

### H5. Extend the grounding log to time provenance
`validateCalendarWrite` blocks ungrounded writes at the boundary. Add `time_source: 'explicit' | 'notice_event' | 'corrected' | 'absent'` to `calendar_intents`, so any event whose time never had an explicit source is queryable. Cross-check against the `grounding_misses` table from E3.
**Acceptance:** `SELECT * FROM calendar_intents WHERE time_source='absent' AND start_date >= date('now')` returns the current backlog of unsourced times.
**Effort:** one evening.

---

## Order

| When | Task |
|---|---|
| **Today** | Confirm the immediate fix held: `gog cal show fpgrvvc9s4haqhs7p35en9mneo` — the report says it's corrected to 18:00 |
| **This week** | H1, then H2 |
| **Next** | H3, H4 |
| **Then** | H5 |

H1 and H2 are independent and can be done in either order, but H1 stops the bleeding and H2 unblocks everything else.

Against `WORKPLAN.md`, slot H1 immediately after B1, and treat H2–H4 as the natural continuation of E1. Task **B1** (exposing `notice_event` through the retrieval layer) and Gap C here are the same underlying gap in two consumers — doing B1 first makes H3 step 2 mostly a matter of calling it.

---

## What not to build

- **Do not have the agent re-check its own past calendar writes.** That is a correction loop owned by the component that made the error. H2 plus H4 puts the check in the pipeline, where the source data lives.
- **Do not infer a time from similar prior events, ever, even as a fallback.** That is precisely what produced 18:30 — inherited from the Aug 30 כיתה א meeting, a different class. An all-day event with `— שעה טרם פורסמה` is a correct answer; a plausible guess is not.

---

## Verification

```
grep -rn "addSharedEvent" --include=*.js src/ | grep -v "calendar.js\|calendarGate.js\|voice-server.js"
grep -c notice_event src/calendar-bridge.js
sqlite3 data/family.db "SELECT id, calendar_event_id, calendar_status FROM notices WHERE id IN (1839,2252,2724);"
sqlite3 data/family.db "SELECT id, fingerprint, status, time_status, calendar_event_id FROM calendar_intents WHERE start_date >= date('now');"
sqlite3 data/family.db "SELECT * FROM orphan_calendar_events;"
node tests/regression/2026-09-08-calendar-time-correction.js
```
