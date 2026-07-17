require('dotenv').config();

// Fail fast on missing required config — no silent PII fallbacks
function required(key, description) {
  const val = process.env[key];
  if (!val) {
    console.error(`\n[config] FATAL: Missing required env var: ${key}`);
    console.error(`[config] ${description}`);
    console.error('[config] Check your .env file. See .env.example for reference.\n');
    process.exit(1);
  }
  return val;
}

const config = {
  BOT_NAME:     process.env.BOT_NAME     || 'FamilyBot',  // set BOT_NAME in .env
  BOT_NAME_ALT: process.env.BOT_NAME_ALT || 'familybot',
  AVIV_PHONE:   required('AVIV_PHONE',   'Primary parent phone number in E.164 format, e.g. 15551234567'),
  LIAT_PHONE:   required('LIAT_PHONE',   'Secondary parent phone number in E.164 format, e.g. 15559876543'),
  MASTER_GROUP_NAME: required('MASTER_GROUP_NAME', 'Exact name of your master WhatsApp group'),
  AVIV_CALENDAR_ID:  required('AVIV_CALENDAR_ID',  'Google Calendar ID for primary parent — use "primary" or the full calendar email (see Google Calendar settings)'),
  LIAT_CALENDAR_ID:  required('LIAT_CALENDAR_ID',  'Google Calendar ID for secondary parent'),
  LIAT_WORK_CALENDAR_ID: process.env.LIAT_WORK_CALENDAR_ID || '',
  CHROMIUM_PATH: process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser',
  GOOGLE_CREDENTIALS_PATH: process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json',
  AVIV_TOKEN_PATH: process.env.AVIV_TOKEN_PATH || './token-aviv.json',
  LIAT_TOKEN_PATH: process.env.LIAT_TOKEN_PATH || './token-liat.json',
  TIMEZONE: process.env.TIMEZONE || 'UTC',

  // ── Feature flags (all off by default) ──────────────────────────────────────
  // Phase 1 (infrastructure logging — no behavior change)
  FEATURE_CONVERSATION_HISTORY: process.env.FEAT_CONV_HISTORY === '1',
  // Phase 2 (context-aware queries)
  FEATURE_MEMBER_RESOLUTION:    process.env.FEAT_MEMBER_RES === '1',
  // Phase 3 (confirmation loop before actions)
  FEATURE_CONFIRM_ACTIONS:      process.env.FEAT_CONFIRM === '1',
  // Phase 4 (clarification loop)
  FEATURE_CLARIFICATION_LOOP:   process.env.FEAT_CLARIFY === '1',
  // Phase 5 (capability self-awareness)
  FEATURE_CAPABILITY_AWARE:     process.env.FEAT_CAPABILITY === '1',

  // ── Hallucination Guard ──────────────────────────────────────────────────────
  // Grounds proactive outbound reminders in verifiable DB records. When enabled
  // (default), guardedSend validates every send against the DB before it goes
  // out. Set HALLUCINATION_GUARD=0 to disable (validation is skipped, warns).
  HALLUCINATION_GUARD_ENABLED: process.env.HALLUCINATION_GUARD !== '0',
};

module.exports = config;
