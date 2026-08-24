# Technical Review & Work Plan — FamilyBot ("Lipa") WhatsApp Family Assistant

## TL;DR
- **Your architecture is fundamentally sound for what it is; your problem is not the harness or the models — it's that you have no eval set and no liveness monitoring, which is the single root cause behind at least 5 of your 8 pain points.** Build a labeled eval harness and a dead-man's-switch monitor *before* touching classification, models, or the harness.
- **Keep the custom harness.** `agent.js` is a single-call action-extractor/classifier, not an open-ended agent; the 2026 consensus is that you should *not* wrap that in Claude Agent SDK or LangGraph. Adopt three specific *pieces* instead — LLM tracing (Langfuse/OTel), an eval framework (Promptfoo + DeepEval), and a heartbeat monitor (healthchecks.io) — not a rewrite.
- **The things you should genuinely worry about are operational, not architectural:** WhatsApp ban risk on Baileys, single EC2 box with no auth-session backup, and Hebrew media handling (use ivrit.ai Whisper for voice, a vision-capable model for images). Your model choice (Haiku for extraction) is defensible; whether it's *right* is exactly what an eval set will tell you.

---

## Key Findings

1. **Access caveat (read this first).** I read the full README, module map, architecture diagram, ops/cron setup, env vars, and testing conventions from the repo root page. GitHub's raw-file and API endpoints were blocked by my fetch tooling, and a dedicated sub-agent confirmed the repo is too new/unindexed to surface file URLs through search. So critiques of *internal* logic (`calendarGate.js`'s 4 stages, the `agent.js` prompt text, retry code, exact model IDs, `PRINCIPLES.md`) are **inferred from the README's descriptions plus your Part B notes, not line-by-line reading**. I flag every inference. The single highest-value thing you can do to sharpen this report is paste the contents of `PRINCIPLES.md`, `agent.js`, `calendarGate.js`, and `triage-engine.js` for a second pass. Note one discrepancy worth confirming: the `main` branch README documents the stack as **whatsapp-web.js**, while you say the current running code is the Baileys migration on the `pre-baileys` branch — the branch divergence is real and `main` is stale.

2. **This is a classifier/extractor pipeline, not an agent.** Flow: `whatsapp.js` (`client.on('message')`) → `agent.js` (Claude Haiku emits action blocks like `add_event`, `add_notice`) → `calendar.js`/`db.js` (SQLite) → `triage-engine.js` (`*/15` cron) batches notices to the master group → 7:00 AM daily digest. Reminders via poll-based `scheduler.js` (explicitly "no setTimeout"). Outbound via internal HTTP `voice-server.js` on :3001. This is a good, legible design.

