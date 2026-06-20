/**
 * Regression: 2026-05-24
 * Incident: Multiple cron jobs were configured with delivery.mode="announce"
 *   but no delivery.to target. They silently failed with:
 *   "Delivering to WhatsApp requires target <E.164|group JID|newsletter JID>"
 *
 * This test checks ALL enabled cron jobs: any with announce delivery must
 *   have an explicit `to` field set.
 */

const { listCronJobs } = require('../lib/gateway');

module.exports = {
  async run() {
    try {
      const result = listCronJobs();
      const jobs = result.jobs || [];
      const broken = [];

      for (const job of jobs) {
        if (!job.enabled) continue;
        const delivery = job.delivery || {};
        if (delivery.mode === 'announce' && !delivery.to) {
          broken.push(`"${job.name || job.id}" (${job.id.slice(0, 8)})`);
        }
      }

      if (broken.length > 0) {
        return {
          pass: false,
          message: `${broken.length} job(s) have announce delivery with no target:\n  ${broken.join('\n  ')}`,
        };
      }

      return { pass: true, message: `All ${jobs.filter(j => j.enabled).length} enabled jobs have valid delivery config` };
    } catch (e) {
      return { pass: false, message: `Error: ${e.message}` };
    }
  },
};
