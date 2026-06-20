/**
 * Regression: 2026-05-26
 * Incident: google/gemini-3.1-flash-lite-preview returned 404 (model deprecated).
 *           nvidia/moonshotai/kimi-k2.6 was set on Morning Digest — OpenClaw
 *           didn't recognize it. Both failed silently in production for hours.
 *
 * This test pings every model configured in an enabled cron job.
 * A 404, auth error, or unknown-model error causes the test to fail.
 * Run this before deploying any model change to a cron job.
 */

const { execSync } = require('child_process');
const { listCronJobs } = require('../lib/gateway');

// Quick 1-token ping per provider
async function pingModel(model) {
  if (!model) return { ok: true, note: 'no model set (uses default)' };

  const [provider] = model.split('/');

  try {
    if (provider === 'anthropic') {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return { ok: false, error: 'ANTHROPIC_API_KEY not set' };
      const res = JSON.parse(execSync(`curl -s -X POST https://api.anthropic.com/v1/messages \
        -H "x-api-key: ${key}" \
        -H "anthropic-version: 2023-06-01" \
        -H "content-type: application/json" \
        -d '{"model":"${model.replace('anthropic/','')}","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'`,
        { encoding: 'utf8', timeout: 15000 }));
      if (res.error) return { ok: false, error: res.error.message };
      return { ok: true };
    }

    if (provider === 'google') {
      const key = process.env.GEMINI_API_KEY;
      if (!key) return { ok: false, error: 'GEMINI_API_KEY not set' };
      const modelId = model.replace('google/', '');
      const res = JSON.parse(execSync(`curl -s -X POST \
        "https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${key}" \
        -H "Content-Type: application/json" \
        -d '{"contents":[{"parts":[{"text":"hi"}]}]}'`,
        { encoding: 'utf8', timeout: 15000 }));
      if (res.error) {
        // 429 = rate limited but model exists and key is valid — not a real failure
        if (res.error.code === 429) return { ok: true, note: 'rate limited (model exists)' };
        return { ok: false, error: `${res.error.code}: ${res.error.message}` };
      }
      return { ok: true };
    }

    if (provider === 'moonshot') {
      const key = process.env.MOONSHOT_API_KEY;
      if (!key) return { ok: false, error: 'MOONSHOT_API_KEY not set' };
      const modelId = model.replace('moonshot/', '');
      const res = JSON.parse(execSync(`curl -s -X POST https://api.moonshot.ai/v1/chat/completions \
        -H "Authorization: Bearer ${key}" \
        -H "Content-Type: application/json" \
        -d '{"model":"${modelId}","messages":[{"role":"user","content":"hi"}],"max_tokens":1}'`,
        { encoding: 'utf8', timeout: 15000 }));
      if (res.error) return { ok: false, error: res.error.message || JSON.stringify(res.error) };
      return { ok: true };
    }

    if (provider === 'nvidia') {
      const key = process.env.NVIDIA_API_KEY;
      if (!key) return { ok: false, error: 'NVIDIA_API_KEY not set' };
      const modelId = model.replace('nvidia/', '');
      const res = JSON.parse(execSync(`curl -s -X POST https://integrate.api.nvidia.com/v1/chat/completions \
        -H "Authorization: Bearer ${key}" \
        -H "Content-Type: application/json" \
        -d '{"model":"${modelId}","messages":[{"role":"user","content":"hi"}],"max_tokens":1,"stream":false}'`,
        { encoding: 'utf8', timeout: 15000 }));
      if (res.error) return { ok: false, error: res.error.message || JSON.stringify(res.error) };
      return { ok: true };
    }

    return { ok: true, note: `provider "${provider}" not checked (no ping impl)` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Load env from openclaw.json
function loadEnv() {
  try {
    const fs = require('fs');
    const path = require('os').homedir() + '/.openclaw/openclaw.json';
    const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
    Object.assign(process.env, cfg.env || {});
  } catch (_) {}
}

module.exports = {
  async run() {
    // Skip in CI — test makes real API calls, not suitable for mock env
    if (process.env.NODE_ENV === 'test' || process.env.CI) {
      return { pass: true, message: 'Skipped in CI (requires live API keys)' };
    }
    loadEnv();

    let jobs;
    try {
      const result = listCronJobs({ includeDisabled: false });
      jobs = result.jobs || result;
    } catch (e) {
      return { pass: false, message: `Could not list cron jobs: ${e.message}` };
    }

    const failures = [];
    const checked = [];

    for (const job of jobs) {
      const model = job.payload?.model;
      if (!model) continue;

      const result = await pingModel(model);
      const label = `[${job.name || job.id}] ${model}`;

      if (!result.ok) {
        failures.push(`${label} → ${result.error}`);
      } else {
        checked.push(`${label} ✓${result.note ? ' (' + result.note + ')' : ''}`);
      }
    }

    if (failures.length > 0) {
      return {
        pass: false,
        message: `${failures.length} model(s) failed:\n${failures.join('\n')}\n\nPassing:\n${checked.join('\n')}`,
      };
    }

    return {
      pass: true,
      message: `All ${checked.length} model(s) reachable:\n${checked.join('\n')}`,
    };
  },
};
