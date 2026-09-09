# Phase I — Infrastructure Resilience (from the 2026-09-09 outage)

> **Addendum to `WORKPLAN.md` (FINAL).** Verified against the live host and the repo at `10f247b`.
> Everything else in `WORKPLAN.md` stands. **Do I1 and I2 before any feature work** — they are the cheapest tasks in any plan you have and they prevent the most damage.

---

## Order

| When | Task |
|---|---|
| **Today** | I1 steps 1–2 (reclaim space + disk alert) |
| **This week** | I2, I4, I6 |
| **Next** | I3, I5, I7 |

Status tracking below.

## I1. Disk monitoring and cleanup ⭐
- [ ] Step 1: Reclaim space (whatsapp-session, npm cache, snap retain)
- [x] Step 2: Add disk check to health.js (warn 80%, alert 85%, critical >90%) — `getDiskStats`/`checkDiskSpace`, statfsSync, metric to health-metrics.jsonl, immediate DM on critical
- [x] Step 3: Preflight guard at startup (<1GB = refuse to start) — src/index.js before initWhatsApp
- [x] Step 4: Surface disk_free_pct in /health — disk_free_pct/disk_used_pct/disk_free_gb in voice-server payload

## I2. Make whatsapp_connected tell the truth ⭐
- [x] Require liveness: !isStale && presenceFailCount < 10 — derivation in src/whatsapp-state.js
- [x] Add whatsapp_state field (connected|stale|awaiting_qr|disconnected)
- [x] QR on existing session = session-invalidated alert + DM (once per invalidation)

## I3. Make watchdog act on what it knows
- [x] Fix: watchdog only supervises connections that already succeeded
- [x] Add startup-phase supervisor with timeout — src/startup-marker.js writes /tmp/besinsky-startup.json (phase starting→connected), cleared on clean shutdown; infra/watchdog.sh Check 1b alerts on stuck-startup (>5min) or missing-marker-while-online

## I4. Fix backup script silent failure
- [ ] pipefail + remove 2>/dev/null
- [ ] Post-write verification (size + decrypt + tar list)
- [ ] Only prune after verified-good backup
- [ ] Alert file on failure
- [ ] Same fixes for backup-sqlite.sh
- [ ] Enable S3_BACKUP_BUCKET

## I5. Alert on restart rate and log silence
- [ ] PM2 restart rate monitoring
- [ ] Log freshness check
- [ ] Route to existing alert path

## I6. Reduce log noise
- [ ] Rate-limit VoiceServer primary_child spam
- [ ] Truncate/debug-level libsignal session dumps
- [ ] Add logrotate for PM2 logs

## I7. Runbook
- [ ] docs/RUNBOOK.md
