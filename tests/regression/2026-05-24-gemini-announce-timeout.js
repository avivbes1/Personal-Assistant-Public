/**
 * Regression: 2026-05-24 (Gemini announce timeout)
 * Incident: Reminder job "שלומי סמנה ביטוח ורישיון קבלן דאוד" used
 *   delivery.mode="announce" + Gemini Flash Lite with NO timeoutSeconds.
 *   Gemini ran for 60 minutes (default timeout) doing nothing, then failed.
 *   The reminder was never delivered.
 *
 * Rule: Any enabled job using a Gemini model with delivery.mode="announce"
 *   MUST have timeoutSeconds set (≤ 60 for simple reminders).
 *   Without it, the default 3600s timeout causes silent 1-hour hangs.
 */

const { listCronJobs } = require('../lib/gateway');

const GEMINI_MODELS = ['gemini', 'google/'];

function isGeminiModel(model) {
  if (!model) return false;
  return GEMINI_MODELS.some(prefix => model.toLowerCase().includes(prefix));
}

module.exports = {
  async run() {
    try {
      const result = listCronJobs();
      const jobs = result.jobs || [];
      const broken = [];

      for (const job of jobs) {
        if (!job.enabled) continue;
        const model = job.payload?.model || '';
        const deliveryMode = job.delivery?.mode;
        const timeout = job.payload?.timeoutSeconds;

        if (isGeminiModel(model) && deliveryMode === 'announce' && !timeout) {
          broken.push(`"${job.name || job.id}" (${job.id.slice(0, 8)}) — no timeoutSeconds`);
        }
      }

      if (broken.length > 0) {
        return {
          pass: false,
          message: `${broken.length} Gemini announce job(s) missing timeoutSeconds (risk: 1h silent hang):\n  ${broken.join('\n  ')}`,
        };
      }

      const checked = jobs.filter(j => j.enabled && isGeminiModel(j.payload?.model || '') && j.delivery?.mode === 'announce').length;
      return { pass: true, message: `All Gemini announce jobs have timeoutSeconds set (checked ${checked})` };
    } catch (e) {
      return { pass: false, message: `Error: ${e.message}` };
    }
  },
};
