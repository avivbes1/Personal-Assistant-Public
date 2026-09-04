# FamilyBot / Lipa — Work Plan V6 (consolidated, post-eval)

> **Single source of truth. Supersedes V1–V5 and `WORKPLAN-ISSUE-024.md`** — delete those.
> Verified against `016db98` (2026-09-04). Covers ISSUE-023, ISSUE-024, ISSUE-025, and the A1/A2/prompt-fix eval report.
>
> **Rule:** every task ends with a verification command whose output goes in the PR description.

---

## 0. Status — what has landed since V5

| Item | State |
|---|---|
| H1/H2/H3 quoted-reply repair | ✅ `eca816b` |
| H6 whatsapp-web.js removal | ✅ `fa4d6b4` |
| A4 health checks | ✅ `d44237f` (`health-throughput.js`) |
| B1 single delivery path (P-012) | ✅ `b27f828` |
| B2 `sent_messages.group_name` | ✅ `6886df2` |
| B3 send-time staleness | ✅ `ea63d67` |
| B7/B8 group monitoring + agent-write ban | ✅ `4e8836e` |
| C1 prompt caching | ✅ `6ab4721` |
| A1 gold set / A2 baseline / prompt fix v1 | ✅ `9ae4d97`, `4c28aed`, `016db98` |
| H5 shim tests | ◐ `tests/shim/` exists — LID coverage unverified |
| E (edits), K (calendar gate), G (grounding), Q (query path), B4 | ❌ not started |

Real progress. **Now the hard part: the eval you just built is measuring the wrong things, and every conclusion in the report inherits that.**

---

## 1. The eval report — four measurement defects

The work is good and the direction is right. But before acting on any of its three "problems," four things need fixing, because they change the numbers and, in one case, invalidate the fix that was just shipped.

### (a) ⚠️ The eval scores a field production throws away

`run-eval.js:predictAction()` maps tool calls to actions by reading the LLM's `urgency_hint`:

```javascript
const u = notice.input && notice.input.urgency_hint;
if (u === 'immediate') return 'send_now';
if (u === 'time_sensitive') return 'add_notice';
return 'defer';
```

But `agent.js:315`, inside the `add_notice` handler, does:

```javascript
// Rules-based urgency classifier - deterministic, no LLM guessing
const urgencyHint = computeUrgencyHint(action, Date.now());
```

**Unconditional.** `action.urgency_hint` — the LLM's value — is discarded and never reaches `saveNotice()`. The function's own docstring says it "replaces LLM urgency_hint."

So prompt fix v1 spent its entire effort rewriting the `urgency_hint` guidance for a field that production deletes. The reported "send_now recall 7.7% → 26.9%" is an improvement in a number that does not exist downstream. In production, whether a message becomes `send_now` is decided by `computeUrgencyHint()` alone.

**This does not mean the prompt fix was worthless** — the `no_action` → `add_notice` rebalance is real and does reach production, and that's what moved pipeline accuracy 60% → 80%. But the urgency half of the fix is inert.

### (b) `computeUrgencyHint()` structurally cannot produce the labels Aviv wants

`immediate` is reachable only via an urgent-keyword hit or an event ≤3h away. Testing the report's own cited misses against `URGENT_KEYWORDS`:

| Message | Keyword hit? | Production result |
|---|---|---|
| בוקר טוב, שינוי של הרגע האחרון בצוות בגן היום | ❌ | today → `time_sensitive` |
| תזכורת…נפגשים היום ב17:00 | ❌ | >3h out → `time_sensitive` |
| מעדכנת שליבי ורומי… שיש חזרה ואף ילד לא הגיע | ❌ | → `routine` |
| הורים יקרים, בשל מצב בריאותי של מספר נשות צוות… | ❌ | today → `time_sensitive` |
| לא חייב להביא ארוחת בוקר מחר | ❌ | tomorrow → `time_sensitive` |
| האימון בוטל | ✅ `בוטל` | `immediate` |