3. **The custom harness is the right call, per current best practice.** The 2026 guidance is explicit: skip an agent harness entirely when "a single model call with the tool runner in the regular Anthropic client SDK does the job — classification, extraction, a two-tool lookup. An agent harness is overhead there." [Developers Digest](https://www.developersdigest.tech/blog/claude-agent-sdk-vs-langgraph) Your `agent.js` is exactly that case. Migrating to Claude Agent SDK or LangGraph would be a rewrite that buys you little and costs you your legibility.

4. **The root cause of "never good enough" is unmeasurability.** You have no labeled dataset of past messages with known-correct priority/alert decisions, therefore no way to measure classification precision/recall, therefore no way to know if a prompt change or model swap helped or hurt, therefore no confidence in any of it. Pain points #4 (triage), #5 (media + alert reliability), #7 (model choice), and #8 (general unease) all reduce to this. Fix measurement first.

5. **WhatsApp/Baileys is your biggest operational risk and there is no compliant alternative for your use case.** Reading arbitrary existing family/school WhatsApp *groups* is only possible via unofficial libraries (Baileys/whatsapp-web.js). The official WhatsApp Business Cloud API cannot do it (its 2026 Groups API is limited to Official Business Accounts, caps groups at 8 participants, and is built for business-created rooms — not for silently reading your kids' school group). Worse, Meta's updated WhatsApp Business Solution Terms — effective **January 15, 2026** (immediate for accounts registered on/after Oct 15, 2025), per TechCrunch — state that "AI Providers…are strictly prohibited from accessing or using the WhatsApp Business Solution…when such technologies are the primary…functionality being made available." That ban forced OpenAI, Perplexity and Microsoft to shut down their WhatsApp chatbots and triggered antitrust probes in the EU, Italy and Brazil, effectively leaving Meta AI as the only general-purpose assistant allowed on the platform. So Baileys is your only path — but it carries a real, unpredictable ban risk, and you must harden session persistence and backups accordingly.

---

## Details by Subsystem

### Architecture (what it actually is)
A single Node.js process under PM2 (`besinsky-bot`/`familybot`) on one AWS EC2 Ubuntu box. WhatsApp connectivity via Baileys (migrated from whatsapp-web.js; the `pre-baileys` branch despite its name is the current running code). Claude Haiku does per-message action extraction. State in SQLite plus `data/dm-history.jsonl`. Two out-of-PM2 cron jobs: triage every 15 minutes and a SQLite backup at 03:00. A separate babysitter-booking microservice and a self-hosted OpenClaw instance share the box; OpenClaw's WhatsApp channel handles conversational replies in the master group while the bot's own master-group command handler is a deliberate no-op. Persona "Lipa"; command channel is the master WhatsApp group (`MASTER_GROUP_JID`), not DMs.

### What is genuinely good (stop worrying about these)
- **Poll-based scheduler, not `setTimeout`.** This is the correct choice for an always-on process that can restart; timers don't survive restarts, DB-polled reminders do. Keep it.
- **The `TRIAGE_SHADOW` flag.** You already have a dry-run mode for the triage engine. This is exactly the primitive needed for safe deploys and replay evals — most hobby projects lack it. Build on it.
- **Separation of ingestion, extraction, dedup, and delivery into distinct modules.** `calendarGate.js` being separate from `calendar.js` is good hygiene.
- **PII discipline.** `.gitignore` for secrets/session/DB, `scripts/detect-pii.js` as a pre-commit check, gitignored `config/groups.json` and `family-seed.json`. This is better than most personal projects.
- **Regression-test convention** (`tests/regression/YYYY-MM-DD-description.js` with mock LLM). The scaffold exists; it's just thin.
- **Single-model default (Haiku).** Using the cheapest capable tier for high-volume extraction is the correct instinct. Haiku 4.5 is confirmed by Anthropic at **$1 per million input / $5 per million output tokens** (model ID `claude-haiku-4-5-20251001`; 200K context, cache reads $0.10/MTok, 50% batch discount). For per-message classification this is right. Don't reflexively "upgrade."

### Message triage / classification / dedup (pain points #4, #5)
This is the weakest subsystem *in verifiability*, not necessarily in design. Best-practice architecture for reliable notification triage in 2026 is a **rules + LLM hybrid with a cascade/router**: cheap deterministic rules first (known-sender allowlists, keyword/regex for dates, times, money, "urgent"/"מחר"/"היום"), then a cheap LLM classifier (Haiku) with **structured/constrained output** for the category + a **confidence score**, and **escalation to a stronger model only on low confidence or abstention**. Confidence thresholds with an abstention class ("not sure → batch, don't drop") are the standard way to trade off precision vs. recall. For dedup, the standard toolkit is embedding cosine-similarity within a time window plus MinHash/SimHash for near-duplicates and thread/conversation grouping — the same pattern PagerDuty (`dedup_key`) [Knowledge Base](https://support.pagerduty.com/main/docs/event-management) and Opsgenie use to collapse repeated alerts. Your `calendarGate.js` 4-stage gate is the right idea; the question an eval set answers is whether its thresholds are tuned.

Commercial cautionary tale: **Apple Intelligence's notification summaries** shipped, then were paused for news/entertainment apps on **January 16, 2025 (iOS 18.3 beta)** after generating false summaries — the BBC complaint centered on a summary falsely stating that accused UnitedHealthcare-CEO killer "Luigi Mangione shoots himself," plus false alerts that Luke Littler won the PDC World Darts Championship and that Rafael Nadal came out as gay. The lesson directly applies to you: summarizing/merging short group messages without conversation context produces confident, wrong outputs. Keep source text attached, don't over-merge across threads, and mark AI-generated summaries as such.

### Hebrew-language quality (cross-cutting)
Hebrew is a morphologically rich language and hurts every naive NLP step. For classification, frontier Claude models handle Hebrew well, but small/local classifiers need Hebrew-aware embeddings — **BGE-M3**, **multilingual-E5**, **LaBSE**, or **AlephBERT** are the Hebrew-capable options; Nomic Embed v2 is a lower-cost multilingual choice. [PE Collective](https://pecollective.com/tools/best-embedding-models/) This matters for embedding-based dedup and any future fine-tuned classifier.

### Multimodal handling (pain point #5)
Media reliability is your most concrete, fixable complaint. Best practice is an explicit, testable fallback chain per media type, not "hope the model reads it":
- **Voice notes (Hebrew):** the ivrit.ai fine-tuned Whisper models (e.g. `ivrit-ai/whisper-v2-d3-e3`, [GitHub](https://github.com/ShmuelRonen/hebrew_whisper) `ivrit-ai/whisper-large-v3`) materially outperform vanilla Whisper on Hebrew (independent testing found the ivrit.ai models a "major leap forward" over vanilla Whisper); run via faster-whisper. [Medium](https://medium.com/@DormanDaniel/comparing-whisper-whisper-ft-and-amazon-transcribe-for-hebrew-e297846bdd24) Fall back to a cloud ASR (e.g. Amazon Transcribe, which also tested well for Hebrew) if local fails.
- **Images (Hebrew school notices/flyers — your most common case):** a vision-capable model first, with an OCR fallback (PaddleOCR/Tesseract with Hebrew, or cloud OCR) when the vision call fails or returns low text.
- **PDFs:** extract text layer first; OCR only if it's a scan.
- Make each step deterministic and independently testable with fixture files, and log which path was taken so you can measure success rate.

### Model selection & routing (pain point #7)
Current Claude lineup (August 2026): Haiku 4.5 ($1/$5), Sonnet 5 ($2/$10 — but note this is **introductory pricing through August 31, 2026, reverting to $3/$15** afterward), Opus 5 ($5/$25), Fable 5 ($10/$50). Recommended split for your workload: **Haiku for per-message extraction/classification** (high volume, cost-sensitive); **escalate to Sonnet only on low-confidence** classifications and for the **daily digest summarization** (lower volume, quality matters, and Sonnet's Hebrew is stronger); reserve Opus for nothing in this system. The right way to decide is not intuition but a **model-matrix eval** (Promptfoo runs the same test set across [DeepEval](https://deepeval.com/blog/top-5-llm-evaluation-frameworks) Haiku/Sonnet and reports accuracy + cost), so you buy quality only where it pays.

### Observability (pain point #2)
You have essentially no way to know the bot is *silently* broken — session dropped, messages received but skipped, or no alerts fired because nothing was classified high-priority. Two layers fix this:
- **LLM tracing:** Langfuse (open-source, self-hostable, ingests OpenTelemetry GenAI semantic conventions on its OTLP `/api/public/otel` endpoint) or Phoenix/Arize. Trace every classification with input, output, model, tokens, cost, latency. (Note the OTel GenAI conventions are still in "Development"/experimental status as of mid-2026, so pin your instrumentation and expect attribute-name churn.)
- **Infra + liveness:** a **dead-man's-switch** via healthchecks.io — the bot pings a URL on each successful triage run and message-poll; *absence* of the ping is the alert [Healthchecks](https://healthchecks.io/docs/) (catches the silent failures that threshold alerts miss, because a query that returns empty rather than zero never fires). Add **expected-output-volume anomaly detection**: if messages-ingested/day drops to ~0 or alerts-fired/day deviates far from baseline, page yourself. Uptime Kuma or CloudWatch alarms cover the box; PM2 already restarts the process.

### Commits / testing / safe deploy (pain point #1)
"Things break and tests don't catch it" is a direct consequence of tests using a mock LLM and having no eval set exercising real classification. The fix ordering: (a) build the eval set, (b) gate commits on it in GitHub Actions (use tolerance bands, pin the judge model, and use a stable golden set so non-determinism doesn't cause flaky CI), (c) use your existing shadow mode + a replay harness so you can run a proposed change over yesterday's real messages and diff the decisions before deploying. Add pre-commit hooks (the `detect-pii.js` check plus lint), a kill switch env var, and health-check-triggered rollback (PM2 reload + revert on failed heartbeat).

### Self-improvement with approval (pain point #3)
The pattern you want exists off-the-shelf and is safe: agents that **propose a diff, a human approves, and a draft PR opens** — never auto-merge. `anthropics/claude-code-action` (v1) responds to issues/PRs and opens PRs but does not merge by default; [Groundy](https://groundy.com/articles/how-to-run-claude-code-as-a-github-actions-agent-for-automated-pr-fixes/) `BerriAI/self-improving-agent` is a drop-in two-tool loop (propose → approve → draft PR) that plugs into the Claude Agent SDK. [GitHub](https://github.com/BerriAI/self-improving-agent) Concretely: a scheduled Claude Code job reads the day's traces + any thumbs-down feedback, and for recurring failures either opens a PR adding an eval case or proposes a prompt/threshold tweak — you approve in chat or on GitHub. Rails: PR-only writes, fine-grained PAT scoped to one repo, budget caps, sandbox.

### The harness question (pain point #6)
Keep it. The decision framework from the 2026 literature: LangGraph wins when the hard problem is durable, resumable, approval-aware *workflow*; Claude Agent SDK wins when the agent is "Claude working in a repo/filesystem." [Developers Digest](https://www.developersdigest.tech/blog/claude-agent-sdk-vs-langgraph) Neither describes a per-message classifier. What you're missing isn't a harness — it's the cross-cutting pieces (tracing, evals, durable retries for the media chain). Adopt those pieces; don't rewrite the loop.

---

## Root-Cause Analysis of the 8 Pain Points

| # | Complaint | Underlying cause | Shared root |
|---|-----------|------------------|-------------|
| 1 | Commits break things, tests don't catch | Tests mock the LLM; no eval set on real classification | **No eval harness** |
| 2 | Monitoring insufficient, I catch things manually | No tracing, no dead-man's switch, no volume anomaly alert | **No observability** |
| 3 | System won't self-initiate improvements | No propose-and-approve loop wired to logs/feedback | Needs #1+#2 first |
| 4 | Triage/dedup never good enough | Can't measure precision/recall, so can't tune thresholds | **No eval harness** |
| 5 | Media reading + alert timing unreliable | No explicit fallback chain; no labeled outcomes | **No eval harness** + media chain |
| 6 | Don't know if custom harness is right | It is right; you just lack the tracing to see it work | Perceived, not real |
| 7 | Multiple models, unsure choices are right | No model-matrix eval comparing accuracy/cost | **No eval harness** |
| 8 | General "not good enough" | Sum of the above; anxiety from flying blind | **No measurement** |

Five of eight collapse into one sentence: **you cannot measure classification/alert quality, so you cannot improve it or trust any decision about it.** That is why everything "feels" wrong. Build measurement first and most of the anxiety becomes a tractable number you can move.

---

## Recommendations with Tradeoffs

- **Harness: KEEP the custom one.** Reasoning: it's a single-call extractor, not an agent; a rewrite risks regressions and costs legibility. Cost: ~0. Counter-argument: if you later add genuinely multi-step, long-horizon autonomous tasks, revisit LangGraph for durable execution — but not now.
- **Models: Haiku default, Sonnet on low-confidence + digest.** Reasoning: cost-optimal with quality where it matters; Sonnet's Hebrew is stronger for summaries. Cost: a few dollars/month more. Counter-argument: if an eval shows Haiku's Hebrew classification is weak, promote the default to Sonnet — let the eval decide, don't guess. (Budget note: Sonnet's introductory $2/$10 ends Aug 31, 2026 → $3/$15.)
- **Eval framework: Promptfoo (model-matrix + CI) + DeepEval (pytest-style CI gate).** Reasoning: Promptfoo is purpose-built [Inference](https://inference.net/content/llm-evaluation-tools-comparison/) for multi-model comparison with YAML configs and is Node-native (fits your stack); DeepEval integrates as a per-PR regression gate. [Aiml](https://aiml.qa/llm-evaluation-framework-benchmark-2026/) Both are open-source and local — no data leaves your box beyond the model calls you already make. Cost: your time to build the labeled set (the real work) + a few dollars of eval-run tokens. Counter-argument: Braintrust [AGILE LEADERSHIP DAY](https://agileleadershipdayindia.org/blogs/ai-evals-engineer-discipline-hub/deepeval-vs-langfuse-vs-braintrust-comparison.html) is more polished but commercial and adds lock-in; skip it for a solo project.
- **Observability: Langfuse (self-hosted) + healthchecks.io.** Reasoning: Langfuse is the OSS leader, self-hostable on your box, OTel-native; healthchecks.io gives you the dead-man's switch cheaply (free tier or self-host). Cost: modest RAM for Langfuse. Counter-argument: Langfuse adds a service to maintain; if that's too much, start with structured JSON logs + healthchecks.io and add Langfuse later.
- **Dedup: keep `calendarGate.js`, add embedding+time-window near-dup detection for notices.** Reasoning: exact/structured dedup for calendar, semantic dedup for free-text notices. Cost: one embedding model (BGE-M3 local or a cheap API). Counter-argument: if notice volume is low, a simpler normalized-text hash within a time window may suffice — measure first.
- **WhatsApp: stay on Baileys, harden it.** Reasoning: no compliant alternative can read your groups. Cost: session backup + reconnection/backoff work. Counter-argument: none viable — the Cloud API genuinely cannot read arbitrary existing family groups.

---

## Prioritized Work Plan (save as `WORKPLAN.md`, hand to Claude Code / OpenClaw)

### Phase 0 — Foundation: measurement before refactor (do this first)
**0.1 Build a labeled eval set from real traffic.** *Goal:* a golden dataset of ~200–500 historical messages (from `data/dm-history.jsonl` / SQLite) each labeled with correct category, priority (real-time / batch / archive), and expected action. *Why:* unblocks everything below; directly attacks pain points #1, #4, #7, #8. *Steps:* export N days of messages; hand-label (or bootstrap-label with Sonnet then human-correct); store as JSONL fixtures; include Hebrew media cases. *Files:* `tests/eval/dataset.jsonl`, `scripts/export-eval-set.js`. *Acceptance:* dataset loads and covers all categories including media. *Effort:* multi-weekend (labeling is the cost). *Unblocks:* 0.2, 0.3, all of Phase 2.

**0.2 Wire Promptfoo model-matrix + DeepEval CI gate.** *Goal:* run classification over the golden set across Haiku vs Sonnet, report precision/recall/cost. *Why:* answers "are the model choices right?" with numbers (pain #7). *Steps:* Promptfoo YAML pointing at `agent.js`'s prompt + dataset; DeepEval assertions for the CI gate; add to `.github/workflows`; use tolerance bands + pinned judge model to avoid flaky CI. *Files:* `promptfooconfig.yaml`, `tests/eval/*.js`, workflow YAML. *Acceptance:* CI fails if classification accuracy drops below a tolerance band. *Effort:* weekend. *Depends:* 0.1.

**0.3 Heartbeat + volume-anomaly monitoring.** *Goal:* know within minutes when the bot is silently broken. *Why:* pain #2. *Steps:* ping healthchecks.io on each successful message-poll and triage run; add a daily check that messages-ingested and alerts-fired are within expected bounds and alert if ~0. *Files:* `whatsapp.js`, `triage-engine.js`, `scripts/volume-check.js`, crontab. *Acceptance:* kill the process / drop the session in a test → you get paged. *Effort:* weekend. *Unblocks:* 3.x.

### Phase 1 — Reliability hardening
**1.1 Deterministic media fallback chains.** *Goal:* voice → ivrit.ai Whisper (faster-whisper) with cloud fallback; images → vision model with OCR fallback; PDFs → text-then-OCR. *Why:* pain #5. *Files:* `src/media/*.js`, fixtures in `tests/eval/media/`. *Acceptance:* fixture-based tests show ≥ target success rate per type; each run logs the path taken. *Effort:* multi-week. *Depends:* 0.1.

**1.2 Baileys session backup + reconnection/backoff.** *Goal:* survive disconnects and box loss. *Steps:* encrypted backup of the auth session to S3 (`S3_BACKUP_BUCKET`); exponential backoff on reconnect; handle LID→phone resolution explicitly (a known Baileys 7.x pain point). *Files:* `whatsapp.js`, `scripts/backup-session.sh`. *Acceptance:* restore session from backup on a fresh box without re-scanning QR. *Effort:* weekend.

**1.3 Langfuse tracing.** *Goal:* every classification/summarization traced (input, output, model, tokens, cost, confidence). *Files:* `agent.js`, `triage-engine.js`. *Acceptance:* traces visible; can filter low-confidence and errors. *Effort:* weekend.

### Phase 2 — Triage quality (now measurable)
**2.1 Rules + LLM cascade with confidence + abstention.** *Goal:* deterministic rules first, Haiku classifier with structured output + confidence, escalate to Sonnet on low confidence, abstain-to-batch when unsure. *Files:* `agent.js`, `triage-engine.js`. *Acceptance:* eval precision/recall improve vs. baseline with no drop in recall on high-priority. *Effort:* multi-week. *Depends:* 0.1, 0.2, 1.3.

**2.2 Semantic dedup for notices.** *Goal:* embedding cosine similarity within a time window (BGE-M3) plus normalized-text hashing; thread grouping. *Files:* `calendarGate.js` or new `dedup.js`, `db.js`. *Acceptance:* eval on duplicate clusters shows fewer double-alerts, no missed distinct events. *Effort:* multi-week. *Depends:* 0.1.

**2.3 Notification timing / quiet hours / feedback loop.** *Goal:* real-time vs. batch thresholds, quiet hours, and thumbs-up/down on alerts feeding threshold tuning. *Files:* `triage-engine.js`, `db.js` (feedback table). *Acceptance:* feedback recorded and visible in evals. *Effort:* weekend–multi-week.

### Phase 3 — Self-improvement (only after Phases 0–2)
**3.1 Propose-and-approve loop.** *Goal:* a scheduled Claude Code job reads traces + thumbs-down, and for recurring failures opens a **draft PR** adding an eval case or proposing a prompt/threshold change. *Steps:* use `anthropics/claude-code-action` or `BerriAI/self-improving-agent`; PR-only, fine-grained PAT, budget cap. *Files:* `.github/workflows/self-improve.yml`, `scripts/triage-failures.js`. *Acceptance:* a synthetic failure produces a draft PR you can approve. *Effort:* multi-week. *Depends:* 0.1–0.3, 1.3.

### Probably never (and that's fine)
- Migrating to Claude Agent SDK/LangGraph — no payoff for a single-call extractor.
- WhatsApp Business Cloud API — cannot read your groups; dead end.
- Fine-tuning a custom Hebrew classifier — only if evals prove frontier models are the bottleneck, which is unlikely.
- Multi-box HA / Kubernetes — overkill for a family bot; a good backup + fast rebuild script beats it.

---

## Follow-up Questions for Aviv (answerable by inspecting the running system)
1. How many messages/day across how many monitored groups (and the distribution — which groups dominate)?
2. What % of messages currently trigger a real-time alert vs. batch vs. archive?
3. What are the exact model IDs per call site in `agent.js`/`triage-engine.js`, and the monthly Anthropic token spend broken down by call site?
4. Is there *any* labeled data on past alerts being right or wrong (even ad-hoc "that was wrong" notes)?
5. What's the current measured media-handling success rate — of images/voice notes received, what fraction are actually read successfully today?
6. How often does the Baileys session drop or need a re-scan, and how do you currently find out?
7. What does `calendarGate.js` actually check in each of its 4 stages, and how often does it reject a real event (false dedup) vs. let a duplicate through?
8. What is `TOKEN_LIMIT_DAILY` set to, and has it ever been hit?
9. Is the WhatsApp auth session currently backed up anywhere off-box? Is the SQLite backup to S3 actually enabled and encrypted?
10. What confidence/threshold values (if any) does the current classifier use, or is it a single unconditioned Haiku call?

---

## Open Risks (things that could bite you)
- **WhatsApp account ban.** Baileys is an unofficial, ToS-violating linked-device client; bans are real and unpredictable (industry write-ups report unofficial-tool accounts banned within 2–8 weeks [Kraya](https://blog.kraya-ai.com/whatsapp-automation-ban-risk) in some cases, or running for months in others — there is no predictable pattern). Mitigations: use a dedicated number you don't care about (you do), human-like pacing, no bulk sends, keep the OpenClaw conversational replies low-volume. Accept that the number can vanish and script re-provisioning.
- **npm supply-chain risk in the WhatsApp ecosystem.** `lotusbail` — a trojanized fork of `@whiskeysockets/baileys` with 56,000+ downloads that sat on npm for ~6 months (disclosed by Koi Security, reported Dec 2025 by BleepingComputer/The Hacker News) — "could steal WhatsApp authentication tokens and session keys, intercept and record all messages…and exfiltrate contact lists, media files, and documents," abusing multi-device pairing for persistent backdoor access. Pin dependencies, audit anything claiming to be "anti-ban," and never add a package that wants socket/session access.
- **Single point of failure on one EC2 box.** No redundancy. Mitigate with off-box encrypted backups of the auth session and SQLite, plus a scripted rebuild.
- **No backups of auth session / state (verify).** If the box dies, you re-scan QR and may lose history. Fix in task 1.2.
- **Secrets.** `.env`, `credentials.json`, `token-*.json` are gitignored — good — but verify they're not in any backup that lands in a public bucket, and confirm S3 backups are encrypted.
- **Cost blowups.** A prompt loop or media-retry storm could spike tokens; `TOKEN_LIMIT_DAILY` exists — make sure it hard-stops and alerts at 80%.
- **Privacy of family data to model providers.** Every monitored group message (kids' school info, neighbors, family) flows to Anthropic (and to Whisper/vision providers if cloud). Prefer local ivrit.ai Whisper for audio, minimize what's sent, and document this for your own consent comfort.
- **Runtime footgun.** Bun is explicitly *not* recommended for Baileys (causes connection/message-handling instability) — stay on Node.js.