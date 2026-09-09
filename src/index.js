/**
 * index.js — Family Bot entry point.
 * WhatsApp family assistant bot.
 */

const startupMarker = require('./startup-marker');
// I3: record the startup phase before any slow init runs. If the process hangs
// or crashes below (DB init, profile load, Baileys handshake) the external
// watchdog sees a stale phase='starting' marker and alerts — otherwise a
// pre-connect crash-loop is invisible to it.
startupMarker.markStarting();

const config = require('./config');
const { initDB, assertGroupMonitoringIntegrity } = require('./db');
const { loadProfile } = require('./family-context');
const { initWhatsApp, sendToMasterGroup, sendToMasterGroupWithId, sendToMasterGroupWithMentions } = require('./whatsapp');
const { initScheduler } = require('./scheduler');
const { startHealthMonitor } = require('./health');

console.log('🤖 FamilyBot starting up...');
console.log(`   Timezone: ${config.TIMEZONE}`);
console.log(`   Master Group: ${config.MASTER_GROUP_NAME}`);
console.log('');

// A1: Startup timezone assertion. All date math on this box assumes a UTC host
// (the notice/calendar window logic converts to Israel time explicitly). If the
// host TZ has drifted from UTC, day-boundary calculations silently shift — so
// resolve it once at boot, log it, and warn loudly on mismatch.
const RESOLVED_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
console.log(`[Boot] Resolved timezone: ${RESOLVED_TZ}`);
if (RESOLVED_TZ !== 'UTC') {
  console.error(`[Boot] WARNING: Host timezone is ${RESOLVED_TZ}, expected UTC. Date calculations may be incorrect.`);
}

// 1. Initialize database
initDB();

// B7: Assert group monitoring state integrity at startup
assertGroupMonitoringIntegrity();

// 2. Load family context profile (fail fast if missing/invalid)
try {
  loadProfile();
} catch (err) {
  console.error('[FamilyBot] FATAL: Family profile load failed:', err.message);
  console.error('  Check config/family-context.json');
  process.exit(1);
}

// 2b. I1 preflight: refuse to start on a nearly-full disk. Booting Baileys with
// <1GB free risks corrupting the session/DB mid-write — better to fail loudly and
// leave the existing session intact than to start and truncate it.
try {
  const { getDiskStats, sendAlertDirect } = require('./health');
  const disk = getDiskStats();
  const MIN_FREE_BYTES = 1024 * 1024 * 1024; // 1GB
  if (disk && disk.free_bytes < MIN_FREE_BYTES) {
    const freeMb = Math.round(disk.free_bytes / 1e6);
    console.error(`[Boot] FATAL: only ${freeMb}MB free (<1GB) on disk — refusing to start to avoid corrupting the WhatsApp session/DB. Free space and restart.`);
    // Queues to disk (WhatsApp isn't up yet) and flushes on the next healthy boot.
    try {
      sendAlertDirect(`🔴 הבוט לא עלה: רק ${freeMb}MB פנויים בדיסק (פחות מ-1GB). פנה מקום והפעל מחדש.`);
    } catch (_) {}
    process.exit(1);
  }
} catch (e) {
  // A statfs failure must not itself block startup — just log and continue.
  console.error('[Boot] Disk preflight check failed (continuing):', e.message);
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
  // I3: clear the startup marker so the external watchdog doesn't flag a stale
  // 'starting'/'connected' file after a deliberate shutdown.
  startupMarker.clear();
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
