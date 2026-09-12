

# Consolidated Phase J Report — Digest Correctness

---

## 1. Root Cause

Both analyses converge on the same causal chain, differing only in emphasis:

**Primary cause:** Task A2 introduced a content-fallback cascade in `noticeSearch()` that widens the search window when the initial date-bounded query returns empty. This was correct for its original use case (a user *asking a question* about a child's schedule) but was applied unconditionally to all callers, including the digest generator. For the digest, an empty result on a Saturday is the correct answer. The fallback turns "nothing scheduled" into "here's stuff from the next 14 days," fabricating a wrong digest.

**Secondary cause:** Weekday correction (`nearestWeekdayIso`) runs on the parent `notices.relevance_date` but not on child `notice_event.event_date` rows. When a notice says "Tuesday September 12" (September 12 is Saturday), the notice gets corrected to September 15 but the event row keeps September 12. Parent and child disagree. The event surfaces in a Saturday digest where it doesn't belong, and is absent from Tuesday's digest where it does.

**Tertiary cause:** ~235 image-only notices (`[תמונה: ...]`) have `query_visible = 1` and leak into digests as 15+ lines of classroom photo descriptions with no actionable content.

**Latent bug:** `db.js:1218` and `:1223` hardcode `+03:00` for Israel timezone. Israel is UTC+2 from late October through late March. Every event expiry shifts by one hour during winter — events vanish an hour early on evening deadlines.

**Structural weakness:** `generate-digest.js` has no independent date filter. It renders whatever it receives. Every upstream retrieval bug passes through unchecked.

---

## 2. Solution — Merged Recommendations

### Conflicts between the two analyses and resolutions

| Topic | Architect Position | AI/LLM Position | Resolution |
|---|---|---|---|
| **How to gate the fallback** | Explicit `mode` parameter (`'question'` / `'digest'`), gate on `mode === 'question' && q` | LLM-derived intent classifier per request | **Architect wins.** The digest is not an LLM-driven caller — it's a cron job with a known, fixed intent. Adding a model hop to classify intent for a caller whose intent is hardcoded at compile time is pure overhead. The `mode` parameter is deterministic, testable, zero-latency, and covers both current callers. If a third caller arrives with ambiguous intent, revisit then. |
| **Weekday correction: fix in app code vs. push to LLM schema** | Keep `nearestWeekdayIso` in app code, extend it to event rows | Push date consistency into the LLM extraction layer via stricter JSON schema + re-prompt on mismatch | **Architect wins.** Source messages are internally inconsistent Hebrew text where senders routinely paste dates from prior years. The LLM cannot resolve an inconsistency in its own input — it will produce the same wrong date on re-prompt. The deterministic corrector exists, is tested, and runs in microseconds. The bug is that it runs on one table and not another. Fix the plumbing. However, **adopt the AI colleague's traceability suggestion**: add `weekday_he` to the extraction schema so the validator has the model's own weekday claim to compare against, improving detection accuracy. |
| **Image filtering: post-LLM regex vs. pre-LLM media-type filter** | Post-LLM regex guard (`query_visible = 0` for image content with no actionable fields) | Pre-LLM deterministic `mime_type` filter to skip the model entirely | **Compromise.** Use `mime_type` metadata to *tag* the message as image-origin before it hits the LLM, so the prompt can be explicit ("this is a photo — only call `add_notice` if you see a date, deadline, or instruction"). Keep the post-LLM `query_visible = 0` guard as belt-and-braces. Do NOT skip the LLM entirely — image captions can contain scheduling info. |
| **Continuous eval / golden dataset** | Mentioned (J1 step 4) but not expanded | Strongly advocated: 200-message labeled set, nightly runs, F1 alerting | **Adopt directionally, scope down for this phase.** A full nightly eval pipeline is out of scope for an incident fix. But every J-task must ship with its regression test, and J3 must add an image-classification eval case. Broader eval infrastructure is a follow-up. |

### Agreed points adopted without modification

- J4 (digest date discipline) ships in parallel with J1, not after it. It is the safety net.
- Error vs. empty must be distinguishable: `findUpcoming` catch block returns `matched_via: 'error'`, not silent empty array.
- `notice_event` rows for `query_visible = 0` notices must be audited and handled.
- Every PR includes its regression test. Tests must run in CI. If there's no CI, that's a prerequisite.
- Logging for weekday corrections with full context (notice ID, event title, raw date, corrected date).

---

## 3. Work Plan

### J1. Intent-gated retrieval
**When:** Day 1
**Files:** `voice-server.js`, `noticeSearch()` (wherever it's defined — likely `voice-server.js` or a router module), `generate-digest.js`
**Depends on:** Nothing

**Steps:**

1. **Add `mode` parameter to `noticeSearch()`:**
```javascript
function noticeSearch({ q, from, to, child, days, mode = 'question' }) {
  let results, matched_via;
  try {
    results = repo.findUpcoming({ from, to, childName: child });
    matched_via = results.length ? 'upcoming' : 'upcoming_empty';
  } catch (err) {
    console.error('[noticeSearch] findUpcoming failed:', err.message);
    return { results: [], matched_via: 'error', error: err.message };
  }

  if (!results.length && mode === 'question' && q) {
    try {
      results = repo.findByContent({ searchText: q, childName: child, daysBack: days || 14 });
      matched_via = results.length ? 'content_fallback' : 'content_empty';
    } catch (err) {
      console.error('[noticeSearch] findByContent failed:', err.message);
      return { results: [], matched_via: 'error', error: err.message };
    }
  }

  return { results, matched_via };
}
```

2. **Update `generate-digest.js`** to pass `mode: 'digest'`:
```javascript
const { results, matched_via } = await noticeSearch({
  from: targetDate, to: targetDate, mode: 'digest'
});
```
Handle `matched_via: 'upcoming_empty'` by rendering a clean "אין אירועים מתוכננים" section, not an empty block.
Handle `matched_via: 'error'` by rendering "לא הצלחתי לבדוק — נסה שוב" and alerting.

3. **Update `voice-server.js`:** Replace the comment at line 190 with:
```javascript
// J1: Fallback cascade is gated by mode. Only 'question' mode widens
// the search when the date window returns empty. 'digest' mode treats
// an empty window as the correct answer. See P-019, ISSUE-024.
```

4. **Check for index on `notices`:**
```sql
.indices notices
```
If `(query_visible, dismissed, created_at)` is missing, add migration:
```sql
CREATE INDEX IF NOT EXISTS idx_notices_visible_created 
ON notices(query_visible, dismissed, created_at);
```

5. **Write ISSUE-024 regression test** (`tests/regression/issue-024-cascade.js`):
   - Insert a test notice with `relevance_date` outside any date window but with content containing "כדורגל"
   - Call `noticeSearch({ q: 'כדורגל', mode: 'question' })` — assert it finds the notice via `content_fallback`
   - Call `noticeSearch({ from: '2026-09-12', to: '2026-09-12', mode: 'digest' })` — assert empty result, `matched_via: 'upcoming_empty'`

6. **Write digest date-window regression test** (`tests/regression/2026-09-12-digest-date-window.js`):
   - Seed DB with notices on Sept 10, 12, 14, 15
   - Request digest for Sept 12
   - Assert only Sept 12 notices returned (or empty if none exist for that date)

**Acceptance:**
```bash
curl -s 'localhost:3001/api/context?from=2026-09-12&to=2026-09-12' | \
  python3 -c "import json,sys;d=json.load(sys.stdin);assert d['matched_via']=='upcoming_empty';assert len(d['notices'])==0;print('PASS')"

curl -s 'localhost:3001/api/context?query=כדורגל&days=14' | \
  python3 -c "import json,sys;d=json.load(sys.stdin);assert d['matched_via'] in ('upcoming','content_fallback');assert len(d['notices'])>0;print('PASS')"

node tests/regression/issue-024-cascade.js
node tests/regression/2026-09-12-digest-date-window.js
```

---

### J4. Digest date discipline
**When:** Day 1, parallel with J1 (NOT dependent on it)
**Files:** `generate-digest.js`
**Depends on:** Nothing

**Steps:**

1. **Add independent date filter in `generate-digest.js`** after receiving notices from any source:
```javascript
const windowFrom = targetDate;  // ISO string, e.g., '2026-09-12'
const windowTo = targetDate;
const recentCutoffMs = Date.now() - 3 * 86400000; // 3 days for null-date notices
let droppedCount = 0;

const validNotices = attentionNotices.filter(n => {
  // Hard filter: notice with a date outside our window is wrong, regardless of source
  if (n.relevance_date && (n.relevance_date < windowFrom || n.relevance_date > windowTo)) {
    console.warn(`[digest] DROPPED notice ${n.id}: relevance_date ${n.relevance_date} outside [${windowFrom}, ${windowTo}]`);
    droppedCount++;
    return false;
  }
  // Null-date notices: only include if recently created
  if (!n.relevance_date && n.created_at < recentCutoffMs) {
    console.warn(`[digest] DROPPED notice ${n.id}: no date, created_at too old`);
    droppedCount++;
    return false;
  }
  return true;
});

if (droppedCount > 0) {
  console.warn(`[digest] Total dropped: ${droppedCount} notices outside date window — upstream contract may be broken`);
  // TODO: increment health metric counter here when metrics are available
}
```

2. **Write test** (`tests/regression/digest-independent-filter.js`):
   - Feed the digest function a result set containing notices with `relevance_date` values 5 days in the future
   - Assert they are filtered out
   - Assert drop count is logged

**Acceptance:** Feed a deliberately over-wide result set (notices spanning 2 weeks); digest renders only the target date's items; log shows drop count.

---

### J3. Image-only notice filtering
**When:** Days 2–3
**Files:** Agent group prompt, `agent.js`, `db.js` (migration for backfill)
**Depends on:** Nothing

**Steps:**

1. **Tag image-origin messages before LLM processing.** In the message preprocessing step (wherever WhatsApp messages are parsed before the agent prompt), add metadata:
```javascript
const isImageMessage = msg.mime_type?.startsWith('image/') || 
                       msg.type === 'image';
// Pass to prompt context:
messageContext.is_image_origin = isImageMessage;
```

2. **Update the group agent prompt** to include explicit image guidance:
```
When the message is a photo (is_image_origin = true):
- Only call add_notice if the image or its caption contains a specific date, time, 
  deadline, form link, or actionable instruction.
- Classroom activity photos (kids playing, sitting in class, doing crafts, Kahoot 
  screenshots without dates) are no_action.
- When in doubt about a photo, choose no_action.
```

3. **Post-LLM guard in `agent.js`** after `saveNotice()`:
```javascript
if (content.match(/^\[תמונה:/) && !content.match(/\d{1,2}[\/\.-]\d{1,2}|\d{1,2}:\d{2}|בשעה|עד ה?תאריך|deadline|due/i)) {
  db.prepare('UPDATE notices SET query_visible = 0 WHERE id = ?').run(noticeId);
  console.log(`[image-guard] notice ${noticeId} marked query_visible=0: image-only, no actionable content`);
}
```

4. **Audit `notice_event` rows for `query_visible = 0` notices:**
```sql
SELECT COUNT(*) FROM notice_event e 
JOIN notices n ON e.notice_id = n.id 
WHERE n.query_visible = 0;
```
If non-zero, ensure every downstream event query JOINs through notices with `query_visible = 1`, or cascade the flag.

5. **Backfill existing image-only notices:**
```sql
-- Dry run: count
SELECT COUNT(*) FROM notices WHERE content LIKE '[תמונה:%' AND query_visible = 1;
-- Should return ~235

-- Execute
UPDATE notices SET query_visible = 0 
WHERE content LIKE '[תמונה:%' 
  AND query_visible = 1
  AND content NOT GLOB '*[0-9][0-9]/[0-9]*'
  AND content NOT GLOB '*[0-9][0-9]:[0-9]*';

-- Verify
SELECT COUNT(*) FROM notices WHERE content LIKE '[תמונה:%' AND query_visible = 1;
-- Should be near 0 (some may have dates and correctly remain visible)
```

6. **Add eval case** to the existing gold set (or create one if none exists): a classroom photo message with caption "ילדים משחקים בהפסקה" must produce `no_action`. A photo with caption "טיול שנתי ב-15.10, נא לחתום" must produce `add_notice`.

**Acceptance:**
```bash
sqlite3 data/family.db "SELECT COUNT(*) FROM notices WHERE content LIKE '[תמונה:%' AND query_visible=1;"
# Returns 0 or near-0

# Run a digest — no image-description lines appear
```

---

### J2. Weekday correction for events
**When:** Weekend (days 4–5)
**Files:** `agent.js`, `db.js` (migration for new columns), `date-parse.js`
**Depends on:** Nothing (uses existing `nearestWeekdayIso`)

**Steps:**

1. **Add columns to `notice_event`** (migration in `db.js`):
```sql
ALTER TABLE notice_event ADD COLUMN event_date_raw TEXT;
ALTER TABLE notice_event ADD COLUMN event_date_source TEXT DEFAULT 'original';
```

2. **In `agent.js`, before `saveNoticeEvents()`**, apply weekday correction to each event:
```javascript
const { nearestWeekdayIso } = require('./date-parse');

const correctedEvents = action.events.map(ev => {
  const corrected = { ...ev, event_date_raw: ev.date, event_date_source: 'original' };
  
  if (ev.weekday_he && ev.date) {
    const fixed = nearestWeekdayIso(ev.weekday_he, ev.date, messageTimestamp);
    if (fixed !== ev.date) {
      console.log(`[weekday-fix] notice=${noticeId} event="${ev.event_title}" raw=${ev.date} corrected=${fixed}`);
      corrected.date = fixed;
      corrected.event_date_source = 'weekday_corrected';
    }
  } else if (dvResult.mismatch && ev.date === dvResult.rawDate) {
    // Inherit parent notice correction: same delta
    corrected.date = dvResult.correctedDate;
    corrected.event_date_source = 'weekday_corrected_inherited';
    console.log(`[weekday-fix] notice=${noticeId} event="${ev.event_title}" inherited correction: ${ev.date} → ${dvResult.correctedDate}`);
  }
  
  return corrected;
});

saveNoticeEvents(noticeId, correctedEvents);
```

3. **Update `saveNoticeEvents()` in `db.js`** to write `event_date_raw` and `event_date_source`.

4. **Add `weekday_he` to the event extraction schema** (the AI colleague's traceability point). In the tool schema for `add_notice`:
```json
"events": [{
  "date": "2026-09-15",
  "weekday_he": "שלישי",
  "event_title": "..."
}]
```
This gives the validator the model's own weekday claim to compare against, improving detection without adding model hops.

5. **Backfill future-dated mismatched events:**
```sql
-- Identify
SELECT e.id, e.event_date, n.relevance_date, n.relevance_date_source
FROM notice_event e
JOIN notices n ON e.notice_id = n.id
WHERE n.weekday_mismatch = 1
  AND e.event_date >= date('now')
  AND e.event_date != n.relevance_date;
```
For each, apply the parent notice's correction delta. Log every change.

6. **Regression test** (`tests/regression/weekday-correction-events.js`):
   - Create a notice where the text says "Tuesday" but the date resolves to Saturday
   - Assert both `notices.relevance_date` and `notice_event.event_date` are corrected to Tuesday
   - Assert `event_date_source = 'weekday_corrected'`
   - Assert `event_date_raw` preserves the original

**Acceptance:**
```bash
sqlite3 data/family.db "SELECT n.id, n.relevance_date, n.relevance_date_source, e.event_date, e.event_date_source, e.event_title FROM notices n JOIN notice_event e ON e.notice_id=n.id WHERE n.id=2807;"
# relevance_date = 2026-09-15, event_date = 2026-09-15, both sources show correction
```

---

### J5. Fix hardcoded `+03:00`
**When:** With C1
**Files:** `db.js`
**Depends on:** C1 (single date utility)

**Steps:**

1. Replace `db.js:1218` and `:1223` — change `+03:00` to use `israelDateIso`/`israelNowParts` from `timeUtils.js`.

2. Audit all `created_at` comparisons against `Date.now()` — verify they compare the same type (both epoch ms, or both ISO strings). Specifically check the `cutoffMs` calculation in `NoticeRepository.findUpcoming()` and `findByContent()`:
```bash
grep -n "Date.now()" src/notice-repository.js src/db.js
grep -n "created_at" src/notice-repository.js
```
If `created_at` is stored as epoch ms, the comparison is fine. If ISO string, it's broken.

3. **Test:** Set system clock to a winter date (or mock `Date.now`), create an event with an evening deadline, verify expiry is correct.

**Effort:** 20 minutes once C1 lands.

---

## 4. Risks & Open Questions

### Confirmed Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **ISSUE-024 regression.** J1 changes the same code path that A2 fixed. Without a pinning test, we could silently reintroduce the original bug where "מה יש לנבו ביום ראשון?" returns nothing. | **High** | J1 step 5 is non-negotiable. The regression test ships in the same PR as the fix. |
| **No CI pipeline.** Tests exist but may not run automatically. Every incident fix that adds a test without CI is a test that will be ignored. | **High** | Before merging J1, confirm tests run in CI. If no CI exists, set up a minimal `npm test` script that runs the regression suite, and a pre-push hook. This is a prerequisite, not a follow-up. |
| **Backfill side effects (J2, J3).** Bulk-updating `event_date` and `query_visible` on production data could fix some rows and break others. | **Medium** | Run backfills with `--dry-run` first. Log every change. Run backfills in a transaction with a verification query before commit. Take a DB backup before each backfill. |
| **`findUpcoming` silently swallows errors.** The catch block returns `[]`, indistinguishable from "nothing found." If the DB is locked, the digest says "nothing scheduled" instead of "I couldn't check." | **Medium** | J1 step 1 propagates `matched_via: 'error'`. Digest renders an explicit failure message. |
| **`notice_event` rows leaking through non-repository paths.** If any code queries `notice_event` directly (not through `NoticeRepository`), `query_visible` filtering is bypassed. | **Medium** | J3 step 4 audits this. Run: `grep -rn "notice_event" src/ scripts/ --include='*.js'` and verify every query joins through notices or applies its own filter. |
| **Winter timezone bug (J5).** Every event expiry is 1 hour off from late October. Events with evening deadlines vanish at 23:00 instead of midnight. | **Low now, high in October** | J5 ships with C1. If C1 is delayed past October, decouple J5 and ship independently. |

### Open Questions Requiring Investigation

1. **What type is `created_at` in the notices table?** If epoch ms, the `Date.now()` comparison in `findUpcoming` is correct. If ISO string, it's silently wrong and every recent-notice fallback is unreliable. Check:
```sql
SELECT typeof(created_at), created_at FROM notices LIMIT 5;
```

2. **Does any code path query `notice_event` without joining through `notices`?** If so, image-only events leak through a back channel that J3 doesn't close.
```bash
grep -rn "notice_event" src/ scripts/ --include='*.js' | grep -v "JOIN notices"
```

3. **How many notices have `weekday_mismatch = 1` with future events?** This determines backfill scope for J2.
```sql
SELECT COUNT(*) FROM notices n 
JOIN notice_event e ON e.notice_id = n.id 
WHERE n.weekday_mismatch = 1 AND e.event_date >= date('now');
```

4. **Is there an existing eval/gold set for agent extraction accuracy?** J3 step 6 and the broader eval recommendation both depend on this. If none exists, the first iteration is manual: 20 labeled messages, not a pipeline.

5. **What is the `surfacedNoticeIds` source in `generate-digest.js:213`?** The description says there's no date filter, but it's unclear whether `surfacedNoticeIds` comes from the `/api/context` endpoint (affected by J1) or from a direct DB query (unaffected). Check the data flow to confirm J4's filter is positioned correctly.

---

### Principle to Record

**P-019 — A fallback must be conditioned on the caller's intent, not on the first attempt returning empty. An empty result is a valid answer to a bounded query.**

Corollary: when a fix changes shared retrieval behavior, the incident that motivated it gets a regression test in the same PR. This is the second time this code path has broken because the first fix had no pinning test.