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

require('dotenv').config();
const https = require('https');
const { initDB, getDB } = require('./src/db');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('[Consolidate] FATAL: ANTHROPIC_API_KEY not set. Check .env file.');
  process.exit(1);
}
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); // YYYY-MM-DD
const SEVEN_DAYS_AGO = Date.now() - 7 * 24 * 60 * 60 * 1000;

// ── 1. Load active notices ──────────────────────────────────────────────────

function getConsolidationCandidates() {
  // BUG-FIX 2026-08-13: removed posted_to_master=0 and triage_decision IS NULL filters.
  // Those filters meant consolidation never saw notices because the triage engine (every 5min)
  // set triage_decision before consolidation (hourly) ran. Result: 0 candidates for months.
  // Now we consolidate ALL non-dismissed, non-merged notices regardless of triage/delivery state.
  return getDB().prepare(`
    SELECT id, group_name, content, relevance_date, relevance_time, sources, row_type,
           posted_to_master, triage_decision, delivery_status, digest_shown_at,
           calendar_status, calendar_event_id
    FROM notices
    WHERE dismissed = 0
      AND row_type != 'merged'       -- don't re-merge already-merged rows
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

    // Inherit delivery/triage state from originals so we don't re-deliver or re-triage
    const anyPosted = originals.some(n => n.posted_to_master) ? 1 : 0;
    const anyDelivered = originals.find(n => n.delivery_status && n.delivery_status.startsWith('delivered'));
    const deliveryStatus = anyDelivered ? anyDelivered.delivery_status : (originals[0].delivery_status || null);
    const triageDecision = originals.find(n => n.triage_decision === 'send_now')?.triage_decision
      || originals.find(n => n.triage_decision)?.triage_decision || null;
    const digestShownAt = Math.max(...originals.map(n => n.digest_shown_at || 0)) || null;
    const calendarStatus = originals.find(n => n.calendar_status === 'applied')?.calendar_status || null;
    const calendarEventId = originals.find(n => n.calendar_event_id)?.calendar_event_id || null;

    // Insert merged row with inherited state
    db.prepare(`
      INSERT INTO notices (group_name, content, relevance_date, relevance_time, source_timestamp,
        dismissed, created_at, row_type, sources, posted_to_master, delivery_status,
        triage_decision, digest_shown_at, calendar_status, calendar_event_id)
      VALUES (?, ?, ?, ?, ?, 0, ?, 'merged', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      primaryGroup,
      group.merged_content,
      group.relevance_date || null,
      group.relevance_time || null,
      now,
      now,
      JSON.stringify(allSources),
      anyPosted,
      deliveryStatus,
      triageDecision,
      digestShownAt,
      calendarStatus,
      calendarEventId
    );

    // Reassign notice_event rows from originals to the new merged notice
    const mergedId = db.prepare('SELECT last_insert_rowid() as id').get().id;
    const idPlaceholders = group.ids.map(() => '?').join(',');
    db.prepare(`UPDATE notice_event SET notice_id = ? WHERE notice_id IN (${idPlaceholders})`)
      .run(mergedId, ...group.ids);

    // Delete originals
    const deleted = db.prepare(`DELETE FROM notices WHERE id IN (${idPlaceholders})`).run(...group.ids);
    deletedRows += deleted.changes;
    mergedGroups++;

    console.log(`[Consolidate] Merged ${group.ids.length} notices into 1 (id=${mergedId}): "${group.merged_content.substring(0, 60)}..." (deleted IDs: ${group.ids.join(',')})`);
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