**5 of 6 cannot be `immediate` in production, no matter what the prompt says.** The regex covers cancellations and emergencies; Aviv's gold labels say *staff changes, same-day reminders, and action-requiring requests* are also send-now. The deterministic rule and the human's intent disagree. **Problem 1 in the report is a `computeUrgencyHint()` problem, not a prompt problem.**

### (c) Multi-label is collected and then ignored

The dataset has `human_actions` on all 137 gold rows; **40 of them (29%) list more than one valid action** — `['send_now','add_event']`, `['add_notice','add_event']`, and so on. `run-eval.js` never references `human_actions`. Scoring compares against a single `expected_action`, so a model prediction matching a *different* action Aviv explicitly marked correct is counted wrong.

Recomputing from the committed `eval-results.json`:

| Scoring | Accuracy |
|---|---|
| Strict single-label (as committed) | **42.0%** (34/81) |
| Multi-label aware | **48.1%** (39/81) |
| Multi-label + `skip`/`none` merged | **58.0%** (47/81) |

### (d) `none` vs `skip` is unmeasurable by construction

`predictAction()`'s own comment: *"Both label buckets 'skip' and 'none' collapse here; we predict 'skip' since production has no signal to distinguish them."* So the 8 `none` rows are guaranteed wrong — ~10% of the gold set is unwinnable by design. The report's Problem 2 is correct in diagnosis; the fix is to **merge them in the eval**, because there is no downstream product difference (both are `no_action`). Don't add a mechanism to a taxonomy distinction that has no consequence.

**Net: the true action accuracy is ~58%, not 36%.** About 16 points of the reported failure is measurement error. Also note the report quotes 36%/77%; the committed artifact says **41.98% / 80.25%** — the report is citing an intermediate run.

### (e) The gate is on the easy question

`overallAccuracy` is pipeline_state accuracy — binary actionable-vs-not — and it alone drives `passed` and the exit code. It currently reads 0.8025 against a 0.70 threshold, so the run reports **✓ PASS** while action accuracy is 42% and priority accuracy is 53%. Wiring A3 today would gate on the one metric that is already comfortable. That is the degenerate-baseline problem returning in a new costume.

### (f) Sample size

81 unique messages; class supports of 8–26. A per-class F1 on n=9 (`add_event`, `add_notice`) moves ±0.15 on two examples. A ±3-point macro-F1 CI tolerance would be pure noise at this size.

---

## PHASE M — Fix the measurement (do before anything else in A/B/C)

### M1. Score against `human_actions`
**Steps:** in `run-eval.js`, treat a prediction as correct if it appears in `human_actions` (falling back to `[expected_action]` when absent). Keep the strict number too, reported side by side as `accuracy_strict` / `accuracy_multilabel`. For the confusion matrix, attribute a multi-label hit to the matched action.
**Acceptance:** `--gold-only` prints both figures; multilabel ≥ strict; the 40 multi-label rows are visibly credited.
**Effort:** one evening. **Blocks:** every conclusion below.

### M2. Merge `none` into `skip`
**Steps:** collapse `none` → `skip` in `ACTIONS`, in the label importer, and in the dataset. Record the original in `human_actions_raw` for provenance. Delete the "no signal to distinguish them" comment along with the distinction it apologises for.
**Acceptance:** `ACTIONS` has 5 entries; no class in the confusion matrix has structurally-zero recall.
**Effort:** one evening.

### M3. Gate on action accuracy, not pipeline accuracy ⭐
**Why:** the current exit code passes at 80% while the thing you care about sits at 42%.
**Steps:** make the exit code a conjunction — pipeline ≥ 0.80 **and** multilabel action accuracy ≥ baseline − tolerance **and** `send_now` recall ≥ baseline − tolerance. Report all three; fail on any. Set tolerances from a bootstrap over the gold set rather than a guessed ±3 (see M5).
**Acceptance:** a change that improves pipeline accuracy while dropping `send_now` recall must FAIL.
**Effort:** one evening. **Depends:** M1, M2. **Then** A3 becomes meaningful.

