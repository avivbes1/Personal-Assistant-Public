#!/bin/bash
# backup-auth-session.sh — Encrypted backup of Baileys auth session.
# Backs up .baileys_auth/ to a tarball, encrypted with openssl.
# Keeps 7 days locally. Can upload to S3 if configured.
#
# Usage: add to crontab alongside backup-sqlite.sh
#   0 3 * * * /home/ubuntu/besinsky-bot/scripts/backup-auth-session.sh >> /home/ubuntu/besinsky-bot/backups/backup.log 2>&1

set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] && export $(grep -v '^#' .env | xargs) 2>/dev/null || true

AUTH_DIR=".baileys_auth"
BACKUP_DIR="./backups/auth"
DATE=$(date +%Y-%m-%d)
BACKUP_FILE="${BACKUP_DIR}/baileys-auth-${DATE}.tar.gz.enc"
PASSPHRASE="${BACKUP_ENCRYPTION_KEY:-$(hostname)-baileys-backup}"
ALERT_FILE="/tmp/backup-auth-alert.json"

mkdir -p "$BACKUP_DIR"

# On any failure, write an alert the health check picks up (/tmp/*-alert.json)
# and exit non-zero so cron records the failure too.
fail() {
  local msg="[Auth-Backup] $1"
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

if [ ! -d "$AUTH_DIR" ]; then
  echo "[Auth-Backup] Auth dir not found — skipping"
  exit 0
fi

# Create encrypted tarball. No 2>/dev/null on tar — we want to see errors.
tar czf - "$AUTH_DIR" | \
  openssl enc -aes-256-cbc -salt -pbkdf2 -pass "pass:${PASSPHRASE}" \
  -out "$BACKUP_FILE"

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "[Auth-Backup] Created: $BACKUP_FILE ($SIZE)"

# ── Verify the backup before trusting it ────────────────────────────────────
# 1) Size sanity: an auth session tarball is comfortably >100KB. A tiny file
#    means tar produced almost nothing (e.g. empty/partial auth dir).
SIZE_BYTES=$(stat -c %s "$BACKUP_FILE" 2>/dev/null || stat -f %z "$BACKUP_FILE")
if [ "$SIZE_BYTES" -lt 102400 ]; then
  fail "backup too small (${SIZE_BYTES} bytes < 100KB) — likely incomplete"
fi

# 2) Decrypt + list: prove the file decrypts with our passphrase and the tar
#    stream is intact, then count entries. Auth sessions hold >100 files.
FILE_COUNT=$(openssl enc -d -aes-256-cbc -pbkdf2 -pass "pass:${PASSPHRASE}" -in "$BACKUP_FILE" \
  | tar -tzf - | wc -l) \
  || fail "decrypt/verify failed — backup is not readable"

if [ "$FILE_COUNT" -lt 100 ]; then
  fail "implausible file count (${FILE_COUNT} < 100) — auth backup incomplete"
fi
echo "[Auth-Backup] Verified: ${FILE_COUNT} files, ${SIZE_BYTES} bytes"

# ── Verified good — safe to prune and upload ────────────────────────────────
# Prune older than 7 days (only reached when verification passed)
find "$BACKUP_DIR" -name "baileys-auth-*.tar.gz.enc" -mtime +7 -delete
echo "[Auth-Backup] Pruned old backups"

# Optional S3 upload
if [ -n "${S3_BACKUP_BUCKET:-}" ]; then
  if aws s3 cp "$BACKUP_FILE" "s3://${S3_BACKUP_BUCKET}/auth/$(basename "$BACKUP_FILE")" --quiet; then
    echo "[Auth-Backup] Uploaded to S3"
  else
    echo "[Auth-Backup] S3 upload failed (non-critical)"
  fi
fi

# Success — clear any stale alert from a prior failed run.
rm -f "$ALERT_FILE"

echo "[Auth-Backup] Done at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# To restore:
# openssl enc -d -aes-256-cbc -pbkdf2 -pass "pass:${PASSPHRASE}" -in $BACKUP_FILE | tar xzf -
