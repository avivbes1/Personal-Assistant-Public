/**
 * Local OpenClaw CLI wrapper for tests.
 * Uses `openclaw` CLI commands rather than the HTTP API.
 */

const { execSync } = require('child_process');

function cli(args, { timeout = 15000 } = {}) {
  const out = execSync(`openclaw ${args}`, {
    encoding: 'utf8',
    timeout,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

/**
 * List all cron jobs.
 */
function listCronJobs({ includeDisabled = false } = {}) {
  // openclaw cron list outputs JSON directly
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
  return cli(`cron runs --id ${jobId} --limit ${limit}`);
}

module.exports = { listCronJobs, getCronJob, getCronRuns };
