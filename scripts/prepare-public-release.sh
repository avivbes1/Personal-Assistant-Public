#!/bin/bash
# prepare-public-release.sh — Create a clean public snapshot of the bot.
# Copies source files excluding all PII/credentials/runtime data,
# then runs the PII detector as a final gate.
#
# Usage: bash scripts/prepare-public-release.sh [output-dir]
# Default output: ../personal-assistant-public

set -e

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-../personal-assistant-public}"
DEST="$(realpath "$DEST" 2>/dev/null || echo "$DEST")"

echo "📦 Preparing public release snapshot..."
echo "   Source:  $SRC"
echo "   Output:  $DEST"
echo ""

# ── Clean slate ────────────────────────────────────────────────────────────────
rm -rf "$DEST"
mkdir -p "$DEST"

# ── Copy with exclusions ──────────────────────────────────────────────────────
rsync -a \
  --exclude='.git' \\n  --exclude='.github/workflows/' \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='credentials.json' \
  --exclude='token-*.json' \
  --exclude='config/groups.json' \
  --exclude='config/family-seed.json' \
  --exclude='data/' \
  --exclude='backups/' \
  --exclude='logs/' \
  --exclude='whatsapp-session/' \
  --exclude='.wwebjs_auth/' \
  --exclude='.wwebjs_cache/' \
  --exclude='*.db' \
  --exclude='*.sqlite' \
  --exclude='*.log' \
  --exclude='data/triage-test-cases.json' \
  --exclude='audit-results.txt' \
  "$SRC/" "$DEST/"

echo "✅ Files copied."
echo ""

# ── PII scan gate ──────────────────────────────────────────────────────────────
echo "🔍 Running PII scan on output..."
if node "$SRC/scripts/detect-pii.js" "$DEST/src" && \
   node "$SRC/scripts/detect-pii.js" "$DEST/prompts" 2>/dev/null; then
  echo "✅ PII scan passed."
else
  echo ""
  echo "🛑 RELEASE BLOCKED: PII found in snapshot. Fix and re-run."
  exit 1
fi

echo ""
echo "📁 Snapshot ready at: $DEST"
echo ""
echo "Next steps:"
echo "  cd $DEST"
echo "  git init && git add . && git commit -m 'Initial public release'"
echo "  git remote add origin https://github.com/avivbes1/Personal-Assistant-Public.git"
echo "  git push -u origin main"
