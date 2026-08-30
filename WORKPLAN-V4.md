# FamilyBot / Lipa — Work Plan V4 (complete, code-grounded)

> **Single source of truth. Supersedes `WORKPLAN.md` (V1), `WORKPLAN-V2.md`, and `WORKPLAN-V3.md`** — delete those.
> Based on a full read of the code at `d298532` (2026-08-27, `main`), plus verification of the 2026-08-30 incident on the הורי נעורים רשפים group (ISSUE-023).
>
> **Audience:** a coding agent (Claude Code / OpenClaw) with write access, working under Aviv's approval.
> **Rule:** every task ends with a verification command whose output goes in the PR description. No task is "done" because code was written.
>
> **Terminology, because two things share a name:** `whatsapp-web.js` is the *npm library* you migrated off — no production file imports it any more. `src/whatsapp.js` is *your own file*, 1,595 lines, still the live message router booted by `src/index.js:9`. Every `whatsapp.js:NNN` reference below means your file.

---

## 1. The diagnosis in one paragraph

You built the eval harness, tracing, health checks, dedup, quiet hours, and the rules+LLM cascade that the first plan asked for. The problem is no longer missing infrastructure — it's that **the instruments cannot fail.** The eval set is labeled by the same model it tests (`labeled_by: claude-haiku-4-5` on all 1017 rows, identical to `agent.js`'s `GROUP_MODEL`), the committed baseline is 20 rows of a single class scoring 1.000, and CI only runs `--dry-run`. Meanwhile two independent processes send to the master group with divergent policy, and ISSUE-023 showed a third instance of the same structural pattern in config state. Everything below is ordered to fix measurement first, then the structures that produce bad messages, then quality, then proactivity.

---

## 2. What is genuinely good — stop rewriting these

| Thing | File | Why it's right |
|---|---|---|
| **Incident-derived principles** | `PRINCIPLES.md` (P-001…P-010) | Each names a real incident, root cause, and a grep-able check. Excellent artifact — keep the discipline. |
| **Tool-calling, not JSON-in-prose** | `agent.js` `GROUP_TOOLS`, `tool_choice:{type:'any'}` | Schema-validated, can't truncate mid-object, forces a decision. |
| **Hallucination guard on outbound** | `src/delivery/guardedSend.js`, `src/validation/sourceValidator.js`, `templates/*.mustache` | The LLM never writes reminder text; messages render from validated DB rows. Best decision in the repo. Extend, don't dilute. |
| **Pipeline state machine** | P-008, `markMessageProcessing/Terminal/Failed`, `pipeline-monitor.js` | Every message has an explicit lifecycle. Rare and valuable. |
| **Claim-before-LLM** | `triage-engine.js` — `UPDATE notices SET send_attempted_at` before any API call | Closes the P-001 race properly. |
| **Wall-clock budget guard** | `BUDGET_MS = 80_000` + reset-to-queue on overflow | Correct implementation of P-002. |
| **Shadow mode** | `TRIAGE_SHADOW`, `data/triage-shadow-log.jsonl` | Default-on dry run. Most projects never build this. |
| **Deterministic urgency** | `computeUrgencyHint()` | Moving urgency off the LLM was right. |
| **Media chain breadth** | `media-parser.js` | Vision + Tesseract `-l heb` + Groq Whisper + pdf-parse/mammoth/xlsx. |
| **Poll-based scheduler** | `scheduler.js` | Survives restarts. |

**Architecture verdict:** keep the custom harness. `agent.js` is a single-call, tool-forced extractor. Wrapping it in Claude Agent SDK or LangGraph buys nothing and costs the legibility that makes `PRINCIPLES.md` possible. Pain point #6 is a perceived problem, not a real one.

---

## 3. Root causes, mapped to code

| # | Complaint | Cause in the code |
|---|---|---|
| 1 | Commits break things, tests don't catch | `ci.yml` runs `run-eval.js --dry-run` only — structure validation, zero LLM calls. The eval exists but isn't a gate. |
| 2 | Monitoring insufficient | `health.js` checks DB tables, calendar auth, WhatsApp state, stale pending actions — all *connection* checks, no *throughput* check. `dataset-stats.json` shows 8% `FAILED` and 15% stuck at `RECEIVED`, invisible to alerting. |
| 3 | No self-initiated improvement | Not built. Correctly deferred — needs A1–A4 first. |
| 4 | Triage/dedup/duplication | Two senders (B1). Plus group identity resolved by 8-char substring match (B2). |
| 5 | Media + alert timing unreliable | Media chain is structurally fine but unmeasured; staleness gate is date-granular only (B3). |
| 6 | Custom harness might be wrong | It isn't. |
| 7 | Model choices unsure | The baseline that was supposed to answer this is degenerate (A2). |
| 8 | General "not good enough" | Circular labels + fake baseline + non-gating CI = you still can't distinguish a good change from a bad one. |

