'use strict';
/**
 * claude-code/runner.js — Subprocess wrapper for Claude Code headless mode.
 *
 * - Single concurrent execution (semaphore) — t4g.medium RAM constraint
 * - Tiered timeouts passed in per call (research: 5m, code: 10m, deep: 20m)
 * - Read-only tool set — no file writes, no shell execution
 * - Clean process teardown on timeout or error
 */

const { spawn }  = require('child_process');
const crypto     = require('crypto');

const CLAUDE_BIN   = process.env.CLAUDE_BIN  || '/usr/bin/claude';
const DEFAULT_CWD  = process.env.CLAUDE_CODE_CWD || '/home/ubuntu';

// ── Semaphore (max 1 concurrent Claude Code process) ─────────────────────────

let _running = false;
const _queue = [];

function acquireSemaphore() {
  return new Promise(resolve => {
    if (!_running) {
      _running = true;
      resolve();
    } else {
      _queue.push(resolve);
    }
  });
}

function releaseSemaphore() {
  if (_queue.length > 0) {
    const next = _queue.shift();
    next();
  } else {
    _running = false;
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

/**
 * Run a task via Claude Code headless mode.
 *
 * @param {object} opts
 * @param {string}  opts.task        Full task prompt
 * @param {number}  opts.timeoutMs   Tier-specific timeout (required)
 * @param {string}  [opts.cwd]       Working directory (default: CLAUDE_CODE_CWD env or /home/ubuntu)
 * @returns {Promise<{ text: string, durationMs: number, promptHash: string }>}
 * @throws on timeout, spawn error, or non-zero exit with no output
 */
async function run({ task, timeoutMs, cwd = DEFAULT_CWD }) {
  if (!task || !task.trim()) throw new Error('[ClaudeCode] Empty task');
  if (!timeoutMs)            throw new Error('[ClaudeCode] timeoutMs required');

  const promptHash = crypto.createHash('sha256').update(task).digest('hex').slice(0, 12);

  await acquireSemaphore();
  const startMs = Date.now();
  console.log(`[ClaudeCode] Starting task hash=${promptHash} tier_timeout=${timeoutMs}ms cwd=${cwd}`);

  try {
    return await _spawnClaude({ task, timeoutMs, cwd, promptHash, startMs });
  } finally {
    releaseSemaphore();
  }
}

function _spawnClaude({ task, timeoutMs, cwd, promptHash, startMs }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', task,
      '--output-format', 'json',
      '--max-turns',     '25',
      '--bare',
      // Read-only tool set — no file writes, no shell
      '--allowedTools',  'Read,Grep,Glob,LS',
    ];

    let proc;
    try {
      proc = spawn(CLAUDE_BIN, args, {
        cwd,
        env:   { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (spawnErr) {
      return reject(new Error(`[ClaudeCode] Spawn failed: ${spawnErr.message}`));
    }

    let stdout = '';
    let stderr = '';
    let totalBytes = 0;
    const MAX_BYTES = 4 * 1024 * 1024; // 4MB hard cap

    proc.stdout.on('data', chunk => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BYTES) { proc.kill('SIGKILL'); return; }
      stdout += chunk;
    });
    proc.stderr.on('data', chunk => { stderr += chunk.slice(0, 2000); });

    // ── Timeout ────────────────────────────────────────────────────────────
    const timer = setTimeout(() => {
      console.warn(`[ClaudeCode] Timeout after ${timeoutMs}ms hash=${promptHash}`);
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 3000);
      reject(new Error(`[ClaudeCode] Timeout after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`[ClaudeCode] Process error: ${err.message}`));
    });

    proc.on('close', code => {
      clearTimeout(timer);
      const durationMs = Date.now() - startMs;

      // Auth failure detection
      if (stderr.includes('Unauthorized') || stderr.includes('authentication') || stderr.includes('logged in')) {
        return reject(new Error('[ClaudeCode] AUTH_EXPIRED'));
      }

      if (code !== 0 && !stdout.trim()) {
        return reject(new Error(`[ClaudeCode] Exit ${code}: ${stderr.slice(0, 300)}`));
      }

      // Parse JSON output — Claude Code emits a single JSON object
      let text = stdout.trim();
      try {
        const jsonLines = stdout.trim().split('\n').filter(l => l.trim().startsWith('{'));
        const lastJson  = jsonLines[jsonLines.length - 1] || '{}';
        const parsed    = JSON.parse(lastJson);

        if (parsed.is_error) {
          return reject(new Error(`[ClaudeCode] Task error: ${parsed.result || 'unknown'}`));
        }

        text = parsed.result || stdout.trim();
      } catch (_) {
        // Not JSON — use raw stdout
      }

      console.log(`[ClaudeCode] Done hash=${promptHash} duration=${durationMs}ms exit=${code}`);
      resolve({ text, durationMs, promptHash });
    });
  });
}

// ── Auth check ────────────────────────────────────────────────────────────────

/**
 * Quick auth validation — runs `claude --version`.
 * @returns {Promise<boolean>}
 */
async function checkAuth() {
  return new Promise(resolve => {
    const proc = spawn(CLAUDE_BIN, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8000,
    });
    proc.on('close', code => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

module.exports = { run, checkAuth };
