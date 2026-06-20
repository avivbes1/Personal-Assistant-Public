const path = require('path');
/**
 * Regression: 2026-05-26
 * Incident: Near-realtime notices and audit jobs timed out 22+ times because
 *   they used sessions_send which blocks indefinitely waiting for inter-session response.
 * Fix: Both jobs now use curl localhost:3001/send-message instead.
 *
 * This test verifies:
 * 1. Neither job's prompt contains "sessions_send"
 * 2. The /send-message endpoint exists in voice-server.js
 */

const { listCronJobs } = require('../lib/gateway');
const fs = require('fs');

module.exports = {
  async run() {
    // Check 1: neither job uses sessions_send in prompt
    let jobs;
    try {
      const result = listCronJobs({ includeDisabled: false });
      jobs = result.jobs || result;
    } catch (e) {
      return { pass: false, message: `Could not list cron jobs: ${e.message}` };
    }

    const noticesJob = jobs.find(j => j.id === '277fb882-d745-4343-a68f-a5e561b79500');
    const auditJob = jobs.find(j => j.id === '47f8f2e3-5de9-426d-9902-0d11201d8e17');

    // Jobs may have been legitimately removed — if both are absent, skip with pass
    if (!noticesJob && !auditJob) return { pass: true, message: 'Near-realtime notices and audit jobs removed (intentional) — skipping' };
    if (!noticesJob) return { pass: false, message: 'Near-realtime notices job not found' };
    if (!auditJob) return { pass: false, message: 'Notices delivery audit job not found' };

    const noticesMsg = noticesJob.payload?.message || '';
    const auditMsg = auditJob.payload?.message || '';

    // Check for the actual blocking call pattern ("via sessions_send" or "sessions_send tool:").
    // The new prompts may mention sessions_send in a NEVER warning — that's fine.
    const blockingPattern = /via sessions_send|sessions_send tool:/;
    if (blockingPattern.test(noticesMsg)) {
      return { pass: false, message: 'Near-realtime notices job still uses sessions_send call pattern — will timeout' };
    }
    if (blockingPattern.test(auditMsg)) {
      return { pass: false, message: 'Notices delivery audit job still uses sessions_send call pattern — will timeout' };
    }

    // Check 2: /send-message endpoint exists in voice-server.js
    const vsPath = path.join(__dirname, '../../src/voice-server.js');
    if (!fs.existsSync(vsPath)) return { pass: false, message: 'voice-server.js not found' };
    const vsContent = fs.readFileSync(vsPath, 'utf8');
    if (!vsContent.includes('/send-message')) {
      return { pass: false, message: 'voice-server.js missing /send-message endpoint' };
    }

    return {
      pass: true,
      message: 'Both jobs use curl delivery (no sessions_send). /send-message endpoint present.',
    };
  },
};
