#!/usr/bin/env node
/**
 * tune-thresholds.js — Diagnostic: measure the notice-dedup similarity
 * threshold against real data instead of guessing it.
 *
 * findDuplicates() defaults to threshold=0.65, but that number was never
 * measured. This script builds every candidate notice pair from the live DB
 * (same group, within the 48h dedup window), computes textSimilarity for each,
 * and surfaces three things:
 *
 *   1. The similarity distribution — where do pair scores actually land?
 *   2. A threshold sweep — how many pairs each cutoff flags as duplicates, and
 *      whether thread_key agrees or contradicts.
 *   3. The top-scoring pairs with their content — the real decision aid: a human
 *      eyeballs where "these are the same notice" stops being true.
 *
 * On thread_key: it is NOT a text-duplicate label. Notices sharing a thread_key
 * are usually FOLLOW-UPS ("meeting is at 18:00" after "parent meeting on 9.9")
 * with almost no word overlap — the K4 enrichment case. So we use it only as a
 * weak agree/contradict signal on the pairs text-dedup flags, never as ground
 * truth. Two notices with DIFFERENT non-null thread_keys are evidence of a false
 * positive (genuinely different topics); a shared thread_key is mild support.
 *
 * Read-only. Prints tables + a suggestion; changes nothing.
 *
 * Usage:  node scripts/tune-thresholds.js
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getDB, initDB } = require('../src/db');
const { textSimilarity, normalizeText } = require('../src/notice-dedup');

const WINDOW_MS = 48 * 60 * 60 * 1000; // must match findDuplicates()
const THRESHOLDS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];
const CURRENT_DEFAULT = 0.65;

function loadNotices() {
  initDB();
  return getDB()
    .prepare(
      `SELECT id, content, group_name, created_at, thread_key
         FROM notices
        WHERE content IS NOT NULL AND content <> ''
        ORDER BY created_at ASC`
    )
    .all();
}

/** Every pair the dedup engine would compare: same group, ≤48h apart. */
function buildPairs(notices) {
  const pairs = [];
  for (let i = 0; i < notices.length; i++) {
    for (let j = i + 1; j < notices.length; j++) {
      const a = notices[i];
      const b = notices[j];
      if (a.group_name !== b.group_name) continue;
      if (Math.abs((a.created_at || 0) - (b.created_at || 0)) > WINDOW_MS) continue;
      let threadRel = 'unknown';
      if (a.thread_key && b.thread_key) threadRel = a.thread_key === b.thread_key ? 'agree' : 'contradict';
      pairs.push({ a, b, sim: textSimilarity(a.content, b.content), threadRel });
    }
  }
  return pairs;
}

function histogram(pairs) {
  const buckets = {};
  for (const p of pairs) {
    const k = Math.min(9, Math.floor(p.sim * 10)); // 0..9 → [0.0,0.1)..[0.9,1.0]
    buckets[k] = (buckets[k] || 0) + 1;
  }
  console.log('similarity distribution (all candidate pairs):');
  for (let b = 9; b >= 0; b--) {
    const n = buckets[b] || 0;
    if (n === 0) continue;
    const lo = (b / 10).toFixed(1);
    const hi = b === 9 ? '1.0' : ((b + 1) / 10).toFixed(1);
    const bar = '█'.repeat(Math.min(50, Math.ceil(n / Math.max(1, pairs.length / 200))));
    console.log(`  [${lo}–${hi})  ${String(n).padStart(5)}  ${bar}`);
  }
  console.log('');
}

function sweep(pairs) {
  console.log('threshold sweep — of pairs flagged as duplicates, does thread_key agree?');
  console.log('threshold | flagged | thread-agree | thread-contradict | unknown');
  console.log('----------|---------|--------------|-------------------|--------');
  for (const t of THRESHOLDS) {
    const flagged = pairs.filter(p => p.sim > t);
    const agree = flagged.filter(p => p.threadRel === 'agree').length;
    const contra = flagged.filter(p => p.threadRel === 'contradict').length;
    const unk = flagged.filter(p => p.threadRel === 'unknown').length;
    const mark = t === CURRENT_DEFAULT ? '  ← current' : '';
    console.log(
      `   ${t.toFixed(2)}   |  ${String(flagged.length).padStart(4)}   ` +
      `|     ${String(agree).padStart(4)}     |       ${String(contra).padStart(4)}        ` +
      `| ${String(unk).padStart(4)}${mark}`
    );
  }
  console.log('');
}