**One sentence:** *your eval set is labeled by the model under test, so it measures self-agreement rather than correctness, and CI never runs it anyway.*

---

## 4. What ISSUE-023 added

Lipa's incident report correctly identified the primary bug at line level. Verifying it against the code turned up three things.

**Confirmed:**
- **RC1 real.** `baileys-client.js:getQuotedMessage()` sets `quotedKey.fromMe = ci.participant ? false : true`; the `BaileysMessage` constructor computes `_serialized` once from that key; later corrections touch `quotedMsg.fromMe` and `quotedMsg.id.fromMe` but never recompute `id._serialized`. The lookup key is wrong for every quoted reply in a group.
- **RC2 real.** `isMonitoredGroup()` (`whatsapp.js:372`) accepts only `related_to === 'monitored'`; the DB held `related_to='שגב'`.

**Missed — RC3, and it's the reason nine hours passed.** `whatsapp.js:~1336` already has a pattern-match fallback for exactly this failure, gated on `quotedMsg.fromMe`, which *is* corrected and would have been true. It didn't fire because its regex doesn't match the template that was sent. Tested against all four live templates:

| Template | Capture | Correct? |
|---|---|---|
| `whatsapp.js:1091` `אני עוקב אחרי הקבוצה *X* אבל…` | `הורי נעורים רשפים` | ✅ |
| `whatsapp.js:1073` `נוספתי לקבוצה חדשה: "X"` | `קשורה? מעוניינים במעקב? (ענו…` | ❌ |
| `whatsapp.js:1196` `נוספתי לקבוצה חדשה: *X*` | `קשורה? מעוניינים במעקב? (ענו…` | ❌ |
| `whatsapp.js:1562` `נוספתי לקבוצה: *X*` | no match | ❌ |

Regex 1 (`/הקבוצה \*?["]?([^*"\n]+?)[*"]?\s*(?:אבל|$)/`) only works when the `אבל` anchor is present — i.e. only for the "already monitored, missing context" template. For the three "added to a new group" templates it greedily matches the later phrase `למי הקבוצה קשורה?` and captures garbage, so regex 2 never runs. The garbage is then fed to `allGroups.find(g => g.name.includes(groupName.substring(0,8)))` — the same anti-pattern as B2 — so had any group name contained that fragment, it would have silently classified **the wrong group**. The safety net works for 1 of 4 cases and is unsafe in the rest.

**Two corrections to the report:** the reconstructed suffix is `_<bot-jid>`, not a bare `_`. And the schema convention wasn't wrong — the bot's own path (`whatsapp.js:1317`) correctly does `setGroupRelatedTo(id,'monitored')` plus `setGroupDescription(id, freeText)`. OpenClaw wrote to the wrong column. **Fix the writer, not the reader.**

**The structural lesson:** three layers failed silently in sequence and nobody found out for nine hours. This is the same class as B1 (two delivery paths) and as your own P-010 — two components each partially owning something, so neither owns it and the gap is silent. P-010 was written three weeks ago; the pattern recurred immediately in a new place.

---

## PHASE H — Hotfix (this week)

### H1. Fix `getQuotedMessage()` ID reconstruction
**Why:** breaks every quoted reply in a group, not just group classification. Follow-up yes/no replies (`getFollowUpByBotMsgId(quotedId)`, `whatsapp.js:1364`) use the same `quotedId` and are equally broken — likely other "the bot ignored me" moments.
**Do not** simply recompute `_serialized` with the participant suffix as the report's first snippet suggests — that still won't match, because messages the bot sends to a group come back with no `participant`. Match on `stanzaId`, the only stable identifier in both directions.
**Steps:**
1. In `getQuotedMessage()`, move the `fromMe` determination **above** `new BaileysMessage(...)` so the constructor computes `_serialized` correctly the first time; omit `participant` from the key when `fromMe` is true (mirrors what `sendMessage` returns).
2. Add `stanzaIdOf(id)` and make all `_ser(quotedMsg.id)` consumers fall back to a `stanzaId` match.
3. Add a `stanza_id` column to `pending_group_questions` and the follow-up table; write it at send time; index it; look up by `stanza_id` first. This removes the dependency on serialization format entirely.
**Files:** `src/baileys-client.js`, `src/whatsapp.js` (~1307, ~1364), `src/db.js`, migration `006_stanza_id.sql`
**Acceptance:** `tests/regression/2026-08-30-quoted-reply-id.js` — construct a group message quoting a bot-sent message; assert `_ser(quoted.id)` equals what `savePendingGroupQuestion` stored, and that `stanzaId` lookup succeeds even when it doesn't. Live: reply to a pending group question and confirm the ✅ comes from the **bot**, not Lipa.
**Effort:** one evening.

