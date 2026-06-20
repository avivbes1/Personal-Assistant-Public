#!/bin/bash
# backup-sqlite.sh — Daily SQLite backup with 7-day local retention.
# Optional: upload to S3 if S3_BACKUP_BUCKET is set in .env.
#
# Usage (add to crontab -e):
#   0 3 * * * /path/to/familybot/scripts/backup-sqlite.sh >> /path/to/familybot/backups/backup.log 2>&1

set -e
cd "$(dirname "$0")/.."

# Load env
[ -f .env ] && export $(grep -v '^#' .env | xargs) 2>/dev/null || true

DB_PATH="${DATABASE_PATH:-./data/family.db}"
BACKUP_DIR="./backups"
DATE=$(date +%Y-%m-%d)
BACKUP_FILE="${BACKUP_DIR}/family-${DATE}.db"

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_PATH" ]; then
  echo "[Backup] DB not found at $DB_PATH — skipping"
  exit 0
fi

# SQLite safe backup via .backup command
sqlite3 "$DB_PATH" ".backup '${BACKUP_FILE}'"
echo "[Backup] Created: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"

# Prune backups older than 7 days
find "$BACKUP_DIR" -name "family-*.db" -mtime +7 -delete
echo "[Backup] Pruned backups older than 7 days"

# Optional: upload to S3
if [ -n "$S3_BACKUP_BUCKET" ]; then
  aws s3 cp "$BACKUP_FILE" "s3://${S3_BACKUP_BUCKET}/familybot/$(basename $BACKUP_FILE)" --quiet
  echo "[Backup] Uploaded to s3://${S3_BACKUP_BUCKET}/familybot/$(basename $BACKUP_FILE)"
fi

echo "[Backup] Done at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