function topPairs(pairs, n, floor) {
  const top = pairs.filter(p => p.sim >= floor).sort((x, y) => y.sim - x.sim).slice(0, n);
  console.log(`top ${top.length} pairs by similarity (≥${floor}) — manual review, is each a true duplicate?`);
  for (const p of top) {
    const flag = { agree: '≈thread', contradict: '≠thread', unknown: '?thread' }[p.threadRel];
    console.log(`\n  sim=${p.sim.toFixed(3)} [${flag}] #${p.a.id} vs #${p.b.id}`);
    console.log(`    A: ${p.a.content.replace(/\s+/g, ' ').slice(0, 90)}`);
    console.log(`    B: ${p.b.content.replace(/\s+/g, ' ').slice(0, 90)}`);
  }
  console.log('');
}

/**
 * Suggest a threshold from the observed distribution. Real near-duplicates (same
 * event, reworded) and unrelated pairs separate at a natural valley in the score
 * histogram; we place the cutoff just below the lowest score among the flagged
 * "contradict"-free region. Falls back to a printed note when data is too thin.
 */
function suggest(pairs) {
  const scored = pairs.filter(p => p.sim > 0).sort((x, y) => x.sim - y.sim);
  if (scored.length < 5) {
    console.log('Suggestion: too few non-zero pairs to tune confidently — leave at 0.65 or gather more data.\n');
    return;
  }
  // Largest gap between consecutive distinct scores in the meaningful band
  // (0.2–0.9): the top of that gap is a natural duplicate/non-duplicate divide.
  const band = [...new Set(scored.map(p => +p.sim.toFixed(3)))].filter(s => s >= 0.2 && s <= 0.9);
  let gapLo = null, gapHi = null, gap = 0;
  for (let i = 1; i < band.length; i++) {
    if (band[i] - band[i - 1] > gap) { gap = band[i] - band[i - 1]; gapLo = band[i - 1]; gapHi = band[i]; }
  }
  const contradictAt65 = pairs.filter(p => p.sim > CURRENT_DEFAULT && p.threadRel === 'contradict').length;

  console.log('── Recommendation ──────────────────────────────────────────────────');
  if (gapHi !== null) {
    const rec = +((gapLo + gapHi) / 2).toFixed(2);
    console.log(`Widest gap in the 0.2–0.9 band: ${gapLo} → ${gapHi}. A cutoff of ~${rec} sits in`);
    console.log(`that valley — below it catches paraphrased duplicates, above it are exact reposts.`);
    console.log(`Current default 0.65 flags ${pairs.filter(p => p.sim > 0.65).length} pairs ` +
      `(${contradictAt65} contradict thread_key).`);
    console.log(`\nIf paraphrased duplicates matter, LOWER the threshold toward ~${rec} and spot-check`);
    console.log(`the top-pairs list above for false positives before committing.`);
  } else {
    console.log('No clear valley in 0.2–0.9 — scores cluster at the extremes (exact reposts vs.');
    console.log('unrelated). 0.65 safely catches only near-verbatim reposts, which may be intended.');
  }
  console.log('────────────────────────────────────────────────────────────────────\n');
}

function main() {
  const notices = loadNotices();
  const pairs = buildPairs(notices);

  console.log(`\nLoaded ${notices.length} notices → ${pairs.length} candidate pairs (same group, ≤48h).\n`);
  if (pairs.length === 0) { console.log('No candidate pairs — nothing to tune.'); return; }

  histogram(pairs);
  sweep(pairs);
  topPairs(pairs, 12, 0.25);
  suggest(pairs);

  // Confirm the Hebrew normalizer is active (prefix variants must collapse).
  const demo = textSimilarity('אסיפת הורים בבית הספר מחר', 'אסיפת הורים לבית הספר מחר');
  console.log(`normalizer check — "בבית" vs "לבית": similarity ${demo.toFixed(3)} ` +
    `(1.000 = Hebrew prefix stripping active)`);
  console.log(`normalized sample: "${normalizeText('אסיפת הורים בבית הספר בשעה 18:00')}"\n`);
}

main();
