#!/usr/bin/env node
/**
 * audio-wer.js — Word Error Rate evaluation for Hebrew audio transcription.
 *
 * Compares Groq Whisper vs ivrit.ai transcription against hand-transcribed
 * fixtures. Each fixture is a JSON file in tests/eval/media/fixtures/:
 *
 *   { "audio": "<path-to-audio-file>",
 *     "reference": "<hand-transcribed Hebrew text>",
 *     "source": "voice_note|announcement|mixed",
 *     "notes": "optional context" }
 *
 * Usage:
 *   node tests/eval/media/audio-wer.js [--groq-only] [--ivrit-only]
 *
 * Results written to tests/eval/media/audio-wer.json.
 *
 * NOTE: requires actual audio fixtures to be populated. Until then,
 * this script validates the infrastructure and exits with 0 fixtures.
 */

const fs = require('fs');
const path = require('path');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/**
 * Compute Word Error Rate between reference and hypothesis.
 * WER = (substitutions + insertions + deletions) / reference_words
 * Uses simple Levenshtein on word arrays.
 */
function computeWER(reference, hypothesis) {
  const ref = reference.trim().split(/\s+/).filter(Boolean);
  const hyp = hypothesis.trim().split(/\s+/).filter(Boolean);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;

  const n = ref.length;
  const m = hyp.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,       // deletion
        dp[i][j - 1] + 1,       // insertion
        dp[i - 1][j - 1] + cost  // substitution
      );
    }
  }

  return dp[n][m] / n;
}

async function main() {
  if (!fs.existsSync(FIXTURES_DIR)) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
    console.log('[WER] Created fixtures directory. Add audio fixture JSON files to:', FIXTURES_DIR);
    console.log('[WER] 0 fixtures found — nothing to evaluate.');
    process.exit(0);
  }

  const fixtureFiles = fs.readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json'))
    .sort();

  if (fixtureFiles.length === 0) {
    console.log('[WER] 0 audio fixtures found in', FIXTURES_DIR);
    console.log('[WER] To add fixtures, create JSON files with: { audio, reference, source, notes }');
    console.log('[WER] Audio files will come from voice notes in monitored groups.');
    process.exit(0);
  }

  console.log(`[WER] Found ${fixtureFiles.length} audio fixtures`);

  const results = [];
  for (const file of fixtureFiles) {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));
    if (!fixture.audio || !fixture.reference) {
      console.warn(`[WER] Skipping ${file}: missing audio or reference`);
      continue;
    }

    if (!fs.existsSync(fixture.audio)) {
      console.warn(`[WER] Skipping ${file}: audio file not found: ${fixture.audio}`);
      continue;
    }

    console.log(`[WER] Evaluating: ${file}`);
    const audioBuffer = fs.readFileSync(fixture.audio);
    const mimeType = fixture.mime || 'audio/ogg';

    const entry = { fixture: file, reference: fixture.reference, source: fixture.source };

    // Test with Groq
    if (!process.argv.includes('--ivrit-only')) {
      try {
        const { transcribeAudio } = require('../../src/media-parser');
        // Temporarily disable ivrit to test Groq alone
        process.env.USE_IVRIT_WHISPER = '0';
        const groqResult = await transcribeAudio(audioBuffer, mimeType);
        process.env.USE_IVRIT_WHISPER = '1';
        entry.groq = groqResult || '';
        entry.groq_wer = computeWER(fixture.reference, entry.groq);
      } catch (e) {
        entry.groq = '';
        entry.groq_wer = 1;
        entry.groq_error = e.message;
      }
    }

    // Test with ivrit.ai
    if (!process.argv.includes('--groq-only')) {
      try {
        // Import the ivrit function directly
        const mediaParser = require('../../src/media-parser');
        process.env.USE_IVRIT_WHISPER = '1';
        const ivritResult = await mediaParser.transcribeAudio(audioBuffer, mimeType);
        entry.ivrit = ivritResult || '';
        entry.ivrit_wer = computeWER(fixture.reference, entry.ivrit);
      } catch (e) {
        entry.ivrit = '';
        entry.ivrit_wer = 1;
        entry.ivrit_error = e.message;
      }
    }

    results.push(entry);
    console.log(`  Groq WER: ${entry.groq_wer?.toFixed(3) || 'n/a'} | ivrit.ai WER: ${entry.ivrit_wer?.toFixed(3) || 'n/a'}`);
  }

  // Summary
  const groqAvg = results.filter(r => r.groq_wer != null).reduce((s, r) => s + r.groq_wer, 0) / (results.filter(r => r.groq_wer != null).length || 1);
  const ivritAvg = results.filter(r => r.ivrit_wer != null).reduce((s, r) => s + r.ivrit_wer, 0) / (results.filter(r => r.ivrit_wer != null).length || 1);

  const summary = {
    generated_at: new Date().toISOString(),
    fixture_count: results.length,
    groq_avg_wer: groqAvg,
    ivrit_avg_wer: ivritAvg,
    winner: ivritAvg < groqAvg ? 'ivrit.ai' : groqAvg < ivritAvg ? 'groq' : 'tie',
    details: results,
  };

  const outPath = path.join(__dirname, 'audio-wer.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`\n[WER] Results written to ${outPath}`);
  console.log(`[WER] Groq avg WER: ${groqAvg.toFixed(3)} | ivrit.ai avg WER: ${ivritAvg.toFixed(3)} | Winner: ${summary.winner}`);
}

module.exports = { computeWER };
main().catch(e => { console.error(e); process.exit(1); });
