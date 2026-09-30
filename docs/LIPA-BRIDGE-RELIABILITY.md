# Lipa Bridge — Reliability Layer

Durable worker for the Lipa lane (`bridge_lipa_inbox`/`bridge_lipa_outbox`).
Purely additive on top of the existing tables; the plain lane keeps working.

Code: `src/bridge/lipaReliability.js` · migrations in `src/db.js` · gate
`scripts/lipa-bridge-poll.js` · completion `scripts/lipa-bridge-respond.js` ·
tests `tests/bridge/lipa-reliability.test.js`.

## Row lifecycle (`bridge_lipa_inbox.status`)

```
pending → claimed → done
                 ↘ retry (backoff+jitter) → claimed → …     (≤ 3 attempts total)
                 ↘ needs_review   (uncertain mutating work — never auto-retried)
                 ↘ dead           (attempts exhausted)
any     → paused  (billing circuit breaker; lane-wide, in bridge_lipa_state)
```

`claim_generation` is a per-row fencing token bumped on every (re)claim and on
reconcile. A completion must present the generation it was handed at claim; a
stale/late one no longer matches and is **ignored** (logged `fenced`).

## Gate + trigger configuration (OpenClaw scheduled task)

- **Command:** `node /home/ubuntu/besinsky-bot/scripts/lipa-bridge-poll.js`
- **Schedule:** every 2 minutes.
- **Runs outside any agentTurn** — plain Node, no LLM.
- **Wake contract:** OpenClaw spawns an agent turn **only** when stdout contains
  the sentinel `LIPA_BRIDGE_WAKE`. Empty queue / paused lane / lock held by
  another worker → exit 0 with no sentinel → **no LLM wake**.
- The gate reconciles expired leases, checks the circuit, claims only **due**
  rows (`status IN (pending,retry) AND available_at <= now`) under a single
  global worker lock, and emits each row's `claim_generation` + `session_id`.
- **Completion:** the agent calls
  `node scripts/lipa-bridge-respond.js <inbox_id> <request_id> '<response_json>' [subj] [inReplyTo] '<options_json>'`
  where `options_json` **must** include `claim_generation` (fencing) and may set
  `uncertain:true` (→ `needs_review`), `provider_message_id`, `cache_read_tokens`,
  `cache_write_tokens`.

Tunables (env): `LIPA_BRIDGE_MAX_ATTEMPTS=3`, `LIPA_BRIDGE_BACKOFF_BASE_MS=60000`,
`LIPA_BRIDGE_LEASE_MS=300000`, `LIPA_BRIDGE_LOCK_TTL_MS=300000`,
`LIPA_BRIDGE_MAX_ARGS_BYTES=65536`.

## Billing circuit breaker

Reacts to **actual** provider billing errors only (HTTP 402,
`insufficient_credits`/`insufficient_quota`/`billing`/`payment_required` codes or
messages) — **not** cost estimates (no $2/$20 caps; not approved). On detection:
persist `paused` in `bridge_lipa_state`, fire an ops alert, and hold the row in
`retry` **without** counting the outage against its 3 attempts. Resume with
`resumeCircuit()` once billing is restored.

## Rollback procedure (state-aware — DO NOT just `git revert` + restart)

The old code does **not** understand the states `retry`, `needs_review`, `dead`,
or `paused`, nor the fencing columns. Reverting blindly would make the old poller
pick up half-processed / parked rows or re-run uncertain side effects. Drain
first:

1. **Pause** — stop new claims:
   `node -e "require('./src/db').initDB();require('./src/bridge/lipaReliability').pauseCircuit('rollback')"`
   (The gate now exits silently; no agent wakes.)
2. **Drain / reconcile claims** — release in-flight leases and fence their
   workers so no late completion lands after revert:
   `node -e "require('./src/db').initDB();console.log(require('./src/bridge/lipaReliability').reconcileStaleClaims({now:Date.now()+10**9}))"`
   (the huge `now` forces every `claimed` row to reconcile immediately).
3. **Resolve non-terminal states before the old code sees them:**
   - `retry` rows → set `status='pending'`, `available_at=created_at` (old poller
     only understands `pending`).
   - `needs_review` rows → **leave as-is and handle by hand.** Never flip these
     back to `pending`: their side effect may already have happened; blind retry
     is exactly what this layer prevents. Export them first:
     `SELECT id, command, last_error FROM bridge_lipa_inbox WHERE status='needs_review';`
   - `dead` rows → export for audit, then set `status='pending'` only if you
     intend the old code to retry them; otherwise leave `dead`.
   - `paused` — there is no per-row `paused`; it is the lane-wide circuit only.
4. **Preserve suppression** — before reverting, snapshot the control table so the
   pause/suppression state is not lost:
   `sqlite3 data/family.db ".dump bridge_lipa_state" > /home/ubuntu/lipa_state_backup.sql`
5. **Revert code + restart** the services (see RUNBOOK). New columns/tables are
   additive and simply go unused by the old code — safe to leave in the schema.
6. **Re-apply** — to roll forward again, restore `bridge_lipa_state` and
   `resumeCircuit()`.