### H2. Never fail silently on a master-group quoted reply
**Why:** the whole reason nine hours passed. P-008 forbids silent success in the extraction pipeline but says nothing about master-group command handling.
**Steps:**
1. Before falling through the master-group quoted-reply block: `logger.warn({component:'WhatsApp', quotedId, stanzaId, quotedBodyPrefix, pendingCount}, 'Quoted reply matched no handler')`.
2. DM Aviv (not the master group) when a quoted reply matches nothing: *"לא הצלחתי להתאים את התגובה שלך לשאלה פתוחה — צריך טיפול."* Rate-limit hourly, same pattern as `alertCreditExhausted()`.
3. Add **P-011**: *"Every master-group message reaching a handler must exit through a logged branch. Silent fall-through is a P-011 violation."* Add the grep to `check-principles.js`.
**Acceptance:** send a quoted reply to an unrelated bot message; a warn line appears and the DM fires.
**Effort:** one evening. **Do this even if H1 slips** — it converts every future instance of this class from invisible to noisy.

### H3. Fix or delete the pattern-match fallback
**Steps:**
1. Collapse the four question templates into one `buildGroupQuestion(name)` helper wrapping the name in a machine-readable delimiter (e.g. `⟦${name}⟧`); use it at lines 1073, 1091, 1196, 1562.
2. Replace both regexes with one anchored match on that delimiter.
3. Replace `g.name.includes(groupName.substring(0,8))` with exact-name equality; if no exact match, log and bail — never guess.
4. If H1's `stanza_id` lookup lands, this fallback is redundant; deleting it is an acceptable outcome. Do not keep a broken safety net.
**Acceptance:** unit test asserting correct extraction from the (now single) template, and that a near-miss name returns null rather than a wrong group.
**Effort:** one evening.

### H4. Immediate DB repair + backlog audit
```sql
UPDATE groups SET related_to='monitored', description='קבוצת נעורים — שגב, במעקב'
  WHERE id='972547860456-1396447584@g.us';
DELETE FROM pending_group_questions WHERE group_id='972547860456-1396447584@g.us';
```
Then audit the other 10 pending questions: has each group since been configured by any path? Any group with `configured=1` and `related_to NOT IN ('monitored','master','ignored')` is a victim of the same bug. Run `scanGroupHistory()` on the recovered group so the missed image and backlog get processed.
**Acceptance:** `SELECT related_to, COUNT(*) FROM groups GROUP BY related_to` returns only sanctioned values plus NULL; `pending_group_questions` holds only genuinely unanswered questions.
**Effort:** one evening.

### H5. Regression suite for the Baileys compatibility shim ⭐ *new*
**Why:** `baileys-client.js` is a translation layer that makes Baileys objects impersonate whatsapp-web.js objects — `BaileysMessage`, `BaileysChat`, `BaileysClient`, plus `normalizeJid` / `toWWebJid` / `toBaileysJid`. It reproduces another library's conventions on top of a **release candidate** (`7.0.0-rc14`) with **zero tests**. ISSUE-023 lived precisely here. This is a bug factory and it needs a net.

**A second defect found while mapping it:** `toWWebJid()` only rewrites `@s.whatsapp.net → @c.us`, and `toBaileysJid()` only the reverse. A **`@lid` JID passes through both untouched.** So when Baileys hands you a LID-form participant, that string flows straight into `id._serialized`, into `msg.author`, and into every downstream identity comparison — including `FAMILY_PHONES` lookups keyed on `AVIV_PHONE`/`LIAT_PHONE` in `agent.js`, and the `quotedParticipant === myJid` check that ISSUE-023 depended on. It will never match, and it will fail silently, exactly like ISSUE-023. This is the LID→phone resolution problem in concrete form.

**Steps:**
1. Create `tests/shim/` with fixture files: captured raw Baileys message objects (redacted) for each case — group text, DM text, group image with caption, quoted reply to a bot message, quoted reply to a human message, voice note, document, reaction, and a **LID-form participant** variant of each.
2. Table-driven test asserting, for every fixture, the full whatsapp-web.js-shaped surface: `id._serialized`, `id.fromMe`, `from`, `to`, `author`, `type`, `body`, `hasMedia`, `hasQuotedMsg`, and `getQuotedMessage()` round-tripping to the ID that `sendMessage()` would have returned.
3. Property test: `toBaileysJid(toWWebJid(j)) === normalizeJid(j)` for phone JIDs, group JIDs, device-suffixed JIDs (`<phone>:0@…`), **and LID JIDs**. This one will fail today — that's the point.
4. Fix the LID gap: resolve `@lid` to a phone JID via `signalRepository` (already exposed at `baileys-client.js:739`) before any identity comparison, and cache the mapping in a `lid_map` table so resolution survives restarts. Where resolution fails, log loudly rather than passing the raw LID downstream.
5. Wire `tests/shim/` into `npm test` and into CI — these are pure fixtures, no API calls, no secrets.
6. Add **P-014**: *"Every field of the whatsapp-web.js compatibility surface in `baileys-client.js` has a fixture test. No shim field may be added or changed without one."*
**Acceptance:** the suite passes; the LID property test passes after step 4; deliberately reintroducing the ISSUE-023 `fromMe` bug makes the suite fail.
**Effort:** one weekend. Highest-leverage defensive work outside Phase A — it turns the riskiest file in the repo from untested to pinned.

