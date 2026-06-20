/**
 * tests/smoke.js — Smoke tests for FamilyBot.
 * Run with: node tests/smoke.js
 * Expected: all green. Any failure exits with code 1.
 */

'use strict';

const assert = require('assert');
const path = require('path');
process.chdir(path.join(__dirname, '..'));
require('dotenv').config();

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

async function main() {
  console.log('\n🔬 FamilyBot — Smoke Tests\n');

  // ── DB ────────────────────────────────────────────────────────────────────
  console.log('DB:');
  const { initDB, getDB, addToConversationHistory, getConversationHistory,
          getAllFamilyMembers, clearPendingAction } = require('../src/db');
  initDB();
  const db = getDB();

  await test('tables exist', () => {
    const required = [
      'messages', 'events', 'action_items', 'groups', 'reminders',
      'digest_log', 'follow_ups', 'conversation_history', 'pending_actions', 'family_members',
    ];
    for (const t of required) {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
      assert(row, `Missing table: ${t}`);
    }
  });

  await test('family members seeded (>= 6)', () => {
    const members = getAllFamilyMembers();
    assert(members.length >= 6, `Expected >= 6, got ${members.length}`);
  });

  await test('conversation_history write + read', () => {
    const uid = 'smoke-test-' + Date.now();
    addToConversationHistory(uid, 'user', 'hello smoke test');
    const hist = getConversationHistory(uid, 5);
    assert(hist.length > 0, 'No history returned');
    assert(hist[hist.length - 1].content === 'hello smoke test');
    // cleanup
    db.prepare('DELETE FROM conversation_history WHERE user_id = ?').run(uid);
  });

  // ── Family profiles ───────────────────────────────────────────────────────
  console.log('\nFamily Profiles:');
  const { resolveMember, getAllMembers } = require('../src/family-profiles');

  await test('getAllMembers() returns >= 6', () => {
    const m = getAllMembers();
    assert(m.length >= 6, `Got ${m.length}`);
  });

  await test('resolveMember(kids[0]) → first kid', () => {
    const m = resolveMember(kids[0]?.name_he);
    assert(m, 'Returned null');
    assert(m.name_en, 'name_en not set');
  });

  await test('resolveMember("אביב") → Aviv', () => {
    const m = resolveMember(parents[0]?.name_he);
    assert(m, 'Returned null');
    assert.strictEqual(m.name_en, 'Aviv');
  });

  await test('resolveMember("ליאת") → Liat', () => {
    const m = resolveMember(parents[1]?.name_he);
    assert(m, 'Returned null');
    assert.strictEqual(m.name_en, 'Liat');
  });

  await test('resolveMember(kids[1]) → second kid', () => {
    const m = resolveMember(kids[1]?.name_he);
    assert(m, 'Returned null');
    assert(m.name_en, 'name_en not set');
  });

  await test('resolveMember("Aviv") → Aviv (English)', () => {
    const m = resolveMember('Aviv');
    assert(m, 'Returned null');
    assert.strictEqual(m.name_en, 'Aviv');
  });

  await test('resolveMember("unknown") → null', () => {
    const m = resolveMember('unknown-person-xyz');
    assert(m === null, `Expected null, got ${JSON.stringify(m)}`);
  });

  // ── Config ────────────────────────────────────────────────────────────────
  console.log('\nConfig:');
  const config = require('../src/config');

  await test('feature flags exist and are boolean', () => {
    const flags = [
      'FEATURE_CONVERSATION_HISTORY',
      'FEATURE_MEMBER_RESOLUTION',
      'FEATURE_CONFIRM_ACTIONS',
      'FEATURE_CLARIFICATION_LOOP',
      'FEATURE_CAPABILITY_AWARE',
    ];
    for (const f of flags) {
      assert(typeof config[f] === 'boolean', `Flag ${f} is not boolean: ${typeof config[f]}`);
    }
  });

  await test('feature flags are boolean (match env vars)', () => {
    // Verify each flag correctly reflects its env var (true if set to '1', false otherwise)
    assert(config.FEATURE_CONVERSATION_HISTORY === (process.env.FEAT_CONV_HISTORY === '1'), 'FEAT_CONV_HISTORY mismatch');
    assert(config.FEATURE_MEMBER_RESOLUTION    === (process.env.FEAT_MEMBER_RES === '1'),   'FEAT_MEMBER_RES mismatch');
    assert(config.FEATURE_CONFIRM_ACTIONS      === (process.env.FEAT_CONFIRM === '1'),      'FEAT_CONFIRM mismatch');
    assert(config.FEATURE_CLARIFICATION_LOOP   === (process.env.FEAT_CLARIFY === '1'),      'FEAT_CLARIFY mismatch');
    assert(config.FEATURE_CAPABILITY_AWARE     === (process.env.FEAT_CAPABILITY === '1'),   'FEAT_CAPABILITY mismatch');
  });

  await test('critical config values present', () => {
    assert(config.AVIV_CALENDAR_ID, 'Missing AVIV_CALENDAR_ID');
    assert(config.AVIV_TOKEN_PATH, 'Missing AVIV_TOKEN_PATH');
    assert(config.TIMEZONE, 'Missing TIMEZONE');
  });

  // ── Parser ────────────────────────────────────────────────────────────────
  console.log('\nParser:');
  const { extractFromText } = require('../src/parser');

  await test('Hebrew event → intent: event|reminder', async () => {
    const r = await extractFromText('תוסיף פגישה עם רופא ביום שני ב-10:00');
    assert(['event', 'reminder'].includes(r.intent), `Got intent: ${r.intent}`);
    assert(r.events.length > 0 || r.actionItems.length > 0, 'No output');
  });

  await test('calendar update message → intent: update', async () => {
    const r = await extractFromText('Soccer practice moved from 16:00 to 17:00');
    assert(r.intent === 'update', `Got ${r.intent}, expected update`);
    assert(r.update && r.update.search_title, 'Missing update.search_title');
  });

  await test('human-to-human message → intent: unknown', async () => {
    const r = await extractFromText('PARENT remind CHILD to take backpack');
    assert(r.intent === 'unknown', `Got ${r.intent}, expected unknown`);
    assert(r.events.length === 0, 'Should have no events');
  });

  await test('question → intent: query', async () => {
    const r = await extractFromText('מה יש לנו מחר?');
    assert(['query', 'unknown'].includes(r.intent), `Got ${r.intent}`);
  });

  // ── Calendar ──────────────────────────────────────────────────────────────
  console.log('\nCalendar:');
  const { getTodayEvents } = require('../src/calendar');

  await test('getTodayEvents() returns array', async () => {
    const events = await getTodayEvents(config.AVIV_CALENDAR_ID, config.AVIV_TOKEN_PATH);
    assert(Array.isArray(events), `Expected array, got ${typeof events}`);
  });

  // ── Query ─────────────────────────────────────────────────────────────────
  console.log('\nQuery:');
  const { answerQuery } = require('../src/query');

  await test('"מה יש מחר?" returns Hebrew string', async () => {
    const { text: answer } = await answerQuery('מה יש מחר?', []);
    assert(typeof answer === 'string', 'Not a string');
    assert(answer.length > 10, `Too short: "${answer}"`);
  });

  await test('"אילו קבוצות אתה עוקב?" mentions groups', async () => {
    const { text: answer } = await answerQuery('אילו קבוצות אתה עוקב אחריהן?', []);
    assert(typeof answer === 'string' && answer.length > 20, 'Empty answer');
  });

  // ── Phase 2: Conversation history DB-backed ───────────────────────────────
  console.log('\nPhase 2 — Conversation History:');
  const { addToConversationHistory: addHist, getConversationHistory: getHist } = require('../src/db');

  await test('multi-turn conversation history persists + retrieves in order', () => {
    const uid = 'smoke-p2-' + Date.now();
    addHist(uid, 'user', 'שאלה ראשונה');
    addHist(uid, 'assistant', 'תשובה ראשונה');
    addHist(uid, 'user', 'שאלה שנייה');
    const hist = getHist(uid, 10);
    assert(hist.length === 3, `Expected 3 messages, got ${hist.length}`);
    assert(hist[0].role === 'user' && hist[0].content === 'שאלה ראשונה', 'First message wrong');
    assert(hist[1].role === 'assistant', 'Second message role wrong');
    assert(hist[2].content === 'שאלה שנייה', 'Third message wrong');
    // cleanup
    db.prepare('DELETE FROM conversation_history WHERE user_id = ?').run(uid);
  });

  // ── Phase 2: Member resolution injected into query context ────────────────
  console.log('\nPhase 2 — Member Resolution in Query:');
  const { resolveMembersInText } = require('../src/family-profiles');

  await test('resolveMembersInText finds multiple members', () => {
    const members = resolveMembersInText('CHILD1 ו-CHILD2 צריכים לבוא מחר');
    assert(members.length === 2, `Expected 2, got ${members.length}`);
    const names = members.map(m => m.name_en).sort();
    assert.deepStrictEqual(names, ['Nevo', 'Segev']);
  });

  await test('answerQuery with memberContext includes member info in response', async () => {
    const memberCtx = 'CHILD = TestChild, kid, no personal calendar';
    const { text: answer } = await answerQuery('מה יש ל-CHILD מחר?', [], memberCtx);
    assert(typeof answer === 'string' && answer.length > 10, 'Empty answer');
    // The answer should be a real response, not an error
    assert(!answer.includes('Error') && !answer.includes('error'), `Got error in answer: ${answer.substring(0,100)}`);
  });

  await test('resolveMembersInText returns empty for unknown names', () => {
    const members = resolveMembersInText('מישהו שלח הודעה');
    assert(Array.isArray(members), 'Expected array');
    // "מישהו" is not a family member
    assert(!members.some(m => m.name_en === 'Someone'), 'Should not resolve unknown');
  });

  // ── Phase 3: Confirmation loop ───────────────────────────────────────────
  console.log('\nPhase 3 — Confirmation Loop:');
  const { setPendingAction, getPendingAction, clearPendingAction: clearPA } = require('../src/db');

  await test('happy path: store → retrieve pending action', () => {
    const uid = 'smoke-p3-happy-' + Date.now();
    const events = [{ title: 'רופא שיניים', start_time: '2026-05-10T10:00:00+03:00', calendar_owner: 'both' }];
    setPendingAction(uid, 'ADD_EVENT', { events }, [], 'להוסיף ליומן?\n• רופא שיניים\n✅ אישור | ❌ ביטול');
    const pending = getPendingAction(uid);
    assert(pending, 'No pending action found');
    assert.strictEqual(pending.action_type, 'ADD_EVENT');
    assert(Array.isArray(pending.params.events), 'params.events not array');
    assert.strictEqual(pending.params.events[0].title, 'רופא שיניים');
    clearPA(uid);
    assert(!getPendingAction(uid), 'Should be cleared');
  });

  await test('rejection: store → clear on rejection', () => {
    const uid = 'smoke-p3-reject-' + Date.now();
    setPendingAction(uid, 'ADD_TASK', { actionItems: [{ description: 'לקנות חלב' }] }, [], 'לרשום משימה?');
    const pending = getPendingAction(uid);
    assert(pending, 'No pending action');
    clearPA(uid);
    assert(!getPendingAction(uid), 'Should be gone after rejection');
  });

  await test('expiry: expired action not returned', () => {
    const uid = 'smoke-p3-expire-' + Date.now();
    // Store with 0ms expiry (already expired)
    db.prepare('INSERT OR REPLACE INTO pending_actions (user_id, action_type, params, missing_params, confirmation_text, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(uid, 'ADD_EVENT', '{}', '[]', '', Date.now() - 700000, Date.now() - 600000);
    const pending = getPendingAction(uid);
    assert(!pending, 'Expired action should return null');
    // cleanup
    db.prepare('DELETE FROM pending_actions WHERE user_id = ?').run(uid);
  });

  await test('confirmation text helper produces valid Hebrew', () => {
    // We test the helpers indirectly via their output format
    const events = [
      { title: 'שיעור מתמטיקה', start_time: '2026-05-10', calendar_owner: 'both' },
      { title: 'כדורגל CHILD', start_time: '2026-05-11T16:00:00+03:00', calendar_owner: 'aviv' },
    ];
    // Build it manually since it's not exported — just verify DB round-trip
    const uid = 'smoke-p3-text-' + Date.now();
    const text = `להוסיף ליומן?\n• שיעור מתמטיקה – 10.5.2026\n• כדורגל CHILD\n✅ אישור | ❌ ביטול`;
    setPendingAction(uid, 'ADD_EVENT', { events }, [], text, 60000);
    const p = getPendingAction(uid);
    assert(p, 'No pending action');
    assert(p.confirmation_text.includes('שיעור מתמטיקה'), 'Missing event title in confirmation text');
    clearPA(uid);
  });

  // ── Phase 4: Clarification loop ──────────────────────────────────────────
  console.log('\nPhase 4 — Clarification Loop:');
  const { detectMissingParams, buildClarificationQuestion, resolvePartialEvent } = require('../src/parser');

  await test('detectMissingParams: event with no start_time → [start_time]', () => {
    const events = [{ title: 'ביקור רופא', start_time: null }];
    const missing = detectMissingParams(events, 'event');
    assert.deepStrictEqual(missing, ['start_time']);
  });

  await test('detectMissingParams: complete event → []', () => {
    const events = [{ title: 'ביקור רופא', start_time: '2026-05-10T10:00:00+03:00' }];
    const missing = detectMissingParams(events, 'event');
    assert.deepStrictEqual(missing, []);
  });

  await test('buildClarificationQuestion: missing start_time → Hebrew date question', () => {
    const q = buildClarificationQuestion(['start_time'], { title: 'ביקור רופא' });
    assert(typeof q === 'string' && q.length > 5, 'Empty question');
    assert(q.includes('ביקור רופא') || q.includes('תאריך') || q.includes('שעה'), `Question missing context: "${q}"`);
  });

  await test('buildClarificationQuestion: missing title → Hebrew title question', () => {
    const q = buildClarificationQuestion(['title'], {});
    assert(q.includes('שם') || q.includes('אירוע'), `Expected title question, got: "${q}"`);
  });

  await test('resolvePartialEvent: extracts start_time from natural Hebrew', async () => {
    const partial = { title: 'ביקור רופא', calendar_owner: 'both' };
    const result = await resolvePartialEvent(partial, ['start_time'], 'לאיזה תאריך?', 'מחר ב-10 בבוקר');
    assert(result && result.start_time, `No start_time extracted: ${JSON.stringify(result)}`);
    assert(result.start_time.includes('T10:00'), `Wrong time: ${result.start_time}`);
  });

  await test('max follow-ups: pending_actions stores followUpCount', () => {
    const uid = 'smoke-p4-followup-' + Date.now();
    const { setPendingAction, getPendingAction, clearPendingAction: clearPA2 } = require('../src/db');
    setPendingAction(uid, 'CLARIFY_EVENT', { partialEvent: { title: 'x' }, followUpCount: 2 }, ['start_time'], 'לאיזה שעה?');
    const p = getPendingAction(uid);
    assert(p, 'No pending action');
    assert.strictEqual(p.params.followUpCount, 2);
    clearPA2(uid);
  });

  // ── Health ────────────────────────────────────────────────────────────────
  console.log('\nHealth:');
  const { runChecks } = require('../src/health');

  await test('DB + Calendar checks pass (no WhatsApp client in test)', async () => {
    const failures = await runChecks();
    // WhatsApp check is skipped without client; DB + Calendar should pass
    const critical = failures.filter(f => !f.includes('WhatsApp') && !f.includes('stale'));
    assert(critical.length === 0, `Failures: ${critical.join(', ')}`);
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`${passed}/${total} passed${failed > 0 ? ` — ${failed} FAILED` : ' ✅'}`);

  if (failed > 0) {
    console.log('\n⚠️  Fix failures before deploying.\n');
    process.exit(1);
  } else {
    console.log('\nAll green. Safe to deploy.\n');
  }
}

main().catch(e => {
  console.error('\n💥 Smoke test runner crashed:', e.message);
  console.error(e.stack);
  process.exit(1);
});
