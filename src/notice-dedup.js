'use strict';
/**
 * notice-dedup.js — Phase 2.2: Semantic dedup for notices via text similarity.
 *
 * Constraint: this box has 4GB RAM and can't run local embedding models, so we
 * use a lightweight lexical approach instead of vectors:
 *   normalizeText  → Hebrew-aware normalization (strip punctuation, stopwords)
 *   textSimilarity → Jaccard similarity over overlapping word-trigrams
 *   findDuplicates → cluster near-duplicates within a group + 48h window
 *
 * No external dependencies. Deterministic. Used by triage-engine before the LLM
 * classification call so obvious repeats never cost a token.
 */

// Common Hebrew stopwords + a few English fillers for mixed content. Kept
// deliberately small — over-aggressive stopword removal erases the signal that
// distinguishes two genuinely different notices.
const HEBREW_STOPWORDS = new Set([
  'את', 'של', 'על', 'עם', 'בית', 'הורים', 'הורי', 'ילדים', 'ילדי',
  'זה', 'זו', 'הוא', 'היא', 'אני', 'אנחנו', 'אתם', 'הם', 'הן',
  'יש', 'אין', 'לא', 'כן', 'גם', 'אבל', 'כי', 'אם', 'או', 'עד',
  'אל', 'כל', 'מה', 'מי', 'כמו', 'רק', 'כבר', 'עוד', 'מאוד',
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'is', 'for',
]);

// Single-letter Hebrew prefixes (prepositions / conjunctions / article) that
// attach to the following word: ב(in) ל(to) כ(as) ה(the) ו(and) מ(from) ש(that).
// Two spellings of the same stem — "בבית" vs "בית", "ולילדים" vs "ילדים" — are
// the same word for dedup purposes, so we strip these before comparison.
const HEBREW_PREFIXES = new Set(['ב', 'ל', 'כ', 'ה', 'ו', 'מ', 'ש']);
const HEBREW_LETTER = /[֐-׿]/;

/**
 * Strip leading Hebrew prefix letters from a single token, one at a time, but
 * only while the remaining stem stays ≥3 Hebrew characters. The ≥3 guard keeps
 * genuinely short words (and their leading letters) intact — e.g. "של" is left
 * alone, and "בית" (3 chars) never loses its ב. Non-Hebrew tokens pass through.
 */
function _stripHebrewPrefixes(word) {
  let w = word;
  // Require ≥4 now so ≥3 remains after removing one prefix letter. Also require
  // the next char to be a Hebrew letter so we never mangle English/mixed tokens.
  while (w.length >= 4 && HEBREW_PREFIXES.has(w[0]) && HEBREW_LETTER.test(w[1])) {
    w = w.slice(1);
  }
  return w;
}

/**
 * Hebrew morphology normalizer: apply _stripHebrewPrefixes across whitespace-
 * separated tokens. Exposed for the threshold-tuning diagnostic and reused by
 * normalizeText below so the same stemming runs in production.
 */
function _normalizeForDedup(text) {
  if (!text) return '';
  return String(text).split(/\s+/).map(_stripHebrewPrefixes).join(' ');
}

/**
 * Hebrew-aware text normalization.
 * - Lowercase (no-op for Hebrew, helps mixed Hebrew/English content)
 * - Replace punctuation with spaces, keeping letters (any script) and digits
 * - Strip single-letter Hebrew prefixes so morphological variants collapse
 * - Drop common stopwords
 * Returns a space-joined normalized string ('' for empty/nullish input).
 */
function normalizeText(text) {
  if (!text) return '';
  const lowered = String(text).toLowerCase();
  // \p{L} = any letter (incl. Hebrew), \p{N} = any number. Everything else → space.
  const stripped = lowered.replace(/[^\p{L}\p{N}]+/gu, ' ');
  const words = stripped
    .split(/\s+/)
    // Filter stopwords on the ORIGINAL token first: several curated stopwords
    // ("הורים", "ילדים") begin with a prefix letter and would be mangled — and
    // so escape the filter — if we stemmed before comparing against the set.
    .filter(w => w && !HEBREW_STOPWORDS.has(w))
    .map(_stripHebrewPrefixes);
  return words.join(' ');
}

/**
 * Build the set of overlapping word-trigrams for an array of words.
 * Fewer than 3 words → fall back to the words themselves (unigrams) so short
 * notices still compare meaningfully instead of collapsing to an empty set.
 */
function _wordTrigrams(words) {
  const grams = new Set();
  if (words.length < 3) {
    for (const w of words) grams.add(w);
    return grams;
  }
  for (let i = 0; i <= words.length - 3; i++) {
    grams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return grams;
}

/**
 * Jaccard similarity (0.0–1.0) on word-trigrams of the normalized inputs.
 * |intersection| / |union|. Returns 0 when both are empty.
 */
function textSimilarity(a, b) {
  const wa = normalizeText(a).split(/\s+/).filter(Boolean);
  const wb = normalizeText(b).split(/\s+/).filter(Boolean);
  const ta = _wordTrigrams(wa);
  const tb = _wordTrigrams(wb);
  if (ta.size === 0 && tb.size === 0) return 0;

  let intersection = 0;
  for (const g of ta) if (tb.has(g)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Find near-duplicate notices.
 *
 * For every pair of notices in the SAME group within a 48h window, compute
 * textSimilarity on their (normalized) content. If it exceeds `threshold`, the
 * newer notice is marked a duplicate of the older one (the "original").
 *
 * @param {Array<{id:number, content:string, group_name:string, created_at:number}>} notices
 * @param {number} threshold  similarity above which two notices are duplicates
 * @returns {Map<number, {isDuplicate:boolean, originalId:number, similarity:number}>}
 *          one entry per duplicate notice (originals are absent from the map)
 */
function findDuplicates(notices, threshold = 0.65) {
  const result = new Map();
  const WINDOW_MS = 48 * 60 * 60 * 1000;

  // Oldest first so the earliest notice in a cluster becomes the "original".
  const sorted = [...notices].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

  for (let j = 0; j < sorted.length; j++) {
    const newer = sorted[j];
    if (result.has(newer.id)) continue; // already flagged against an earlier original

    let best = null;
    for (let i = 0; i < j; i++) {
      const older = sorted[i];
      if (result.has(older.id)) continue; // don't chain: originals must be non-duplicates
      if (older.group_name !== newer.group_name) continue;
      const dt = Math.abs((newer.created_at || 0) - (older.created_at || 0));
      if (dt > WINDOW_MS) continue;

      const sim = textSimilarity(older.content, newer.content);
      if (sim > threshold && (!best || sim > best.similarity)) {
        best = { isDuplicate: true, originalId: older.id, similarity: sim };
      }
    }
    if (best) result.set(newer.id, best);
  }

  return result;
}

module.exports = { normalizeText, textSimilarity, findDuplicates, _normalizeForDedup };
