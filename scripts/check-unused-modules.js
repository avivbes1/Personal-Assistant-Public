#!/usr/bin/env node
'use strict';

/**
 * check-unused-modules.js — fail the build when a src/ module is dead code (M3).
 *
 * Every .js under src/ must either be require()'d by another src/ file or be a
 * known entry point (a process/cron/CLI target that is launched directly and so
 * has no in-tree importer). Anything else is an orphan: it drifts out of sync,
 * gets half-refactored, and quietly rots. This is a cheap CI guard against that.
 *
 * Usage:
 *   node scripts/check-unused-modules.js      # exits 1 if any orphan is found
 *
 * It is also run from the test suite via tests/unit/no-orphan-modules.test.js.
 *
 * When you legitimately add a new entry point (something started with
 * `node src/<file>.js`, a cron target, or a standalone worker), add its
 * src-relative path to ENTRY_POINTS below.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

// Files with no in-tree importer that are nonetheless "live": process entry
// points, cron/PM2 targets, and directly-invoked CLI workers. Paths are
// relative to src/ and use forward slashes.
const ENTRY_POINTS = new Set([
  'index.js',            // main process (npm start)
  'voice-server.js',     // HTTP server on :3001 (started by index.js/PM2)
  'triage-engine.js',    // cron: TRIAGE_MODE digest/immediate worker
  'dead-letter-scan.js', // cron/CLI: dead-letter sweep
  'pipeline-monitor.js', // cron/CLI: pipeline health monitor
  'smoke.js',            // manual smoke test entry point
  // Consumed out-of-process by the external OpenClaw/Lipa reminder heartbeat
  // (require('.../reminderJob').runReminderJob()); no in-repo importer by design.
  'heartbeat/reminderJob.js',
]);

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Resolve a require() specifier to an absolute file path, or null for bare
// package imports / unresolvable paths.
function resolveRequire(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // node_modules / builtin
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch (_) { /* not this one */ }
  }
  return null;
}

const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * @returns {{ files: string[], orphans: string[], imported: Set<string> }}
 */
function scan() {
  const files = walk(SRC);
  const imported = new Set();

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    let m;
    REQUIRE_RE.lastIndex = 0;
    while ((m = REQUIRE_RE.exec(src)) !== null) {
      const resolved = resolveRequire(file, m[1]);
      if (resolved && resolved.startsWith(SRC + path.sep)) imported.add(resolved);
    }
  }

  const orphans = files.filter(f => {
    const rel = path.relative(SRC, f).split(path.sep).join('/');
    return !imported.has(f) && !ENTRY_POINTS.has(rel);
  });

  return { files, orphans, imported };
}

// Test-suite hook (tests/run-all.js contract).
function run() {
  const { files, orphans } = scan();
  if (orphans.length === 0) {
    return { pass: true, message: `check-unused-modules: all ${files.length} src/ modules imported or allowlisted` };
  }
  const list = orphans.map(f => path.relative(process.cwd(), f)).join(', ');
  return { pass: false, message: `check-unused-modules: ${orphans.length} orphaned module(s): ${list}` };
}

module.exports = { scan, run, ENTRY_POINTS };

// ── Standalone CLI ──────────────────────────────────────────────────────────
if (require.main === module) {
  const { files, orphans } = scan();
  if (orphans.length > 0) {
    console.error(`❌ ${orphans.length} orphaned module(s) in src/ (no importer, not an allowlisted entry point):\n`);
    for (const f of orphans) console.error(`   - ${path.relative(process.cwd(), f)}`);
    console.error(
      '\nFix by one of:\n' +
      '  • require() the file from where it is actually used, or\n' +
      '  • delete it if it is dead code, or\n' +
      '  • add its src-relative path to ENTRY_POINTS in scripts/check-unused-modules.js\n' +
      '    (only if it is a real process/cron/CLI entry point).'
    );
    process.exit(1);
  }
  console.log(`✅ check-unused-modules: all ${files.length} src/ modules are imported or allowlisted entry points.`);
}
