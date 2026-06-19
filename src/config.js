require('dotenv').config();

const config = {
  BOT_NAME: process.env.BOT_NAME || 'טודט',
  BOT_NAME_ALT: process.env.BOT_NAME_ALT || 'Tudat', // English alias
  AVIV_PHONE: process.env.AVIV_PHONE || '972504606660',  // for @mentions
  LIAT_PHONE: process.env.LIAT_PHONE || '972509244401',  // for @mentions
  MASTER_GROUP_NAME: process.env.MASTER_GROUP_NAME || 'Besinsky Family',
  AVIV_CALENDAR_ID: process.env.AVIV_CALENDAR_ID || 'primary',
  LIAT_CALENDAR_ID: process.env.LIAT_CALENDAR_ID || 'primary',
  LIAT_WORK_CALENDAR_ID: process.env.LIAT_WORK_CALENDAR_ID || '',
  CHROMIUM_PATH: process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser',
  GOOGLE_CREDENTIALS_PATH: process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json',
  AVIV_TOKEN_PATH: process.env.AVIV_TOKEN_PATH || './token-aviv.json',
  LIAT_TOKEN_PATH: process.env.LIAT_TOKEN_PATH || './token-liat.json',
  TIMEZONE: process.env.TIMEZONE || 'Asia/Jerusalem',

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
};

module.exports = config;
