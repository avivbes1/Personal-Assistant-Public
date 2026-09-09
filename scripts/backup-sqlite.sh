#!/bin/bash
# backup-sqlite.sh — Daily SQLite backup with 7-day local retention.
# Optional: upload to S3 if S3_BACKUP_BUCKET is set in .env.
#
# Usage (add to crontab -e):
#   0 3 * * * /path/to/familybot/scripts/backup-sqlite.sh >> /path/to/familybot/backups/backup.log 2>&1

set -euo pipefail
cd "$(dirname "$0")/.."

# Load env
[ -f .env ] && export $(grep -v '^#' .env | xargs) 2>/dev/null || true

DB_PATH="${DATABASE_PATH:-./data/family.db}"
BACKUP_DIR="./backups"
DATE=$(date +%Y-%m-%d)
BACKUP_FILE="${BACKUP_DIR}/family-${DATE}.db"
ALERT_FILE="/tmp/backup-sqlite-alert.json"

mkdir -p "$BACKUP_DIR"

# On any failure, write an alert the health check picks up (/tmp/*-alert.json)
# and exit non-zero so cron records the failure too.
fail() {
  local msg="[Backup] $1"
  echo "FAILED: $msg" >&2
  # Escape backslash and double-quote so the message is valid JSON.
  local esc=${msg//\\/\\\\}
  esc=${esc//\"/\\\"}
  # Include both timestamp/error (task spec) and ts/message (existing Lipa
  # heartbeat convention) so whatever scans /tmp/*-alert.json can read it.
  printf '{"ts":%s,"timestamp":"%s","message":"%s","error":"%s"}\n' \
    "$(date +%s)000" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$esc" "$esc" > "$ALERT_FILE"
  exit 1
}
trap 'fail "unexpected error at line $LINENO"' ERR

if [ ! -f "$DB_PATH" ]; then
  echo "[Backup] DB not found at $DB_PATH — skipping"
  exit 0
fi

# SQLite safe backup via .backup command
sqlite3 "$DB_PATH" ".backup '${BACKUP_FILE}'"

# ── Verify the backup before trusting it ────────────────────────────────────
# The .backup can exit 0 yet leave a missing/empty file on a full disk or
# interrupted write. Require the file to exist and be plausibly sized (>1KB).
if [ ! -f "$BACKUP_FILE" ]; then
  fail "backup file not created at $BACKUP_FILE"
fi
SIZE_BYTES=$(stat -c %s "$BACKUP_FILE" 2>/dev/null || stat -f %z "$BACKUP_FILE")
if [ "$SIZE_BYTES" -lt 1024 ]; then
  fail "backup too small (${SIZE_BYTES} bytes < 1KB) — likely incomplete"
fi
echo "[Backup] Created: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"

# ── Verified good — safe to prune and upload ────────────────────────────────
# Prune backups older than 7 days (only reached when verification passed)
find "$BACKUP_DIR" -name "family-*.db" -mtime +7 -delete
echo "[Backup] Pruned backups older than 7 days"

# Optional: upload to S3
if [ -n "${S3_BACKUP_BUCKET:-}" ]; then
  aws s3 cp "$BACKUP_FILE" "s3://${S3_BACKUP_BUCKET}/familybot/$(basename "$BACKUP_FILE")" --quiet
  echo "[Backup] Uploaded to s3://${S3_BACKUP_BUCKET}/familybot/$(basename "$BACKUP_FILE")"
fi

# Success — clear any stale alert from a prior failed run.
rm -f "$ALERT_FILE"

echo "[Backup] Done at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
