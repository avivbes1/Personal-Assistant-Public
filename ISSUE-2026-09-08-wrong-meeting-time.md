# ISSUE-2026-09-08: Calendar event has wrong time (18:30 vs 18:00)

## Summary
The calendar event "אסיפת הורים - נבו (כיתה ד׳)" on Sep 9 shows **18:30** while the WhatsApp group clearly states **18:00** in three separate messages.

## Evidence

### WhatsApp group messages (ג׳3 / כיתה ד׳3 — group `120363168238198071@g.us`)

| Date | Sender | What it says about the meeting | Time stated |
|---|---|---|---|
| Sep 1 12:30 UTC | נעמי | "מועד חלופי לאסיפת ההורים שתתקיים ב9.9 יום ד'" | **NO TIME** |
| Sep 3 13:46 UTC | נעמי | Image (OCR'd): schedule table mentioning אסיפת הורים | **18:00** (via notice_event #99) |
| Sep 8 14:23 UTC | נעמי | "מחר ב18:00 אסיפת הורים" | **18:00** |

### Notice pipeline (correctly extracted)

| notice_event ID | notice ID | date | time | title | created |
|---|---|---|---|---|---|
| 92 | 1839 | 2026-09-09 | *(none)* | אסיפת הורים | Sep 1 12:30 |
| 99 | 2252 | 2026-09-09 | **18:00** | אסיפת הורים כיתה ד׳3 | Sep 3 13:46 |
| 121 | 2724 | 2026-09-09 | **18:00** | אסיפת הורים | Sep 8 14:23 |

All three correctly have 18:00 or no time. The notice pipeline is **not** the source of the bug.

### Calendar event (wrong)

```json
{
  "id": "fpgrvvc9s4haqhs7p35en9mneo",
  "summary": "אסיפת הורים - נבו (כיתה ד׳)",
  "start": "2026-09-09T18:30:00+03:00",
  "created": "2026-09-04T07:20:27.000Z",
  "creator": { "email": "avivbes1@gmail.com", "self": true },
  "location": "בית ספר רימון"
}
```

## Root cause analysis

### What DID NOT create this event
1. **calendar-bridge.js** — No entry in `calendar_intents` table for this event on Sep 9. Notices 1839, 2252, 2724 all have `calendar_status = 'n/a'` and `calendar_attempts = 0`.
2. **calendarGate.js** — No log entry for creating "אסיפת הורים" on Sep 9. The only CalendarGate creation log for "אסיפת הורים" is for the **Aug 30** event at 18:30 (different event, כיתה א).
3. **Bot pipeline** — No `sent_messages` entry around the creation time (Sep 4 07:20 UTC).

### What DID create this event
The event was created **outside the bot pipeline** — most likely by Lipa (the OpenClaw agent) in a session, using the `gog cal` CLI or `addSharedEvent()` API with Aviv's OAuth token. There are no bot logs, no calendar_intents, and no CalendarGate traces.

### Why the time is wrong
The event was created on **Sep 4** based on notice 1839 (Sep 1), which announced the parents meeting on Sep 9 but **did NOT specify a time**. The 18:30 time was almost certainly **hallucinated** — inherited from the prior "אסיפת הורים" on Aug 30, which was for a **different class (כיתה א)** at 18:30.

The correct time (18:00) was only stated in:
- The image OCR'd on Sep 3 (notice 2252) — AFTER the event was created Sep 4... wait, notice 2252 was created Sep 3 (before Sep 4). But the time extraction into `notice_event` may not have been connected to the calendar event creation path.
- The explicit message on Sep 8 — 4 days after the event was created.

**Timeline:**
1. Sep 1: Teacher says "parents meeting on Sep 9" — no time
2. Sep 3: Image shared in group with schedule showing 18:00
3. **Sep 4 07:20 UTC: Calendar event created at 18:30** ← wrong time, likely copied from Aug 30 event
4. Sep 8: Teacher explicitly says "מחר ב18:00 אסיפת הורים"
5. No update was ever made to correct the time

## The two bugs

### Bug 1: Calendar event created with fabricated time
When the agent (Lipa) created a calendar event for an event with **no explicit time**, it fabricated 18:30 instead of either:
- Creating an all-day event (correct behavior when time is unknown)
- Asking the user for the time
- Waiting until the time was explicitly stated

This violates the system's own Negative-Result Discipline: "Never substitute a standard, usual, or typical value for a family-specific event."

### Bug 2: No time-correction feedback loop
When subsequent messages in the same group explicitly stated the time (18:00), the system had **no mechanism** to:
1. Detect that an existing calendar event for the same event has a different time
2. Automatically update the calendar event
3. Alert the user about the discrepancy

The notice pipeline correctly extracted 18:00 (notice_events #99, #121), but this information was never connected back to the existing calendar event `fpgrvvc9s4haqhs7p35en9mneo`.

## Immediate fix needed
```bash
# Correct the calendar event time from 18:30 → 18:00
GOG_KEYRING_PASSWORD=besinsky-gog-keyring gog cal update fpgrvvc9s4haqhs7p35en9mneo \
  --start "2026-09-09T18:00:00+03:00" \
  --end "2026-09-09T19:00:00+03:00" \
  -a avivbes1@gmail.com
```

## Systemic fixes needed

### R1: Calendar-bridge should handle notice_events with times
Currently, the calendar-bridge only processes notices via `calendar_intents`. Notice_events (the per-day event rows) with explicit times are **never** used to create or update calendar events. When a notice_event has `event_time = '18:00'` and maps to an event type (meeting, class, etc.), it should:
1. Check if a matching calendar event already exists
2. If yes and time differs → update the time
3. If no → create a new calendar event

### R2: Time-correction feedback loop
When a new message in a monitored group mentions an event that already has a calendar entry but with a different time, the system should detect the discrepancy and either auto-correct or ask the user.

### R3: Agent-created events must go through calendarGate
Events created by the OpenClaw agent (Lipa) in sessions bypass calendarGate entirely — no validation, no dedup, no time-source checking. All calendar writes should route through calendarGate's 4-stage flow, which already has logic to drop inferred times (`timeSource === 'inferred'`).

### R4: Prevent time hallucination in agent sessions
When the agent creates a calendar event from a notice with no explicit time, it should:
- Create as all-day event, OR
- Ask the user, OR  
- Wait for the time to be stated explicitly
Never fabricate a time from a "similar" prior event.
