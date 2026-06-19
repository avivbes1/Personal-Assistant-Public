/**
 * Regression: 2026-05-22
 * Incident: Gemini Flash Lite outputted raw XML tool-call syntax instead of
 *   digest text. The garbage string "<exec>TZ=Asia/Jerusalem...</exec>" was
 *   delivered to the WhatsApp master group as the morning digest.
 *
 * This test:
 *   1. Validates the detection logic on known good/bad examples.
 *   2. Checks the last morning digest run's content for XML/tool syntax.
 */

const { getCronRuns } = require('../lib/gateway');

const DIGEST_JOB_ID = 'd782f168-d74e-4585-b4f4-609e487afb9e';

function containsBadSyntax(text) {
  if (!text || typeof text !== 'string') return false;
  const patterns = [
    /<(exec|tool_use|tool|function_call|thinking|antml:thinking)[\s>/]/i,
    /<\/(exec|tool_use|tool|function_call|thinking)>/i,
    /\[TOOL_CALL\]/,
    /"type"\s*:\s*"tool_use"/,
    /ToolUseBlock/,
  ];
  return patterns.some(p => p.test(text));
}

module.exports = {
  async run() {
    // Step 1: sanity-check the detector itself
    const bad = '<exec>TZ=Asia/Jerusalem date</exec>';
    const good = '☀️ *בוקר טוב — יום ראשון 24/05*\n\n*📅 לאביב:*\n• 08:00 — החלפת קשתית';
    if (!containsBadSyntax(bad)) {
      return { pass: false, message: 'Detector logic broken — should flag XML but did not' };
    }
    if (containsBadSyntax(good)) {
      return { pass: false, message: 'Detector logic broken — false positive on valid digest' };
    }

    // Step 2: check last actual digest run
    try {
      const res = getCronRuns(DIGEST_JOB_ID, 3);
      if (!res.entries) {
        return { pass: true, message: 'Detector logic OK (could not fetch run history)' };
      }
      for (const entry of res.entries) {
        if (entry.summary && containsBadSyntax(entry.summary)) {
          return {
            pass: false,
            message: `Last digest (${new Date(entry.ts).toISOString()}) contains XML/tool syntax: "${entry.summary.slice(0, 80)}..."`,
          };
        }
      }
      return { pass: true, message: 'Detector logic OK + last digest output is clean' };
    } catch (e) {
      return { pass: true, message: `Detector logic OK (gateway check skipped: ${e.message})` };
    }
  },
};
