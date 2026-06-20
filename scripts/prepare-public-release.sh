#!/bin/bash
# prepare-public-release.sh — Build a clean public snapshot using an ALLOWLIST.
#
# Only explicitly listed directories and files are included.
# Anything not in this list is excluded by default.
# This is the correct approach for a public repo — never rely on exclusions alone.
#
# Usage: bash scripts/prepare-public-release.sh [output-dir]
# Default output: ../personal-assistant-public

set -e

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-../personal-assistant-public}"
DEST="$(realpath "$DEST" 2>/dev/null || echo "$DEST")"

echo "📦 Preparing public release snapshot (allowlist mode)..."
echo "   Source:  $SRC"
echo "   Output:  $DEST"
echo ""

# ── Clean slate ────────────────────────────────────────────────────────────────
rm -rf "$DEST"
mkdir -p "$DEST"

# ── Allowlist: only these are copied ──────────────────────────────────────────
# Add entries here deliberately. Do NOT add a directory unless you've verified
# it contains no PII.

# Core source — all files in src/ (PII-scanned before each release)
mkdir -p "$DEST/src"
rsync -a --exclude='*.db' --exclude='*.sqlite' "$SRC/src/" "$DEST/src/"

# LLM prompt templates
if [ -d "$SRC/prompts" ]; then
  mkdir -p "$DEST/prompts"
  rsync -a "$SRC/prompts/" "$DEST/prompts/"
fi

# DB migrations (schema only, no data)
if [ -d "$SRC/migrations" ]; then
  mkdir -p "$DEST/migrations"
  rsync -a "$SRC/migrations/" "$DEST/migrations/"
fi

# Regression tests — PII-scanned
if [ -d "$SRC/tests/regression" ]; then
  mkdir -p "$DEST/tests/regression"
  rsync -a "$SRC/tests/regression/" "$DEST/tests/regression/"
fi
if [ -f "$SRC/tests/run-all.js" ]; then
  cp "$SRC/tests/run-all.js" "$DEST/tests/"
fi
if [ -d "$SRC/tests/lib" ]; then
  mkdir -p "$DEST/tests/lib"
  rsync -a "$SRC/tests/lib/" "$DEST/tests/lib/"
fi

# PII scanner (generic version, no family patterns)
mkdir -p "$DEST/scripts"
cp "$SRC/scripts/detect-pii.js" "$DEST/scripts/"

# Top-level safe files only
[ -f "$SRC/.env.example" ]  && cp "$SRC/.env.example"  "$DEST/"
[ -f "$SRC/.gitignore" ]    && cp "$SRC/.gitignore"     "$DEST/"
[ -f "$SRC/package.json" ]  && cp "$SRC/package.json"   "$DEST/"
[ -f "$SRC/README.md" ]     && cp "$SRC/README.md"      "$DEST/"
[ -f "$SRC/PRINCIPLES.md" ] && cp "$SRC/PRINCIPLES.md"  "$DEST/"
[ -f "$SRC/package-lock.json" ] && cp "$SRC/package-lock.json" "$DEST/"

echo "✅ Allowlist copy complete."
echo ""

# ── PII scan gate — must pass before publishing ────────────────────────────────
echo "🔍 Running PII scan on output..."
if node "$SRC/scripts/detect-pii.js" "$DEST/src" && \
   ([ ! -d "$DEST/prompts" ] || node "$SRC/scripts/detect-pii.js" "$DEST/prompts") && \
   ([ ! -d "$DEST/tests" ] || node "$SRC/scripts/detect-pii.js" "$DEST/tests"); then
  echo "✅ PII scan passed."
else
  echo ""
  echo "🛑 RELEASE BLOCKED: PII found in snapshot. Fix src/ files and re-run."
  echo "   Hint: use env vars (process.env.X) not hardcoded values."
  rm -rf "$DEST"
  exit 1
fi

echo ""
echo "📁 Public snapshot ready at: $DEST"
