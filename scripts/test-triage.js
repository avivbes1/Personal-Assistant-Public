'use strict';
/**
 * test-triage.js — Validate triage classification against 10 labeled test cases.
 * Exit 0 if >=9/10 pass, exit 1 if <9/10.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { callHaiku, buildClassificationPrompt, CLASSIFICATION_SYSTEM } = require('../src/triage-engine');
const testCases = require('../data/triage-test-cases.json');

async function runCase(tc) {
  const prompt = buildClassificationPrompt(tc.bucket, tc.sent_today || []);
  let raw;
  try {
    raw = await callHaiku(CLASSIFICATION_SYSTEM, prompt);
  } catch (e) {
    return { pass: false, reason: 'API error: ' + e.message };
  }

  let decisions;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON');
    decisions = JSON.parse(jsonMatch[0]).decisions;
    if (!Array.isArray(decisions)) throw new Error('decisions not array');
  } catch (e) {
    return { pass: false, reason: 'parse error: ' + e.message + ' | raw: ' + raw.substring(0, 100) };
  }

  const decisionMap = {};
  for (const d of decisions) decisionMap[String(d.notice_id)] = d;

  const errors = [];

  // Check expected actions
  if (tc.expected_actions) {
    for (const [id, expectedAction] of Object.entries(tc.expected_actions)) {
      const got = decisionMap[id]?.action;
      if (got !== expectedAction) {
        errors.push(`notice ${id}: expected ${expectedAction}, got ${got}`);
      }
    }
  }

  // Check that these notice IDs all share the same merge_group
  if (tc.expected_same_merge_group && tc.expected_same_merge_group.length > 1) {
    const groups = tc.expected_same_merge_group.map(id => decisionMap[String(id)]?.merge_group);
    const allSame = groups.every(g => g && g === groups[0]);
    if (!allSame) {
      errors.push(`notices ${tc.expected_same_merge_group.join(',')} should share merge_group, got: ${groups.join(',')}`);
    }
  }

  // Check that these notice IDs have DIFFERENT merge_groups
  if (tc.expected_different_merge_groups && tc.expected_different_merge_groups.length > 1) {
    const groups = tc.expected_different_merge_groups.map(id => decisionMap[String(id)]?.merge_group).filter(Boolean);
    const allDifferent = new Set(groups).size === groups.length;
    if (!allDifferent) {
      errors.push(`notices ${tc.expected_different_merge_groups.join(',')} should have DIFFERENT merge_groups, got: ${groups.join(',')}`);
    }
  }

  const pass = errors.length === 0;
  return { pass, reason: errors.join('; '), decisions };
}

async function main() {
  console.log(`Running ${testCases.length} triage test cases...\n`);
  let passed = 0;
  let failed = 0;

  for (const tc of testCases) {
    process.stdout.write(`  ${tc.id}... `);
    const result = await runCase(tc);
    if (result.pass) {
      passed++;
      console.log('✅ PASS');
    } else {
      failed++;
      console.log('❌ FAIL —', result.reason);
      if (result.decisions) {
        console.log('     Got:', result.decisions.map(d => `#${d.notice_id}→${d.action}(${d.merge_group})`).join(', '));
      }
    }
  }

  console.log(`\n${passed}/${testCases.length} passed`);

  if (passed >= 9) {
    console.log('✅ Ready for shadow mode (≥9/10)');
    process.exit(0);
  } else {
    console.log('❌ Not ready — fix prompt before deploying');
    process.exit(1);
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