### H6. Finish the whatsapp-web.js removal
**Why:** no production file imports the library — verified, and `tests/regression/2026-06-14-notice-regression.js` even asserts it isn't imported. But it's still installed in `package.json` (`whatsapp-web.js ^1.34.7`), and the README still documents it as the stack, including a `getChats()` setup snippet that would no longer run. Anyone — human or agent — reading the repo is misled about which client is live.
**Steps:** remove the dependency; run the test suite; rewrite the README's architecture, prerequisites, and group-JID-discovery sections against Baileys; note that `src/whatsapp.js` (your router) is unrelated to the removed library so nobody "cleans up" the wrong thing.
**Acceptance:** `npm ls whatsapp-web.js` returns empty; `npm test` passes; README contains no `whatsapp-web.js` reference except a one-line migration note.
**Effort:** one evening.

---

## PHASE A — Make the instruments real

Nothing in B, C, or D is trustworthy until A1–A4 land.

### A1. Re-label a human-verified golden subset
**Why:** all 1017 rows carry `"labeled_by":"claude-haiku-4-5"` — same constant as `GROUP_MODEL`. The eval rewards the classifier for reproducing its own mistakes. (`scripts/export-eval-set.js:37` defaults to Haiku; its docstring says Sonnet — fix that too.)
**Steps:** add `label_source: "model" | "human" | "human_corrected"`, backfill existing to `"model"`; stratified-sample 250 rows (all 39 `send_now`, all 39 `archive`, all 59 `add_event`, proportional draw from the rest); build `scripts/label-review.js` that appends after every row so partial work is never lost; add `--gold-only` to `run-eval.js`. Aviv and Liat label together — Liat is ground truth for "would you have wanted to know."
**Acceptance:** `node tests/eval/run-eval.js --dry-run --gold-only` reports ≥250 rows, ≥30 in each of `send_now`/`add_event`/`archive`, zero `label_source:"model"`.
**Effort:** 2–4 evenings, mostly human labeling. Highest-value work in this document. **Unblocks everything.**

### A2. Fix the degenerate baseline
**Why:** `tests/eval/eval-results.json` is `total: 20`, `confusion: {add_notice:{add_notice:20}}`, `accuracy: 1`. Every row was the same class — the run cannot produce a wrong answer. It's a green light wired to nothing.
**Steps:** run `--gold-only` over the full A1 set; record per-class P/R/F1, especially for `send_now` and `skip` (the two that map to your felt pain — spam vs. missed); commit as `tests/eval/baseline.json` with git SHA and model ID; add `--compare baseline.json` exiting non-zero beyond ±3 points macro-F1.
**Acceptance:** ≥4 populated classes, no `support: 0` class in the macro average.
**Effort:** one evening. **Depends:** A1.

### A3. Make CI actually gate
**Steps:** add an `eval-gate` job on `pull_request` using `ANTHROPIC_API_KEY` from secrets; run `--gold-only --compare` over a fixed 120-row slice (~$0.25/PR, extrapolating from the recorded $0.0401 for 20 rows); post the per-class table as a PR comment; keep `test` and `pii-scan` as-is; add a pre-push hook running `detect-pii.js` + `check-principles.js`.
**Acceptance:** a PR weakening the `no_action` bullet in `buildGroupSystemPrompt` must fail CI; reverting must pass.
**Effort:** one evening. **Depends:** A2.

### A4. Health checks that catch silent failure
**Add to `health.js`:**
1. **Ingestion volume** — 0 messages in the last 3 daytime hours → alert.
2. **Terminal-state rate** — `FAILED + RECEIVED` older than 30 min exceeding 5% of the last 24h → alert with top 3 failure codes.
3. **Media parse rate** — >20% of media messages parsing to null over 24h → alert.
4. **Delivery duplicate canary** — two `sent_messages` rows within 24h at ≥0.9 Jaccard → alert. Works regardless of which sender produced them.
5. **Config-state integrity** *(from ISSUE-023)* — any `pending_group_questions` row older than 48h, or any group with `configured=1` and `related_to` outside `('monitored','master','ignored')` → alert. This alone would have surfaced ISSUE-023 within two days.
6. **Monitored-group silence** *(from ISSUE-023)* — a `monitored` group with zero `messages` rows for 7+ days → alert. Catches "configured but not actually flowing."
Emit all to `data/health-metrics.jsonl` so B-phase work has a trend line.
**Acceptance:** inject a stuck-message batch → alert fires; set a group's `related_to` to junk → integrity check fires.
**Effort:** one weekend. **Depends:** none — parallel with A1.

