#!/usr/bin/env node
/**
 * update-profile.js — Safe family context profile update
 * Usage: npm run update-profile <path-to-new-profile.json>
 *
 * Steps:
 *   1. Validate new file against schema
 *   2. Backup current profile (keep last 5)
 *   3. Write new profile with updated timestamp
 *   4. Reload bot with pm2 reload
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT         = path.join(__dirname, '..');
const PROFILE_PATH = path.join(ROOT, 'config/family-context.json');
const HISTORY_DIR  = path.join(ROOT, 'config/family-context-history');

const newFilePath = process.argv[2];
if (!newFilePath) {
  console.error('Usage: node scripts/update-profile.js <path-to-new-profile.json>');
  process.exit(1);
}

// ── Validate ──────────────────────────────────────────────────────────────────

let newData;
try {
  newData = JSON.parse(fs.readFileSync(newFilePath, 'utf8'));
} catch (e) {
  console.error('Failed to parse new profile:', e.message);
  process.exit(1);
}

const required = ['schema_version', 'family', 'members', 'group_skip', 'priority_rules', 'current_focus'];
for (const field of required) {
  if (!(field in newData)) {
    console.error(`Validation failed: missing required field "${field}"`);
    process.exit(1);
  }
}
if (typeof newData.members !== 'object' || Array.isArray(newData.members)) {
  console.error('Validation failed: "members" must be an object');
  process.exit(1);
}
for (const [name, m] of Object.entries(newData.members)) {
  if (!Array.isArray(m.groups)) {
    console.error(`Validation failed: members.${name}.groups must be an array`);
    process.exit(1);
  }
}
console.log('✅ Validation passed');

// ── Backup ────────────────────────────────────────────────────────────────────

if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

const timestamp   = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const backupPath  = path.join(HISTORY_DIR, `family-context-${timestamp}.json`);
fs.copyFileSync(PROFILE_PATH, backupPath);
console.log(`📦 Backed up to: ${backupPath}`);

// Keep only last 5 backups
const backups = fs.readdirSync(HISTORY_DIR).filter(f => f.startsWith('family-context-')).sort().reverse();
for (const old of backups.slice(5)) {
  fs.unlinkSync(path.join(HISTORY_DIR, old));
  console.log(`🗑  Pruned old backup: ${old}`);
}

// ── Write ─────────────────────────────────────────────────────────────────────

newData.updated_at = new Date().toISOString().slice(0, 10);
fs.writeFileSync(PROFILE_PATH, JSON.stringify(newData, null, 2));
console.log(`✅ Profile updated: ${PROFILE_PATH}`);

// ── Reload ────────────────────────────────────────────────────────────────────

console.log('🔄 Reloading bot...');
try {
  execSync('pm2 reload besinsky-bot', { stdio: 'inherit' });
  console.log('✅ Bot reloaded');
} catch (e) {
  console.error('⚠️  pm2 reload failed:', e.message);
  console.error('   Restart manually: pm2 restart besinsky-bot');
}
