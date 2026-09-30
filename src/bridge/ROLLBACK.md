# Instinct Bridge — Rollback Procedure

This document describes how to safely pause the bridge, reconcile in-flight
outbox rows, and revert to a previous (pre-reliability-patch) version of the
bridge code without losing or double-sending events.

> **Read the compatibility warning first.** The reliability patch introduced two
> new outbox statuses — `retry` and `needs_review` — and a new `claim_generation`
> column, plus a `bridge_outbox_attempts` table. **Old code does not recognise
> `retry` or `needs_review`.** If you revert the code while rows are sitting in
> those states, the old exporter will simply never claim them (its `claimBatch`
> only selects `status = 'pending'`), so they will be stranded — not lost, but
> silently undelivered. You must drain/normalise those rows *before* reverting.

---

## 0. Preconditions

- One bridge worker only (single Node process). Confirm no second `pm2` instance
  is running: `pm2 list | grep familybot`.
- Have the target (old) revision SHA ready.
- Know the DB path: `FAMILYBOT_DB_PATH` if set, else `data/family.db`
  (symlinked to `data/familybot.db`).

---

## 1. Pause the bridge (stop new sends)

Trip the billing circuit breaker — it is the fastest global send-kill and needs
no redeploy. Either:

```bash
# Option A: manual state file (bridge/billingState.js reads this on every send)
cat > data/bridge-state.json <<'JSON'
{ "billing_paused": true, "paused_at": "<ISO timestamp>", "error": "manual rollback pause" }
JSON
```

or, cleaner, disable the bridge entirely and restart:

```bash
# Option B: flip the on-switch off
export INSTINCT_BRIDGE_ENABLED=0     # in the process env / .env
pm2 restart familybot --update-env
```

Either way, verify no further sends occur: watch the log for
`export cycle SKIPPED` (billing pause) or the absence of `[Bridge][Gmail] sent`.

---

## 2. Let claimed rows settle

A `claimed` row is one an in-flight cycle is mid-send on. Since a cycle is a
single synchronous unit of work (no long-running loop), wait ~2 minutes (a
couple of scheduler ticks) for any active cycle to finish. Then confirm nothing
is stuck mid-claim:

```sql
SELECT status, COUNT(*) FROM bridge_outbox GROUP BY status;
```

If rows remain `claimed` after the wait, the process died mid-cycle. Because
delivery is at-least-once and fenced by `claim_generation`, it is safe to reset
stale `claimed` rows back to `pending`:

```sql
UPDATE bridge_outbox
   SET status = 'pending', available_at = 0
 WHERE status = 'claimed';
```

---

## 3. Reconcile by status

Run `SELECT status, COUNT(*) FROM bridge_outbox GROUP BY status;` and handle each:

| Status         | Meaning                                   | Action before revert |
|----------------|-------------------------------------------|-----------------------|
| `pending`      | Normal queued row                         | Fine for old code. Leave. |
| `retry`        | Failed, scheduled for another attempt     | **Normalise** → set to `pending` (old code ignores `retry`). |
| `claimed`      | Mid-send (see §2)                         | Reset to `pending` if stale. |
| `delivered`    | Terminal, already sent                    | Leave. |
| `needs_review` | Parked for a human (ambiguous send)       | **Resolve manually** (see below), then set `pending` or `dead`. |
| `dead`         | Terminal, exhausted retries               | Leave (old code also understands `dead`). |

Normalise the statuses old code cannot claim:

```sql
-- retry rows are just pending rows with a backoff; make them plain pending
UPDATE bridge_outbox SET status = 'pending' WHERE status = 'retry';
```

**`needs_review` rows** were parked because a send completed ambiguously (e.g. a
transport timeout after the message may have been accepted). Do NOT blind-retry
them — inspect first to avoid a duplicate send:

```sql
SELECT id, event_id, last_error, updated_at FROM bridge_outbox WHERE status = 'needs_review';
```

Cross-check each against the actual mailbox / provider logs:
- **If it was delivered** → mark terminal: `UPDATE bridge_outbox SET status='delivered' WHERE id=?;`
- **If it was NOT delivered** → requeue: `UPDATE bridge_outbox SET status='pending', available_at=0, attempts=0 WHERE id=?;`

Only once no `retry`/`needs_review` rows remain is the queue safe for old code.

---

## 4. Revert the code

```bash
git log --oneline -n 10                 # find the pre-patch SHA
git checkout <old-sha> -- src/bridge/    # or full revert / redeploy of old build
pm2 restart familybot --update-env
```

Notes on the schema after reverting:
- The extra column `bridge_outbox.claim_generation` and the
  `bridge_outbox_attempts` table are **additive** and harmless to old code —
  it simply ignores them. Do NOT drop them; a re-roll-forward will want them.
- `maxAttempts` default differs (old = 8, new = 3). If you reverted the code you
  are back to 8 automatically; override with `INSTINCT_BRIDGE_MAX_ATTEMPTS` if
  you need to pin it.

---

## 5. Un-pause

Once the old code is confirmed healthy and the queue is draining:

```bash
# If you used Option A (state file):
node -e "require('./src/bridge/billingState').unpauseBilling()"
# or just delete data/bridge-state.json

# If you used Option B (on-switch): re-enable and restart
export INSTINCT_BRIDGE_ENABLED=1
pm2 restart familybot --update-env
```

Watch `SELECT status, COUNT(*) FROM bridge_outbox GROUP BY status;` drain and the
log show `[Bridge][Gmail] sent` again.

---

## Roll-forward (re-applying the patch)

The reverse is safe with no data surgery: the new code recognises every status
old code produces (`pending`, `claimed`, `delivered`, `dead`) and re-adds
`claim_generation` via an idempotent `ALTER TABLE`. Just redeploy the new build
and un-pause.
