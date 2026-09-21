'use strict';
/**
 * Bridge envelope construction tests.
 * Verifies: structure, required fields, deterministic hashing, unique delivery IDs.
 */

module.exports = {
  async run() {
    const errors = [];
    const {
      buildEnvelope, buildMessageRecord, buildNoticeRecord,
      computePayloadHash, generateDeliveryId, SCHEMA_VERSION,
    } = require('../../src/bridge/envelope');

    // ── Envelope structure ──────────────────────────────────────────────────
    {
      const env = buildEnvelope('test-stream', [{ kind: 'message', body: 'hi' }]);
      const required = ['schema_version', 'source', 'stream', 'delivery_id', 'generated_at', 'event_count', 'events'];
      for (const k of required) {
        if (!(k in env)) errors.push(`envelope missing key '${k}'`);
      }
      if (env.schema_version !== SCHEMA_VERSION) errors.push(`schema_version mismatch: ${env.schema_version}`);
      if (env.event_count !== 1) errors.push(`event_count should be 1, got ${env.event_count}`);
      if (env.stream !== 'test-stream') errors.push(`stream mismatch: ${env.stream}`);
    }

    // ── Message record ──────────────────────────────────────────────────────
    {
      const msg = { id: 42, group_id: '123@g.us', sender: '+15551234567', body: 'hello', timestamp: 1700000000000, stanza_id: '3EB0ABC' };
      const rec = buildMessageRecord(msg, { jid: '123@g.us', name: 'Test Group' });
      if (rec.kind !== 'message') errors.push(`message record kind: ${rec.kind}`);
      if (rec.message_id !== 42) errors.push(`message_id: ${rec.message_id}`);
      if (rec.stanza_id !== '3EB0ABC') errors.push(`stanza_id: ${rec.stanza_id}`);
      if (rec.group.jid !== '123@g.us') errors.push(`group jid: ${rec.group.jid}`);
      if (!rec.timestamp_iso) errors.push('missing timestamp_iso');
    }

    // ── Notice record ───────────────────────────────────────────────────────
    {
      const notice = { id: 99, group_name: 'School', content: 'Bring form', tier: 'actionable', urgency_hint: 'routine', relevance_date: '2026-09-25', primary_child: 'Test', created_at: 1700000000000 };
      const rec = buildNoticeRecord(notice, [10, 11]);
      if (rec.kind !== 'notice') errors.push(`notice record kind: ${rec.kind}`);
      if (rec.notice_id !== 99) errors.push(`notice_id: ${rec.notice_id}`);
      if (rec.source_message_ids.length !== 2) errors.push(`source_message_ids length: ${rec.source_message_ids.length}`);
      if (rec.tier !== 'actionable') errors.push(`tier: ${rec.tier}`);
    }

    // ── Payload hash determinism ────────────────────────────────────────────
    {
      const a = { z: 1, a: 2 };
      const b = { a: 2, z: 1 };
      const ha = computePayloadHash(a);
      const hb = computePayloadHash(b);
      if (ha !== hb) errors.push(`hash not deterministic: ${ha} !== ${hb}`);
      if (typeof ha !== 'string' || ha.length !== 64) errors.push(`hash format: ${ha}`);
    }

    // ── Delivery ID uniqueness ──────────────────────────────────────────────
    {
      const ids = new Set();
      for (let i = 0; i < 100; i++) ids.add(generateDeliveryId());
      if (ids.size !== 100) errors.push(`delivery IDs not unique: ${ids.size}/100`);
      const sample = [...ids][0];
      if (!sample.startsWith('del_')) errors.push(`delivery ID format: ${sample}`);
    }

    return {
      pass: errors.length === 0,
      message: errors.length === 0
        ? `bridge-envelope: ${5} checks passed`
        : errors.join('\n'),
    };
  },
};