### M4. Evaluate the field production actually stores ⭐⭐
**Why:** defect (a). Until this is fixed, the eval cannot tell you anything about send-now behaviour.
**Steps:** in `predictAction()`, apply `computeUrgencyHint(action, recordedTimestamp)` to the model's `add_notice` payload and map *that* to the action — exactly as `agent.js:315` does. Pass the message's recorded timestamp as `nowMs`, not `Date.now()`, or every date-relative rule evaluates against today and the whole gold set silently drifts. Keep the raw LLM `urgency_hint` in `per_record` for diagnostics, clearly labelled as unused-by-production.
**Acceptance:** re-running the baseline produces different `send_now` numbers than the current file; a fixture asserts eval-predicted urgency equals what `saveNotice` would receive for the same input.
**Effort:** one weekend. **Highest-value item in this document.**

### M5. Report confidence intervals, and grow the gold set
**Steps:** bootstrap 95% CIs over the 81 rows for each headline metric and print them; set M3's tolerances from the CI width. Then continue labeling toward ≥30 support per class — priority order `add_notice` (9), `add_event` (9), `defer` (14). The 44 video rows Aviv couldn't label are a separate gap: log them as `label_source: 'unlabelable_media'` and treat their share as a media-coverage metric, not eval noise.
**Acceptance:** every reported metric carries a CI; classes below 30 support are flagged in the output as low-confidence.
**Effort:** one evening for CIs; labeling is ongoing.

---

## PHASE U — Urgency, properly (replaces the report's "Problem 1")

### U1. Decide who owns urgency
**Why:** right now the LLM emits `urgency_hint`, `computeUrgencyHint()` overwrites it, and the eval scores the overwritten-away version. Three components, no owner — the same defect as ISSUE-023/024/025 in a new place.
**Recommendation: keep it deterministic, and fix the rules.** Deterministic urgency was the right call — it's testable, cheap, and immune to prompt drift. The problem is that the rules encode "emergency" when Aviv's labels mean "acts on my day."
**Steps:**
1. Delete `urgency_hint` from `GROUP_TOOLS` entirely, or rename it `urgency_signal` and document it as advisory-only input to `computeUrgencyHint()`. Do not leave a field that looks authoritative and isn't.
2. Add **P-016:** *"Urgency is computed by `computeUrgencyHint()`. No other component may set it, and the eval must score the computed value."*
**Effort:** one evening. **Depends:** M4.

### U2. Widen `computeUrgencyHint` against the gold set
**Steps:** using the 26 `send_now` gold rows as the target, extend the rules:
- **Keywords:** add `שינוי|מחליפה|מחליף|במקום|לא יגיע|היעדרות|החלפת צוות` (staff change), `תזכורת` when combined with a same-day date, and action-requiring requests (`נא לשלוח|יש להביא|אישור עד|טופס`).
- **Date rules:** promote same-day events from `time_sensitive` to `immediate` when the message is *official* (sender is staff — you already track `sender`) or when it requires an action today. Keep parent-to-parent coordination at `routine` regardless of date, which matches both Aviv's labels and the prompt fix's intent.
- **Sender signal:** staff-vs-parent is the strongest available feature and is currently unused. Derive it from group metadata or a maintained staff list per group.
Tune against the gold set, not intuition — this is exactly what M1–M4 make possible.
**Acceptance:** `send_now` recall on the gold set improves materially with precision staying ≥0.8 (it is currently 1.00 at 0.27 recall — you have a lot of precision to spend). A fixture test pins all 26 gold `send_now` rows.
**Effort:** one weekend. **Depends:** M4, U1.

### U3. Re-run the prompt fix evaluation honestly
**Why:** prompt fix v1's `no_action` rebalance is genuinely good and should stay. Its urgency half is inert and should be reverted to keep the prompt short (it's now in the cached prefix, so it costs on every miss).
**Steps:** after M4, re-run baseline vs v1 and report which specific prompt changes moved which metric. Revert the parts that moved nothing.
**Effort:** one evening. **Depends:** M4.

