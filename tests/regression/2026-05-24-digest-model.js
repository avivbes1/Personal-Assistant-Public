/**
 * Regression: 2026-05-24 (model downgrade)
 * Incident: Morning digest model was changed from claude-sonnet-4-6 to
 *   google/gemini-3.1-flash-lite-preview. Gemini produced garbage output on
 *   multiple occasions (XML syntax, timeout, unreliable delivery).
 * Update 2026-05-26: Approved quality models expanded to include Moonshot Kimi K2.
 *
 * This test ensures the morning digest stays on an approved quality model.
 * If someone changes it to a cheap/unreliable one, this test fails.
 */

const { IS_CI, getCronJob } = require('../lib/gateway');

const DIGEST_JOB_ID = 'd782f168-d74e-4585-b4f4-609e487afb9e';

// Approved models for the Morning Digest — must be quality models, not cheap ones.
// Update this list when a deliberate model change is approved.
const APPROVED_MODELS = [
  'anthropic/claude-sonnet-4-6',
  'anthropic/claude-sonnet-4-5',
  'anthropic/claude-opus-4',
  'moonshot/kimi-k2.6',
  'moonshot/kimi-k2.5',
  'nvidia/moonshotai/kimi-k2.5',
  'nvidia/moonshotai/kimi-k2.6',
];

module.exports = {
  async run() {
    if (IS_CI) return { pass: true, message: "Skipped in CI (requires live OpenClaw)" };
    try {
      const job = getCronJob(DIGEST_JOB_ID);
      const model = job.payload?.model;
      if (!model) {
        return { pass: false, message: 'Morning digest has no explicit model set — defaults are risky' };
      }

      const isApproved = APPROVED_MODELS.some(m => model === m);

      if (!isApproved) {
        return {
          pass: false,
          message: `Morning digest is running on "${model}" — not in approved list. Change it back.`,
        };
      }

      return { pass: true, message: `Morning digest model: ${model} ✓` };
    } catch (e) {
      return { pass: false, message: `Error: ${e.message}` };
    }
  },
};
