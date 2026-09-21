'use strict';
/**
 * bridge-schema.test.js — the Instinct Bridge tables and columns exist after
 * initDB(). Schema drift (a column that specs assume but initDB never created)
 * has bitten this codebase before; this pins the bridge surface.
 */

const { initDB, getDB } = require('../../src/db');

function columnsOf(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
}

function tableExists(db, table) {
  return !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(table);
}

module.exports = {
  async run() {
    const errors = [];
    initDB();
    const db = getDB();

    // ── tables exist ─────────────────────────────────────────────────────────
    for (const t of ['bridge_outbox', 'bridge_notice_sources', 'bridge_inbox']) {
      if (!tableExists(db, t)) errors.push(`missing table: ${t}`);
    }

    // ── bridge_outbox columns ────────────────────────────────────────────────
    const outboxCols = columnsOf(db, 'bridge_outbox');
    for (const c of ['id', 'event_id', 'event_type', 'stream', 'payload_json', 'payload_hash',
      'status', 'attempts', 'available_at', 'claimed_at', 'delivered_at',
      'provider_message_id', 'last_error', 'created_at', 'updated_at']) {
      if (!outboxCols.has(c)) errors.push(`bridge_outbox missing column: ${c}`);
    }

    // ── bridge_notice_sources columns ────────────────────────────────────────
    const srcCols = columnsOf(db, 'bridge_notice_sources');
    for (const c of ['notice_id', 'message_id', 'created_at']) {
      if (!srcCols.has(c)) errors.push(`bridge_notice_sources missing column: ${c}`);
    }

    // ── bridge_inbox columns ─────────────────────────────────────────────────
    const inboxCols = columnsOf(db, 'bridge_inbox');
    for (const c of ['id', 'inbound_message_id', 'in_reply_to_delivery_id', 'command_type',
      'payload_json', 'status', 'reviewed_at', 'executed_at', 'last_error',
      'created_at', 'updated_at']) {
      if (!inboxCols.has(c)) errors.push(`bridge_inbox missing column: ${c}`);
    }

    // ── notices additive columns ─────────────────────────────────────────────
    const noticeCols = columnsOf(db, 'notices');
    if (!noticeCols.has('export_version')) errors.push('notices missing column: export_version');
    if (!noticeCols.has('updated_at')) errors.push('notices missing column: updated_at');

    // ── delivery index exists ────────────────────────────────────────────────
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_bridge_outbox_delivery'"
    ).get();
    if (!idx) errors.push('missing index: idx_bridge_outbox_delivery');

    return errors.length === 0
      ? { pass: true, message: 'Bridge schema (3 tables, columns, notices ALTERs, index) present after initDB.' }
      : { pass: false, message: errors.join('\n         ') };
  },
};