---

## PHASE E — Message edits (ISSUE-025 root cause, not started)

### E1. Capture edits ⚠️ P0
Only `messages.upsert` is subscribed (`baileys-client.js:436`); **`messages.update`, where Baileys delivers edits, is never subscribed** — confirmed still absent at `016db98`. An edit arriving via upsert as a `protocolMessage` passes `if (!rawMsg.message) continue`, gets no content type mapping, and yields an empty-body `chat` event.
**Steps:** add indexed `stanza_id` to `messages`, written on every insert; subscribe `messages.update`, detect `protocolMessage.type === MESSAGE_EDIT` / `editedMessage`, emit `message_edit` with `{stanzaId, groupId, newBody, editedAt}`; handle the upsert-borne shape too; `db.updateMessageBody(stanzaId, newBody)` **keyed on `stanza_id`**; change the unique index from `(group_id, timestamp, body)` to `(group_id, stanza_id)` after backfill; on body change reset `pipeline_state='RECEIVED'`, `processed=0`, re-queue extraction, and preserve the prior text in `body_history`; register the handler in `whatsapp.js`; make `scanGroupHistory()` match on `stanza_id` and update on difference.
**Note the report's proposed fix cannot work:** `ON CONFLICT(group_id, timestamp, body) DO UPDATE SET body=excluded.body` has `body` in the conflict target, so it never fires on a body change. Today `INSERT OR IGNORE` doesn't ignore an edit either — it inserts a **duplicate row**.
**Acceptance:** `tests/regression/2026-09-04-message-edit.js` — one row, updated body, re-extraction ran, `body_history` holds both. Live: edit a message in a test group, watch the notice update.
**Effort:** one weekend.

### E2. Media caption edits
The ISSUE-025 payload was an image caption. Ensure a caption edit updates `body` without re-downloading, re-OCR'ing, or resetting `media_status`.
**Effort:** one evening. **Depends:** E1.

---

## PHASE K — Calendar gate (not started)

### K1. Make `calendar_worthy` reachable
`shouldCreateCalendar()` branches on `notice.calendar_worthy === 1`, commented *"Explicit flag from LLM extraction"* — but `calendar_worthy` and `event_type` are still absent from the `add_notice` schema and nothing writes them. The branch is dead; every calendar decision falls to the regex fallback.
**Steps:** add both fields to `GROUP_TOOLS` (do this in the same PR as C2 strict tool use); add the columns; write them at insert; keep the regex as fallback; log `calendar_source: 'llm' | 'pattern'`.
**Effort:** one evening. **Do before K2.**

### K2. Rewrite `EVENT_PATTERNS`
Five hand-written party-and-trip regexes at `calendar-bridge.js:26`. Tested against realistic notice content: **0 of 12 match** — אסיפת הורים, אספת הורים, ישיבת הורים, מפגש הורים, יום הורים, אסיפה כללית, חוג, שיעור, אימון, חופש/חג, מבחן, חיסון. Not a missing keyword; six missing categories.
**Steps:** add `meeting` (`אסיפ|אספ|ישיב|מפגש הורים|יום הורים`), `class` (`חוג|אימון|שיעור|תרגול`), `holiday` (`חופש|חג|סוכות|פסח|ראש השנה`), `exam` (`מבחן|בחינה|מבדק`), `health` (`חיסון|בדיקת|רופא`), `deadline` (`עד תאריך|תשלום עד|הרשמה עד`). Build the fixture table from **real notice content in the DB**.
**Acceptance:** `tests/unit/calendar-classify.test.js` ≥11/12 on the table and ≥90% on 50 hand-checked real notices.
**Effort:** one evening. **Depends:** K1.

