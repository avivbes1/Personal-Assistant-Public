/**
 * family-context.js — Family context layer (ISSUE-020)
 *
 * Loads config/family-context.json at startup. Provides:
 *   - buildProfileSlice(groupName)  → compact context for Haiku injection
 *   - shouldSkipGroup(groupName)    → true if group is in skip list
 *   - getProfileHealth()            → staleness + metadata for /health/pipeline
 *   - loadProfile()                 → call once at startup; fails fast if invalid
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const PROFILE_PATH = path.join(__dirname, '../config/family-context.json');

// ── Schema (manual validation — no Ajv dependency) ────────────────────────────

function validateProfile(p) {
  if (!p || typeof p !== 'object') throw new Error('Profile must be an object');
  if (typeof p.schema_version !== 'number') throw new Error('Missing schema_version');
  if (typeof p.family !== 'string') throw new Error('Missing family');
  if (!p.members || typeof p.members !== 'object') throw new Error('Missing members');
  if (!Array.isArray(p.group_skip)) throw new Error('Missing group_skip array');
  if (!Array.isArray(p.priority_rules)) throw new Error('Missing priority_rules array');
  if (!Array.isArray(p.current_focus)) throw new Error('Missing current_focus array');
  for (const [name, m] of Object.entries(p.members)) {
    if (!Array.isArray(m.groups)) throw new Error(`members.${name}.groups must be array`);
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

let _profile = null;
let _loadedAt = null;

// ── Public API ────────────────────────────────────────────────────────────────

function loadProfile() {
  const raw = fs.readFileSync(PROFILE_PATH, 'utf8');
  const data = JSON.parse(raw);
  validateProfile(data);

  // Prune expired current_focus entries
  const now = new Date();
  data.current_focus = data.current_focus.filter(f => new Date(f.expires) > now);

  _profile = data;
  _loadedAt = Date.now();
  console.log(`[FamilyCtx] Profile loaded: v${data.schema_version}, updated=${data.updated_at}, members=${Object.keys(data.members).join(', ')}`);
  return data;
}

function getProfile() {
  if (!_profile) throw new Error('Family profile not loaded. Call loadProfile() at startup.');
  return _profile;
}

/**
 * Returns a compact slice of the profile relevant to a specific group.
 * Returns null if the group is in group_skip (caller should abort extraction).
 */
function buildProfileSlice(groupName) {
  const p = getProfile();

  if (p.group_skip.includes(groupName)) return null;

  // Find the child whose groups list includes this group
  let child = null;
  for (const [name, data] of Object.entries(p.members)) {
    if (data.groups.includes(groupName)) {
      child = {
        name,
        grade:         data.grade,
        school:        data.school,
        teachers:      data.teachers || [],
        current_notes: data.current_notes || [],
      };
      break;
    }
  }

  if (!child) {
    // Group not mapped — log for monitoring but don't block
    console.log(`[FamilyCtx] Unknown group (not in profile): "${groupName}"`);
  }

  return {
    family:         p.family,
    child,          // null if group not mapped to a child
    priority_rules: p.priority_rules,
    current_focus:  p.current_focus.map(f => f.text),
  };
}

function shouldSkipGroup(groupName) {
  return getProfile().group_skip.includes(groupName);
}

function getProfileHealth() {
  if (!_profile || !_loadedAt) {
    return { status: 'not_loaded' };
  }
  const updatedAt   = new Date(_profile.updated_at);
  const daysSince   = (Date.now() - updatedAt) / (1000 * 60 * 60 * 24);
  const stale       = daysSince > 7;
  return {
    status:              stale ? 'stale' : 'ok',
    schema_version:      _profile.schema_version,
    updated_at:          _profile.updated_at,
    days_since_update:   Math.floor(daysSince),
    members:             Object.keys(_profile.members),
    active_focus_items:  _profile.current_focus.length,
    unknown_groups_logged: true, // see [FamilyCtx] logs
  };
}

module.exports = { loadProfile, getProfile, buildProfileSlice, shouldSkipGroup, getProfileHealth };
