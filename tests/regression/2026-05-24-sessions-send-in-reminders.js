/**
 * Regression: 2026-05-24 (sessions_send hallucination)
 * Incident: Reminder jobs instructed Gemini Flash Lite to "call sessions_send"
 *   inside an agentTurn. Gemini reported success ("The reminder message has
 *   been sent") but never actually called the tool. Reminders were lost.
 *
 * Rule: Any enabled job whose payload.message contains "sessions_send"
 *   instruction AND uses delivery.mode="none" is high-risk.
 *   Reminders should use delivery.mode="announce" with the reminder text
 *   as the final reply — no tool calls, no agent intermediary.
 */

const { listCronJobs } = require('../lib/gateway');

module.exports = {
  async run() {
    try {
      const result = listCronJobs();
      const jobs = result.jobs || [];
      const risky = [];

      for (const job of jobs) {
        if (!job.enabled) continue;
        const message = job.payload?.message || '';
        const deliveryMode = job.delivery?.mode;

        // Flag one-shot reminder jobs (schedule.kind="at") that ask the agent
        // to call sessions_send with no delivery fallback.
        // Recurring processing jobs (notices, audit) legitimately use sessions_send.
        const isOneShot = job.schedule?.kind === 'at';
        if (
          isOneShot &&
          deliveryMode === 'none' &&
          message.toLowerCase().includes('sessions_send')
        ) {
          risky.push(`"${job.name || job.id}" (${job.id.slice(0, 8)})`);
        }
      }

      if (risky.length > 0) {
        return {
          pass: false,
          message: `${risky.length} job(s) rely on agent calling sessions_send with no delivery fallback (Gemini hallucinates this):\n  ${risky.join('\n  ')}\n  Fix: use delivery.mode="announce" instead.`,
        };
      }

      return { pass: true, message: 'No jobs rely on agent-called sessions_send for delivery' };
    } catch (e) {
      return { pass: false, message: `Error: ${e.message}` };
    }
  },
};
