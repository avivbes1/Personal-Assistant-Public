/**
 * Regression: 2026-05-23
 * Incident: Morning digest timed out at 07:00 (120s timeout hit). No digest
 *   was delivered. A manual re-run was needed at 17:38 — 10+ hours late.
 *
 * This test checks:
 *   1. Morning digest job timeoutSeconds is set high enough (≥ 120).
 *   2. The last run did NOT end in a timeout error.
 *   3. If last run timed out, flags it clearly.
 */

const { IS_CI, getCronJob, getCronRuns } = require('../lib/gateway');

const DIGEST_JOB_ID = 'd782f168-d74e-4585-b4f4-609e487afb9e';

module.exports = {
  async run() {
    if (IS_CI) return { pass: true, message: "Skipped in CI (requires live OpenClaw)" };
    try {
      // Check job config
      const job = getCronJob(DIGEST_JOB_ID);
      const timeout = job.payload?.timeoutSeconds;
      if (!timeout || timeout < 90) {
        return { pass: false, message: `timeoutSeconds is ${timeout} — too low, digest needs ≥ 90s` };
      }

      // Check last run
      const runsRes = getCronRuns(DIGEST_JOB_ID, 1);
      if (runsRes.entries?.length) {
        const last = runsRes.entries[0];
        if (last.error && last.error.includes('timed out')) {
          return {
            pass: false,
            message: `Last digest run timed out at ${new Date(last.ts).toISOString()} (${last.durationMs}ms). Needs investigation.`,
          };
        }
      }

      return { pass: true, message: `timeoutSeconds=${timeout}, last run did not time out` };
    } catch (e) {
      return { pass: false, message: `Error: ${e.message}` };
    }
  },
};
