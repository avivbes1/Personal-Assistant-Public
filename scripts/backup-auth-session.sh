#!/bin/bash
# backup-auth-session.sh — Encrypted backup of Baileys auth session.
# Backs up .baileys_auth/ to a tarball, encrypted with openssl.
# Keeps 7 days locally. Can upload to S3 if configured.
#
# Usage: add to crontab alongside backup-sqlite.sh
#   0 3 * * * /home/ubuntu/besinsky-bot/scripts/backup-auth-session.sh >> /home/ubuntu/besinsky-bot/backups/backup.log 2>&1

set -e
cd "$(dirname "$0")/.."

[ -f .env ] && export $(grep -v '^#' .env | xargs) 2>/dev/null || true

AUTH_DIR=".baileys_auth"
BACKUP_DIR="./backups/auth"
DATE=$(date +%Y-%m-%d)
BACKUP_FILE="${BACKUP_DIR}/baileys-auth-${DATE}.tar.gz.enc"
PASSPHRASE="${BACKUP_ENCRYPTION_KEY:-$(hostname)-baileys-backup}"

mkdir -p "$BACKUP_DIR"

if [ ! -d "$AUTH_DIR" ]; then
  echo "[Auth-Backup] Auth dir not found — skipping"
  exit 0
fi

# Create encrypted tarball
tar czf - "$AUTH_DIR" 2>/dev/null | \
  openssl enc -aes-256-cbc -salt -pbkdf2 -pass "pass:${PASSPHRASE}" \
  -out "$BACKUP_FILE"

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "[Auth-Backup] Created: $BACKUP_FILE ($SIZE)"

# Prune older than 7 days
find "$BACKUP_DIR" -name "baileys-auth-*.tar.gz.enc" -mtime +7 -delete
echo "[Auth-Backup] Pruned old backups"

# Optional S3 upload
if [ -n "$S3_BACKUP_BUCKET" ]; then
  aws s3 cp "$BACKUP_FILE" "s3://${S3_BACKUP_BUCKET}/auth/$(basename $BACKUP_FILE)" --quiet 2>/dev/null && \
    echo "[Auth-Backup] Uploaded to S3" || \
    echo "[Auth-Backup] S3 upload failed (non-critical)"
fi

echo "[Auth-Backup] Done at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# To restore:
# openssl enc -d -aes-256-cbc -pbkdf2 -pass "pass:${PASSPHRASE}" -in $BACKUP_FILE | tar xzf -