---

## PHASE B — Fix what causes bad messages

### B1. Collapse the two delivery paths ⚠️ highest-impact single fix
**Why:** two independent readers of the notices queue:
- `triage-engine.js` (`*/15`) — claims via `send_attempted_at`, applies the 72h `sent_messages` window, `GROUP_DAILY_CAP = 3`, topic dismissals, quiet hours, thread-continuity downgrade.
- `noticeDelivery.js` via `deliver-batch.js` (07/12/16/20) — selects `delivery_status='pending' AND (triage_decision IS NULL OR triage_decision NOT IN ('skip','defer'))`. Has its own `isQuietHours()` and a cluster gate, but **no `send_attempted_at` check, no 72h context, no daily cap, no dismissal check.**

Overlap is `triage_decision IS NULL` — including notices triage claimed 90 seconds ago and is mid-LLM-call on. Every Phase 2.3 guardrail is bypassed four times a day. Violates P-001. Same structural bug as ISSUE-023, in the delivery layer.
**Do the merge:** make `deliverBatch()` a *formatter*. `triage-engine.js` becomes the only process calling `voiceSend`. The 07/12/16/20 digest becomes `TRIAGE_MODE=digest`, draining `triage_decision='defer'` rather than re-reading `pending`.
**Steps:** add **P-012** — *"Exactly one process calls `voiceSend` for the master group; `deliver-batch.js` and `deliver-immediate.js` are formatters invoked by triage, never independent readers"*; add the grep to `check-principles.js`; refactor; run 48h in `TRIAGE_SHADOW=true` and diff the shadow log against what was actually sent.
**Acceptance:** `crontab -l` shows one queue reader; P-012 passes; 48h of shadow log shows no notice ID in two distinct sent messages.
**Effort:** one weekend. **Depends:** A4.

### B2. Replace substring group-matching with a real column
**Why:** `triage-engine.js` identifies a past message's group via `s.message_text.includes(n.group_name.substring(0, 8))`. Hebrew class-group names share long prefixes (`הורי ו' בני` / `הורי ג'3`) → one group's cap suppresses another's. And when `synthesizeMessage()` omits the group name, the match returns nothing and `GROUP_DAILY_CAP` never fires. Over- and under-firing at once. The same anti-pattern is in the ISSUE-023 fallback at `whatsapp.js:1344` — fix both in one pass.
**Steps:** `ALTER TABLE sent_messages ADD COLUMN group_name TEXT` + index on `(group_name, sent_at)`; thread `groupName` through `saveSentMessage()`; replace both `.includes(...substring(0,8))` sites with equality; backfill from `source_notice_ids → notices.group_name`.
**Acceptance:** unit test with two groups sharing a 10-char Hebrew prefix — cap applies independently; test where the synthesized message omits the group name — cap still counts.
**Effort:** one evening. **Do this even if B1 slips.**

### B3. Time-granular staleness — "never send outdated messages"
**Why:** `getPendingNotices` gates on `relevance_date IS NULL OR relevance_date >= date('now','-1 day')`. The `-1 day` UTC fudge keeps *yesterday* eligible; `relevance_time` and `relevant_datetime` are selected but never used; and the budget-overflow path resets notices to `triage_decision=NULL` with no re-check on re-entry.
**Steps:** do the timezone conversion in JS against `Asia/Jerusalem` and drop the fudge; add a **send-time** staleness check immediately before `voiceSend` inside the merge-group loop (the query→send gap is up to 80s of LLM latency, which matters at boundaries) — deadline from `relevant_datetime`, else `relevance_date + relevance_time`, else end-of-day; on expiry set `triage_decision='skip', triage_reason='stale at send time', delivery_status='skipped'`; apply the same to the digest drain; add a `stale_at_send` counter.
**Acceptance:** `tests/regression/2026-XX-XX-stale-send-gate.js` — a notice dated today with a time 2h past is skipped; tomorrow's sends.
**Effort:** one weekend.

