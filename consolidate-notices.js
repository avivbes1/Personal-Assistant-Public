/**
 * consolidate-notices.js
 *
 * Runs periodically (every 60 min via cron). Queries all still-relevant notices,
 * sends them to Sonnet to identify duplicates/same-event groups, merges them.
 *
 * A "merged" row replaces the originals with:
 *   - row_type = 'merged'
 *   - sources  = JSON array of all source group names
 *   - content  = single best-summary written by Sonnet
 *   - group_name = primary (first) source group
 *   - relevance_date / relevance_time = from the group
 */

const https = require('https');
const { initDB, getDB } = require('./src/db');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); // YYYY-MM-DD
const SEVEN_DAYS_AGO = Date.now() - 7 * 24 * 60 * 60 * 1000;

// ── 1. Load active notices ──────────────────────────────────────────────────

function getConsolidationCandidates() {
  return getDB().prepare(`
    SELECT id, group_name, content, relevance_date, relevance_time, sources, row_type
    FROM notices
    WHERE dismissed = 0
      AND posted_to_master = 0      -- P-001/P-004: never touch sent notices
      AND triage_decision IS NULL   -- P-001: never grab in-flight triaged notices
      AND (
        relevance_date >= ?
        OR (relevance_date IS NULL AND created_at >= ?)
      )
    ORDER BY relevance_date ASC NULLS LAST, id ASC
  `).all(TODAY, SEVEN_DAYS_AGO);
}

// ── 2. Call Sonnet ──────────────────────────────────────────────────────────

function callSonnet(notices) {
  const noticeList = notices.map(n =>
    `ID:${n.id} | Group:${n.group_name} | Date:${n.relevance_date || 'none'} | Time:${n.relevance_time || 'none'}\nContent: ${n.content}`
  ).join('\n\n---\n\n');

  const prompt = `You are a deduplication agent. Below is a list of family notices extracted from WhatsApp groups.

Your job: identify groups of notices that refer to the SAME real-world event or topic. Use semantic matching — same trip, same activity, same topic = same group, even if wording differs. Different events on different dates are NOT the same group.

For each group with 2 or more notices, return a JSON object in this format:
{
  "groups": [
    {
      "ids": [1, 2, 3],
      "merged_content": "Single clear Hebrew summary combining all relevant details from the group",
      "relevance_date": "YYYY-MM-DD or null",
      "relevance_time": "HH:MM or null",
      "primary_group": "the most informative source group name"
    }
  ]
}

Notices with no duplicates should NOT appear in the output.
If there are no duplicates at all, return: { "groups": [] }
Return ONLY valid JSON, no explanation, no markdown.

NOTICES:
${noticeList}`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }]
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          let text = parsed.content[0].text.trim();
          // Strip markdown fences if present
          text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
          resolve(JSON.parse(text));
        } catch (e) {
          reject(new Error('Failed to parse Sonnet response: ' + data.substring(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── 3. Apply merges ─────────────────────────────────────────────────────────

function applyMerges(groups, allNotices) {
  const db = getDB();
  let mergedGroups = 0;
  let deletedRows = 0;

  for (const group of groups) {
    if (!group.ids || group.ids.length < 2) continue;

    // Collect source group names from original notices
    const originals = allNotices.filter(n => group.ids.includes(n.id));
    const allSources = [...new Set(originals.flatMap(n => {
      try { return JSON.parse(n.sources || '[]'); } catch { return [n.group_name]; }
    }))];

    const primaryGroup = group.primary_group || originals[0].group_name;
    const now = Date.now();

    // Insert merged row
    db.prepare(`
      INSERT INTO notices (group_name, content, relevance_date, relevance_time, source_timestamp, dismissed, created_at, row_type, sources)
      VALUES (?, ?, ?, ?, ?, 0, ?, 'merged', ?)
    `).run(
      primaryGroup,
      group.merged_content,
      group.relevance_date || null,
      group.relevance_time || null,
      now,
      now,
      JSON.stringify(allSources)
    );

    // Delete originals
    const placeholders = group.ids.map(() => '?').join(',');
    const deleted = db.prepare(`DELETE FROM notices WHERE id IN (${placeholders})`).run(...group.ids);
    deletedRows += deleted.changes;
    mergedGroups++;

    console.log(`[Consolidate] Merged ${group.ids.length} notices into 1: "${group.merged_content.substring(0, 60)}..." (deleted IDs: ${group.ids.join(',')})`);
  }

  return { mergedGroups, deletedRows };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  initDB();

  const candidates = getConsolidationCandidates();
  console.log(`[Consolidate] ${candidates.length} active notices to check`);

  if (candidates.length <= 1) {
    console.log('[Consolidate] Nothing to consolidate.');
    return;
  }

  const result = await callSonnet(candidates);

  if (!result.groups || result.groups.length === 0) {
    console.log('[Consolidate] No duplicates found.');
    return;
  }

  console.log(`[Consolidate] Found ${result.groups.length} group(s) to merge`);
  const { mergedGroups, deletedRows } = applyMerges(result.groups, candidates);
  console.log(`[Consolidate] Done. Merged ${mergedGroups} groups, deleted ${deletedRows} rows.`);
}

main().catch(err => {
  console.error('[Consolidate] Error:', err.message);
  process.exit(1);
});
