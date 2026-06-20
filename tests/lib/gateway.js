/**
 * Local OpenClaw CLI wrapper for tests.
 * Uses `openclaw` CLI commands rather than the HTTP API.
 *
 * In CI (NODE_ENV=test or CI=true), openclaw is not available.
 * Functions return empty/stub results so tests that depend on live
 * cron state gracefully skip rather than crash.
 */

const { execSync } = require('child_process');

const IS_CI = process.env.CI === 'true' || process.env.NODE_ENV === 'test';

function cli(args, { timeout = 15000 } = {}) {
  if (IS_CI) throw new Error('openclaw CLI not available in CI');
  const out = execSync(`openclaw ${args}`, {
    encoding: 'utf8',
    timeout,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

/**
 * List all cron jobs.
 * Returns { jobs: [] } in CI.
 */
function listCronJobs({ includeDisabled = false } = {}) {
  if (IS_CI) return { jobs: [] };
  const flag = includeDisabled ? ' --all' : '';
  return cli(`cron list --json${flag}`);
}

/**
 * Get a single cron job by ID.
 */
function getCronJob(jobId) {
  const result = listCronJobs({ includeDisabled: true });
  const jobs = result.jobs || result;
  const job = (Array.isArray(jobs) ? jobs : []).find(j => j.id === jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  return job;
}

/**
 * Get recent runs for a cron job.
 */
function getCronRuns(jobId, limit = 5) {
  if (IS_CI) return { runs: [] };
  return cli(`cron runs --id ${jobId} --limit ${limit}`);
}

module.exports = { listCronJobs, getCronJob, getCronRuns, IS_CI };
