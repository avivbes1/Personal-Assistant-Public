#!/bin/bash
# backup-sqlite.sh — Daily SQLite backup for Besinsky Bot
# Runs via cron at 03:00 AM UTC.
# Local copies kept 7 days. S3 upload optional (requires S3_BACKUP_BUCKET env var).

set -e

DB_PATH="/home/ubuntu/besinsky-bot/data/besinsky.db"
BACKUP_DIR="/home/ubuntu/besinsky-bot/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="besinsky_${TIMESTAMP}.db"

# Ensure backup dir exists
mkdir -p "$BACKUP_DIR"

# SQLite hot backup (safe under concurrent writes)
sqlite3 "$DB_PATH" ".backup '${BACKUP_DIR}/${BACKUP_NAME}'"

# Compress
gzip -f "${BACKUP_DIR}/${BACKUP_NAME}"
COMPRESSED="${BACKUP_DIR}/${BACKUP_NAME}.gz"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Backup created: ${BACKUP_NAME}.gz ($(du -sh "$COMPRESSED" | cut -f1))"

# S3 upload (optional — requires S3_BACKUP_BUCKET env var and IAM permissions)
if [ -n "$S3_BACKUP_BUCKET" ]; then
  aws s3 cp "$COMPRESSED" "s3://${S3_BACKUP_BUCKET}/${BACKUP_NAME}.gz" --quiet
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Uploaded to s3://${S3_BACKUP_BUCKET}/${BACKUP_NAME}.gz"
else
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] S3_BACKUP_BUCKET not set — local backup only"
fi

# Clean local copies older than 7 days
find "$BACKUP_DIR" -name "besinsky_*.db.gz" -mtime +7 -delete
REMAINING=$(find "$BACKUP_DIR" -name "besinsky_*.db.gz" | wc -l)
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Local backups retained: $REMAINING"