### K3. Date-known / time-unknown
When `calendar_worthy` and `relevance_date` are set but `relevance_time` is null: create an **all-day** event with an explicit marker (`— שעה טרם פורסמה`), set `time_status='unknown'`, surface it in the digest as such. **Never substitute a default time.** When a later message supplies the time, update via fingerprint rather than duplicating.
**Acceptance:** regression test on notice #1839's content — all-day, marked, no invented time; then feed the 18:00 clarification and assert in-place update.
**Effort:** one weekend. **Depends:** K1, K2, E1.

### K4. Notice enrichment on follow-up
Use the existing `thread_key`: if a future notice with the same key exists, fill null fields (`relevance_time`, `relevant_datetime`, location) from the new message and append to `sources`, keeping the original `created_at`. Never overwrite a non-null field without recording both — an enrichment and a reschedule are different, and only the first is safe to apply silently.
**Acceptance:** Sep 1 message + Sep 3 clarification → one notice, `relevance_time='18:00'`, two `sources`.
**Effort:** one weekend. **Depends:** E1.

---

## PHASE G — Grounding (ISSUE-025 Failure 4, not started)

### G1. Extend the guard boundary to Lipa's writes ⭐
`guardedSend` is still imported by exactly one file — `heartbeat/reminderJob.js`. Reminders cannot be hallucinated. **Calendar writes and every master-group answer are outside that boundary**, which is why nothing was positioned to stop the fabricated 18:30.
**Steps:** route all calendar writes, including OpenClaw's, through one endpoint requiring `source_notice_id` / `source_message_id`; extend `sourceValidator.validateSource()` with a `calendar` source type; **reject any field value absent from the cited source** and `logBlocked()` it; on rejection, Lipa's only remaining move is to report what it found and what it didn't. Add **P-015:** *"No calendar event, reminder, or family-facing factual claim is written without a validated source row. A value absent from the source is reported as absent, never inferred."*
**Acceptance:** a calendar write with a time absent from the cited notice is rejected and logged. Replay ISSUE-025: Lipa cannot create the 18:30 event.
**Effort:** one weekend. **Highest priority in this phase — a prompt rule will not hold.**

### G2. Negative-result discipline in Lipa's instructions
Second layer only. In `AGENTS.md`/`TOOLS.md`: *"When you search for a specific value and don't find it, report the negative result and what you did find. Never substitute a 'standard', 'usual', or 'typical' value for a family-specific event. If the user insists it exists, say where you searched and how far back, and ask them to point at the message."* Include the ISSUE-025 exchange verbatim as a worked example.
**Effort:** one evening.

### G3. Log fabrication candidates
When a Lipa answer contains a specific time/date/amount absent from any cited source, write to `grounding_misses`; nightly job alerts. Merge with Q6's `query_misses` — same shape, same job.
**Effort:** one weekend. **Depends:** G1.

---

## PHASE Q — Query path (ISSUE-024, not started)

### Q1. Notices read endpoint
`voice-server.js` still has no notices route; `schedule-classifier.js` and `notices/repository.js` are still imported by nothing.
**Steps:** `GET /api/notices/search?q=&child=&days=` and `/api/notices/upcoming?from=&to=&child=` backed by `NoticeRepository`, in the existing hand-matched-URL style. Implement the missing cascade — `findUpcoming()` → if empty, `findByContent()` → return `matched_via`. Localhost-only, capped LIMIT, log hit counts.
**Effort:** one evening.

### Q2. Fix child resolution ⚠️ before Q1 ships to OpenClaw
`findUpcoming()` filters `childName` via `r.content.includes(childName)`, but `notices` has no child column and the repository never joins `groups`. The link lives in `groups.primary_child`, and content won't carry the name — `add_notice` says *"עובדות בלבד"*, so a football-group notice never says נבו; the group *is* the association. **Implemented as proposed, ISSUE-024 reproduces.**
**Steps:** add `primary_child` to `notices`, populated at insert from the source group, backfilled via `notices.group_name → groups.name`; match against `primary_child` **OR** `content`; add `related_children` (JSON) for multi-child groups and log rather than silently picking one.
**Effort:** one evening.

