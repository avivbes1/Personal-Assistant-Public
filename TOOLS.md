# TOOLS.md — HTTP tools exposed to OpenClaw / Lipa

`src/voice-server.js` serves these on `http://localhost:3001`. They are the
grounded interface OpenClaw (Lipa) uses to read family context and to gate
calendar writes. All requests and responses are JSON.

---

## POST `/api/calendar/validate` — source-grounding gate for calendar writes

Call this **before** creating a calendar event. It enforces P-015 / G1: every
field a calendar event proposes (`date`, `time`, `location`, and `summary`) must
appear in the source notice, or the write is a fabrication and must be blocked.
`date`/`time`/`location` are checked by the canonical `validateCalendarWrite`
(dates matched in any plausible Hebrew form); `summary`/`title` is additionally
checked as a case-insensitive substring of the notice content.

**Request body**

```json
{
  "event_data": { "summary": "אסיפת הורים", "date": "2026-09-09", "time": "19:00", "location": "בית הספר" },
  "source_notice_id": 2442
}
```

- `event_data` — the proposed event. Recognized fields: `summary` (or `title`),
  `date` (`YYYY-MM-DD`), `time` (`HH:MM`), `location`. Missing fields are not checked.
- `source_notice_id` — **required.** The notice this event is grounded in.

**Response**

```json
{ "valid": true,  "source_notice": { "id": 2442, "content_preview": "…" }, "blocked_fields": [], "reason": null }
{ "valid": false, "source_notice": { "id": 2442, "content_preview": "…" }, "blocked_fields": ["time"], "reason": "…proposes field(s) absent from the source: time" }
```

- `valid` — `true` only if every proposed field is grounded in the notice.
- `source_notice` — `{ id, content_preview }` (first 200 chars) of the notice validated against.
- `blocked_fields` — the proposed fields absent from the source (the reason for rejection).
- `reason` — human-readable rejection reason, or `null` when valid.

**Errors**

- No `source_notice_id` → `400` with `{ "valid": false, "reason": "source_notice_id required" }`.
- Unknown notice id → `404` with `{ "valid": false, "reason": "notice not found" }`.

**Example**

```bash
curl -s -X POST localhost:3001/api/calendar/validate \
  -H 'Content-Type: application/json' \
  -d '{"event_data":{"summary":"test"},"source_notice_id":2442}'
# → {"valid":false,"blocked_fields":["summary"],...}   ("test" not found in the notice text)
```

Backed by `validateCalendarWrite()` in `src/validation/sourceValidator.js` — the
same guard `calendarGate.processEventAction` applies to in-process writes.

---

## GET `/api/context?from=&to=&child=` — unified family view

Single endpoint to ground any schedule answer over a date window
(`from`/`to` are `YYYY-MM-DD`, required; `child` optional). Returns:

- `notices` — matched notices (includes `weekday_mismatch` and `validation_notes`
  so day/date warnings surface).
- `calendar_events` — both parents' events (+ Liat work), deduped by id, each with `owners`.
- `notice_events` — dated rows extracted from notices in the window.
- `homework` — pending homework due within the window.
- `matched_via` — `"upcoming"` or `"content_fallback"`.

Consumed by `scripts/generate-digest.js` to build the morning digest.

---

## Other endpoints (reference)

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET  | `/health`                    | Liveness + component status payload |
| GET  | `/health-probe`              | Active round-trip WhatsApp probe |
| GET  | `/api/notices/search?q=&child=&days=` | Notice search cascade |
| GET  | `/api/notices/upcoming?from=&to=&child=` | Date-bounded upcoming notices |
| GET  | `/api/notices/lookup?query=&child=&from=&to=` | Combined lookup |
| GET  | `/api/integrity/enums`       | Enum-integrity check (nightly cron) |
| POST | `/api/groups/monitoring`     | Toggle group monitoring / metadata |
| POST | `/send-message`              | Send a WhatsApp message (`{ to, text }`) |
