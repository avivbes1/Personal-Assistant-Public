/**
 * index.js — Family Bot entry point.
 * WhatsApp family assistant bot.
 */

const config = require('./config');
const { initDB } = require('./db');
const { loadProfile } = require('./family-context');
const { initWhatsApp, sendToMasterGroup, sendToMasterGroupWithId, sendToMasterGroupWithMentions } = require('./whatsapp');
const { initScheduler } = require('./scheduler');
const { startHealthMonitor } = require('./health');

console.log('🤖 FamilyBot starting up...');
console.log(`   Timezone: ${config.TIMEZONE}`);
console.log(`   Master Group: ${config.MASTER_GROUP_NAME}`);
console.log('');

// 1. Initialize database
initDB();

// 2. Load family context profile (fail fast if missing/invalid)
try {
  loadProfile();
} catch (err) {
  console.error('[FamilyBot] FATAL: Family profile load failed:', err.message);
  console.error('  Check config/family-context.json');
  process.exit(1);
}

// 3. Initialize WhatsApp client
initWhatsApp();

// 4. Initialize scheduler (needs sendToMasterGroup from whatsapp)
//    Small delay to allow WhatsApp to connect before jobs fire
setTimeout(() => {
  initScheduler(sendToMasterGroup, sendToMasterGroupWithId, sendToMasterGroupWithMentions);
}, 2000);

// 5. Start health monitor (after a delay so WhatsApp can connect first)
setTimeout(() => {
  startHealthMonitor(5 * 60 * 1000); // every 5 minutes
}, 30 * 1000); // wait 30s after startup

// 5. Graceful shutdown
function shutdown(signal) {
  console.log(`\n[FamilyBot] Received ${signal}. Shutting down gracefully...`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('[FamilyBot] Uncaught exception:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FamilyBot] Unhandled promise rejection:', reason);
});