### Q3. Register as an OpenClaw tool
`lookup_family_notices(query, child?, from?, to?)` calling Q1; in `TOOLS.md`: *call before answering any question about schedules, activities, events, times, locations, or what to bring; never answer "אין לי מידע" without calling it first.* Return `matched_via` and notice IDs so Lipa can cite — which G1 then requires.
**Effort:** one evening. **Depends:** Q1, Q2.

### Q4. Pre-fetch hint, not a gate
Measured coverage of `isScheduleQuery()` on realistic phrasings is **7/14** — misses include `באיזה שעה החוג של נבו?`, `איפה האימון של נבו?`, `מה עם הכדורגל של נבו`, `כמה עולה החוג?`, and `מתי מתחילה עונת הכדורגל?` (the pattern wants `מתי ה…`, gets `מתי מתחילה`). A gate would skip the lookup half the time with no log line.
**Steps:** run the classifier before passthrough; if it fires, pre-inject results. If it doesn't, **change nothing**. Never suppress passthrough on a non-match.
**Effort:** one evening. **Depends:** Q3.

### Q5. Extend the regex set
Add `באיזה שעה`, `איפה (ה|יהיה)`, `מה עם ה`, `כמה עולה`, `מתי (מתחיל|מתחילה|מסתיים)`, `צריך להביא`, `יש ל\S+ (חוג|אימון|שיעור)`. Optimization only, now that Q3 is the net. **Acceptance:** ≥12/14.
**Effort:** one evening.

### Q6. Log unanswered questions
When Lipa replies `אין לי מידע`/`לא מצאתי`/`לא יודע`, record question + reply + whether the tool was called to `query_misses`; nightly job re-runs the lookup and **alerts if the data existed**. Surface in health metrics; feed D1.
**Effort:** one weekend. **Depends:** Q1. Merge with G3.

---

## PHASE A / B / C — remaining

- **A3. CI eval gate** — wire only **after M1–M4**. Gating today would lock in a pass on pipeline accuracy while action accuracy is 42%. **Depends:** M3.
- **A5. Keep labeling** — toward ≥30 support per class (M5).
- **B4. Quiet-hours hole** — `immediates` still send before `isQuietHours()`, and U2 will *increase* the number of `immediate` classifications, so this gets more urgent, not less. Record `urgency_source: 'keyword' | 'datetime' | 'sender'`; during quiet hours bypass only when the datetime rule fired (event ≤3h); keyword-only defers to the digest. **Do U2 and B4 in the same PR.**
- **B5. Tune dedup/escalation thresholds** — `findDuplicates(0.65)`, `ESCALATION_THRESHOLD 0.6`, `ABSTENTION_THRESHOLD 0.5`, all unmeasured; self-reported confidence is poorly calibrated, so if the confidence/correctness curve is flat, escalate on *class* instead. Hebrew note: `לגן`/`הגן`/`גן` are distinct tokens under Jaccard — factor out `_normalizeForFingerprint()` from `calendar-bridge.js` and share it before reaching for embeddings. **Depends:** M1–M4.
- **C2. Strict tool use / structured outputs** — pair with K1, same schema edit.
- **C3. Hebrew audio** — Groq `whisper-large-v3-turbo` is the generic model; ivrit.ai's `whisper-large-v3-ct2` / `whisper-large-v3-turbo-ct2` (CTranslate2, faster-whisper) are materially better on Hebrew. Set the language token to Hebrew explicitly — their language detection is degraded by the fine-tune. Build 20 hand-transcribed fixtures, compare WER, keep Groq as fallback until the replacement wins. On 4GB use `turbo-ct2` int8 or stay remote.
- **C4. Media fixtures** — and note the eval's own signal: **44 of 133 sampled rows (33%) were unlabelable because they were video.** That is a real coverage hole, not a labeling inconvenience. Measure what fraction of ingested media the pipeline extracts anything from, per type.
- **C5. Model routing** — Sonnet comparison failed with API errors; retry after M4, since a model matrix scored on a discarded field would be meaningless anyway.
- **C6. Claude Code router** — still unresolved: confirm the Max-subscription routing is within terms, and note CC calls report zero tokens so they're invisible to `TOKEN_LIMIT_DAILY` and cost metrics.
- **H5. Finish shim tests** — `tests/shim/` exists; verify LID coverage. `toWWebJid()`/`toBaileysJid()` still pass `@lid` through untouched, so LID-form participants flow into `_serialized`, `author`, and the `FAMILY_PHONES` lookups and never match. Property test `toBaileysJid(toWWebJid(j)) === normalizeJid(j)` including LID; resolve via `signalRepository` with a cached `lid_map`.
- **D1/D2/D3** — unchanged; all still gated on the above. Merge `query_misses`, `grounding_misses`, and 👎 feedback into one review queue.