### B4. Quiet-hours hole for `immediate`
**Why:** the `immediates` loop calls `voiceSend` **before** the `isQuietHours()` block, which only demotes `send_now`. Intentional — but `computeUrgencyHint()` sets `immediate` from a keyword regex (`דחוף|ביטול|נדחה|סגור|…`) with no time bound. "הטיול נדחה" at 23:40 wakes the house.
**Steps:** record `urgency_source: 'keyword' | 'datetime'`; during quiet hours allow the bypass only when the datetime rule fired (event within ~3h); keyword-only immediates defer to the morning digest.
**Acceptance:** unit test at simulated 23:45 — keyword-only defers; datetime-driven (event 01:00) still sends.
**Effort:** one evening.

### B5. Tune dedup and escalation thresholds against A1 data
**Why:** `findDuplicates(..., threshold = 0.65)`, `ESCALATION_THRESHOLD = 0.6`, `ABSTENTION_THRESHOLD = 0.5` — plausible, unmeasured. Self-reported LLM confidence is poorly calibrated in general, so escalation may be firing at random.
**Steps:** `scripts/tune-thresholds.js` sweeping dedup 0.4→0.9 over labeled duplicate clusters, reporting P/R at each; plot reported `confidence` against gold-set correctness — if flat, escalate on *class* (all `send_now` → Sonnet) instead of confidence; commit chosen values with the numbers in a comment.
**On the 4GB-RAM note in `notice-dedup.js`:** lexical Jaccard is reasonable at that budget, but Hebrew morphology hurts it (`לגן`/`הגן`/`גן` are distinct tokens). Before reaching for embeddings, strip prefix letters ב/ל/כ/ה/ו/מ/ש when the remaining stem is ≥3 chars and occurs elsewhere in the corpus. Cheap, no dependency.
**Effort:** one weekend. **Depends:** A1.

### B7. One source of truth for group monitoring state
**Why:** `related_to TEXT` is a single overloaded column serving as a type enum (`monitored`/`master`/`ignored`) *and*, per ISSUE-023, a free-text child name, with no constraint preventing the latter.

**Reject the incident report's proposed Fix A.** It suggests:
```javascript
if (groupRecord && groupRecord.related_to && groupRecord.related_to !== 'ignored' && groupRecord.related_to !== 'master') return true;
```
This inverts monitoring from **opt-in to opt-out**. Any group with any junk value — a typo, a legacy value, an OpenClaw mistake — silently becomes monitored, and every message in it starts flowing to Claude. A cost and family-privacy regression traded for a one-line convenience. Making the reader permissive to compensate for a writer that corrupts the schema is backwards.

**Do this instead:**
1. Migration `007_group_monitoring.sql`: add `monitored INTEGER NOT NULL DEFAULT 0`; backfill `monitored=1 WHERE related_to='monitored'`; repurpose `related_to` for the *relationship* (child name / 'master' / NULL) — which is what both OpenClaw and Lipa intuitively wrote to it.
2. `isMonitoredGroup()` checks `groupRecord.monitored === 1` and nothing else. One condition, no heuristics.
3. Single sanctioned writer `setGroupMonitoring(id, {monitored, relatedTo, primaryChild, description})` that validates inputs. Deprecate raw `setGroupRelatedTo`.
4. **OpenClaw must not write to `groups` directly.** Expose the setter over the existing internal HTTP server (`voice-server.js:3001`) as a tool OpenClaw calls. This is the P-010 fix applied to config state: one owner, one API.
5. Startup assertion rejecting unknown `monitored` values.
**Acceptance:** `isMonitoredGroup()` has exactly one DB condition; no direct `UPDATE groups` outside `db.js`; A4 check #5 passes; the recovered group is monitored via the new column.
**Effort:** one weekend. **Depends:** H4 (repair first, then restructure).

### B8. Ban unvalidated agent writes to the schema
**Why:** the deeper lesson of ISSUE-023 isn't the regex — an LLM agent performed a direct DB write with a plausible-but-wrong column convention and nothing rejected it. That will recur in another table.
**Steps:** add **P-013** — *"OpenClaw and any agent write to SQLite only through sanctioned functions exported by `db.js` or endpoints on `voice-server.js`. Direct SQL from an agent session is forbidden."* Enumerate the allowed write surface. Add a nightly integrity job asserting enum-column sanity across `groups`, `notices.delivery_status`, `notices.triage_decision`, `messages.pipeline_state`; alert on out-of-vocabulary values.
**Acceptance:** insert a junk `pipeline_state` → nightly job alerts.
**Effort:** one evening.

---

## PHASE C — Cost, quality, and the questions you asked

### C1. Prompt caching on the classifier
Caching keys on the request prefix in the order **tools → system → messages**. Your classifier call is near-ideal: `GROUP_TOOLS` is a large static array and `buildGroupSystemPrompt` is mostly static, with only the date line, `recentCtx` and profile slice varying — yet all of it is re-billed at full rate on every group message.
**Steps:** reorder `buildGroupSystemPrompt` so static content comes **first** and volatile content last (cache breaks at the first difference — ordering is the whole game); add `cache_control` breakpoints after the tools block and after the static prefix; log `usage.cache_read_input_tokens` in `traceCall` and surface hit rate in A4 metrics.
**Acceptance:** cache reads > 0 on subsequent messages within the TTL window; measured cost per classified message drops. Verify against `platform.claude.com/docs/en/build-with-claude/prompt-caching`.
**Effort:** one afternoon. Best cost-to-effort ratio here.

