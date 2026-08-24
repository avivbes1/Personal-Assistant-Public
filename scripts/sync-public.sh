#!/usr/bin/env bash
#
# sync-public.sh — standalone origin -> public sync with a PII gate.
#
# Steps:
#   1. Fetch, then check whether origin/main is ahead of public/main
#   2. If ahead: run the PII scan over src/
#   3. If clean: push origin/main to public/main
#   4. Log every outcome to /var/log/besinsky-git-sync.log
#
# Safe to run by hand or from cron. Exit codes:
#   0 = nothing to do, or synced successfully
#   1 = PII detected (sync skipped)
#   2 = git/push error

set -uo pipefail

LOG="/var/log/besinsky-git-sync.log"
REPO="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "not a git repo" >&2; exit 2; }
cd "$REPO" || exit 2

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$1" | tee -a "$LOG" 2>/dev/null
}

# -- 1. Is origin/main ahead of public/main? -----------------------------------
if ! git fetch origin main >/dev/null 2>&1; then
  log "sync-public: ERROR — git fetch origin failed"
  exit 2
fi
# public may not have main yet (first sync); tolerate a missing ref.
git fetch public main >/dev/null 2>&1 || true

ORIGIN_SHA="$(git rev-parse origin/main 2>/dev/null)"
PUBLIC_SHA="$(git rev-parse public/main 2>/dev/null || echo '')"

if [ -z "$ORIGIN_SHA" ]; then
  log "sync-public: ERROR — cannot resolve origin/main"
  exit 2
fi

if [ -n "$PUBLIC_SHA" ]; then
  # Count commits on origin/main that are not on public/main.
  AHEAD="$(git rev-list --count public/main..origin/main 2>/dev/null || echo 0)"
  if [ "$AHEAD" -eq 0 ]; then
    log "sync-public: public/main already up to date (${ORIGIN_SHA:0:7}) — nothing to do"
    exit 0
  fi
  log "sync-public: origin/main is ${AHEAD} commit(s) ahead of public/main"
else
  log "sync-public: public/main missing — performing initial sync"
fi

# -- 2. PII scan ---------------------------------------------------------------
SCAN_OUT="$(node scripts/detect-pii.js src/ 2>&1)"
if [ $? -ne 0 ]; then
  log "sync-public: PII DETECTED — sync skipped"
  printf '%s\n' "$SCAN_OUT" >>"$LOG"
  echo "$SCAN_OUT" >&2
  exit 1
fi
log "sync-public: PII scan clean"

# -- 3. Push origin/main -> public/main ----------------------------------------
if git push public origin/main:main >>"$LOG" 2>&1; then
  log "sync-public: pushed public/main OK (${ORIGIN_SHA:0:7})"
  exit 0
else
  log "sync-public: ERROR — push to public/main failed"
  exit 2
fi