---

## Priority order

**This week**
1. **M4** — score the field production stores (invalidates current conclusions until done)
2. **M1 + M2** — multi-label scoring, merge `none`/`skip` (~16 points of apparent failure)
3. **G1** — extend the guard boundary to calendar writes
4. **E1** — edit capture
5. **M3** — gate on action accuracy, then A3

**Next**
6. **U1 + U2 + B4** — urgency ownership, widened rules, quiet-hours hole, one PR
7. **K1 + K2** — reachable flag, then real patterns
8. **Q1 + Q2 + Q3** — the query path
9. **U3, M5, K3, K4, G2, G3, Q4–Q6**
10. **B5, C2, C3, C4, C5**, H5 completion
11. **D1 → D2 → D3**

## Probably never
Claude Agent SDK / LangGraph migration; WhatsApp Business Cloud API; local embeddings on a 4GB box; a fine-tuned Hebrew classifier; multi-box HA.

---

## Open risks

- **Third-party Baileys fork** pinned to a *branch* (`github:doryani-ai/Baileys#fix/companion-reg-refresh`). Given the `lotusbail` trojanized-fork incident, audit the diff and pin to a commit SHA — a branch can be force-pushed under you.
- **RC dependency** `7.0.0-rc14`; E1 adds a second untested integration point to the same shim.
- **Session and state backup** — confirm `whatsapp-session/` and SQLite are off-box, encrypted, and **test the restore.**
- **Cost blind spot** — Claude Code-routed calls report zero tokens.
- **Family data** — every monitored message reaches Anthropic; audio reaches Groq.
- **Eval cost** — $0.125 per 81-row gold run. A 120-row PR gate is ~$0.20; fine.

---

## Verification commands

```bash
# M4: eval urgency matches production urgency
node -e "const{predictAction}=require('./tests/eval/run-eval');console.log(predictAction.toString().includes('computeUrgencyHint'))"
# expected: true

# M1/M2: multi-label scored, none merged
node tests/eval/run-eval.js --dry-run --gold-only    # expects accuracy_strict + accuracy_multilabel, 5 ACTIONS

# M3: gate is a conjunction incl. action accuracy
grep -n "passed =" tests/eval/run-eval.js            # expected: not overallAccuracy alone

# U1: urgency has one owner
grep -rn "urgency_hint" src/agent.js | grep -v computeUrgencyHint   # expected: no authoritative writes

# E1: edits subscribed, dedup key fixed
grep -n "messages.update" src/baileys-client.js
grep -n "idx_messages_dedup" src/db.js               # expected: (group_id, stanza_id)

# K1/K2
grep -c "calendar_worthy" src/agent.js               # expected: >0
node tests/unit/calendar-classify.test.js            # expected: >=11/12

# G1: no calendar write without a validated source
grep -rn "validateSource" --include=*.js src/ | grep -ci calendar   # expected: >0

# Q2: child resolves via group, not content
grep -n "content.includes(childName)" src/notices/repository.js     # expected: no output

# H5: LID covered
grep -rl "@lid" tests/shim/ | wc -l                  # expected: >0
```