### C2. Strict tool use / structured outputs
You already force `tool_choice:{type:'any'}` — most of the win. The API also documents **strict tool use** and **structured outputs**, enforcing schema at decode time rather than validating after. Your P-007 incident (`merge_group: null` on `send_now` → dead-letter notices) is exactly the class this removes. Enable on `GROUP_TOOLS`; keep `normalizeDecisions` as belt-and-braces.
**Effort:** one afternoon.

### C3. Hebrew audio — switch off vanilla Whisper
`media-parser.js` uses Groq `whisper-large-v3-turbo`, the generic multilingual model. ivrit.ai publishes Hebrew fine-tunes that are a documented, substantial improvement: `ivrit-ai/whisper-large-v3-ct2` (their stated SOTA) and `ivrit-ai/whisper-large-v3-turbo-ct2`, both CTranslate2 for faster-whisper. Their language detection and translation are degraded by the fine-tune — **set the language token to Hebrew explicitly.**
**Steps:** build 20 hand-transcribed voice-note fixtures from the archive; compare WER against current Groq; cross-check the ivrit.ai Hebrew Transcription Leaderboard on Hugging Face for the current best checkpoint. On 4GB, `large-v3` won't fit comfortably — use `turbo-ct2` int8 or keep it remote. Keep Groq as fallback; don't remove a working path until the replacement wins on fixtures.
**Acceptance:** WER improvement committed as `tests/eval/media/audio-wer.json`.
**Effort:** one weekend.

### C4. Media fixtures and success-rate measurement
The vision → Tesseract `-l heb` chain is structurally good but nothing measures how often each leg fires or succeeds. `media-archive.js` already stores the raw files — use them. 30 archived images (school notices, flyers, screenshots, photos-of-nothing) with expected extracted text; assert key fields; log which leg produced the answer; surface leg-level rates in health metrics.
**Effort:** one weekend.

### C5. Model routing — decide with the eval, not intuition
Current: `claude-haiku-4-5` for group and triage classification; `claude-sonnet-4-5` for escalation and synthesis; `claude-opus-4-6` referenced once; plus the Claude Code router. The split matches current best practice — light high-volume classification/extraction on the small tier, workhorse tasks on the mid tier, top tier for the hardest reasoning only. **Don't change models on vibes.** Once A1–A3 exist, run `run-eval.js --model` across Haiku and Sonnet on the gold set and let per-class F1 and cost decide. Expect "keep Haiku for classification, Sonnet for synthesis" — but now you'll know.
**Effort:** one evening once A2 lands.

### C6. Claude Code router — resolve the open question
`src/llm/router.js` routes eligible calls through the Claude Code CLI, commenting `inputTokens: 0, // no token charge — covered by Max subscription`. Two things to settle:
1. **Policy:** confirm that driving production bot traffic through a Claude Code subscription is within its terms. Check the current Claude Code docs and usage policy — don't infer it from the fact that it works. If it isn't, keep `CC_ENABLED` off for anything but interactive work.
2. **Correctness:** CC calls report zero tokens, so they're invisible to `TOKEN_LIMIT_DAILY` and to trace-based cost metrics. Any A4 cost dashboard will under-count whenever the router is on.
The circuit breaker and log-only dark-launch mode are well built — this is governance, not code quality.

---

## PHASE D — Proactivity and self-improvement (only after A and B)

### D1. Feedback loop that closes
👍/👎 on a bot message in the master group writes to `message_feedback`, keyed `sent_messages.id → source_notice_ids`. A weekly job turns each 👎 into a candidate gold row (`label_source:'human'`) after Aviv confirms the correct label in one line of chat. This is the only mechanism that grows the eval set toward your actual complaints rather than toward what the model already agrees with.
**Effort:** one weekend. **Depends:** A1.

### D2. Propose-and-approve loop
A scheduled Claude Code job reads 7 days of `llm-trace.jsonl`, `health-metrics.jsonl`, and 👎 feedback, then opens a **draft PR** doing exactly one of: add failing eval cases; propose a prompt/threshold diff with before/after eval numbers in the body; file an issue. Rails: draft PRs only, never merge, fine-grained PAT scoped to this repo, token budget cap, A3 gate must pass first.
**Hard rule:** the agent may never edit `PRINCIPLES.md` or `tests/eval/dataset.jsonl` labels — human-owned. Enforce in `check-principles.js`. **ISSUE-023 is the argument for this rule:** an agent already wrote to state it shouldn't have.
**Effort:** multi-week. **Depends:** A1–A4, D1.

### D3. Genuine proactivity (the "real assistant" ask)
Only after the above. Each must render through the `guardedSend` template path, never free-form LLM text:
- **Conflict detection** — new event overlapping an existing one for the same parent → ask before writing.
- **Unanswered-obligation nudge** — delivered notice with a deadline, never confirmed → one follow-up at T-24h.
- **Missing-info prompt** — event extracted without location/time, group later supplies it → offer to update, never silently rewrite.

Resist open-endedness. Lipa is trustworthy because `guardedSend` means it structurally cannot invent a reminder. Every proactive feature that bypasses templating trades that away.

---

## Priority order

1. **H1–H6** — hotfix phase, this week (H5 is a weekend; the rest are evenings)
2. **B2** — group-name column
3. **A1** — human-labeled gold set (expensive; nothing else is real without it)
4. **B7 + B8** — one source of truth for group state; ban raw agent writes
5. **B1** — collapse the dual delivery paths (your duplicates)
6. **B3** — send-time staleness gate (your outdated messages)
7. **A2 + A3** — real baseline + gating CI
8. **A4** — throughput and integrity health checks
9. **C1** — prompt caching (cheapest win)
10. Everything else

## Probably never — and that's fine
- Migrating to Claude Agent SDK / LangGraph. Confirmed by reading the code: no payoff for a single-call tool-forced extractor.
- WhatsApp Business Cloud API. Cannot read arbitrary existing family groups. Dead end.
- Local embedding models for dedup on a 4GB box. Try Hebrew prefix-stripping first (B5).
- Fine-tuning a Hebrew classifier. Only if the gold set proves frontier models are the bottleneck.
- Multi-box HA. A tested restore script beats a second box.

---

## Open risks

- **Third-party Baileys fork in the dependency tree.** `package.json` pins a second `baileys` entry to `github:doryani-ai/Baileys#fix/companion-reg-refresh`. Given the `lotusbail` incident — a trojanized Baileys fork on npm that stole WhatsApp auth tokens and session keys and exfiltrated messages and media — an unaudited fork with socket access is the riskiest line in the file. Audit its diff against upstream, pin to a **commit SHA not a branch** (branches can be force-pushed under you), and re-audit on every bump.
- **RC dependency in production.** `7.0.0-rc14` is a release candidate, and H5 exists because your shim over it is untested. Expect more compatibility defects; the shim suite is the mitigation.
- **Stale README.** Documents the removed library as the stack (H6).
- **WhatsApp ban risk.** Unofficial client, dedicated number. Keep re-provisioning scripted; accept the number can vanish.
- **Session and state backup.** Confirm `whatsapp-session/` and SQLite are backed up **off-box and encrypted** (`S3_BACKUP_BUCKET`). Test the restore, don't assume it.
- **Cost blind spot.** `TOKEN_LIMIT_DAILY` cannot see Claude Code-routed calls (C6).
- **Family data.** Every monitored group message reaches Anthropic; audio reaches Groq. B7 matters here too — an opt-out monitoring default would silently widen this exposure.

---

## Verification commands

```bash
# H1: quoted-reply IDs round-trip
node tests/regression/2026-08-30-quoted-reply-id.js

# H3: one question template, one extractor
grep -c "נוספתי לקבוצה" src/whatsapp.js          # expected: 1 (the helper)

# H5: shim suite exists and passes, including LID cases
node tests/shim/run.js && grep -rl "@lid" tests/shim/fixtures/ | wc -l   # expected: >0

# H6: library gone, router file untouched
npm ls whatsapp-web.js                            # expected: empty
test -f src/whatsapp.js && echo "router intact"   # expected: router intact

# B7: isMonitoredGroup has exactly one DB condition
grep -A6 "async function isMonitoredGroup" src/whatsapp.js | grep -c "related_to"
# expected: 0  (should read groupRecord.monitored)

# B8: no direct group writes outside db.js
grep -rn "UPDATE groups" --include=*.js . | grep -v node_modules | grep -v "src/db.js"
# expected: no output

# B1/P-012: exactly one queue reader that sends
grep -rln "posted_to_master\|delivery_status = 'pending'" --include=*.js src/ | xargs grep -ln "voiceSend\|sendToMasterGroup"
# expected: src/triage-engine.js only

# B2: no substring group matching anywhere
grep -rn "substring(0, *8)" --include=*.js src/
# expected: no output

# A1: gold set has no model-authored labels
node tests/eval/run-eval.js --dry-run --gold-only

# A3: eval gate wired to pull_request
grep -A3 "eval-gate" .github/workflows/ci.yml
```
