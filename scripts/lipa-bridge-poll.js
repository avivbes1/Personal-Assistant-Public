#!/usr/bin/env node
'use strict';
/**
 * lipa-bridge-poll.js — Process pending Lipa Bridge inbox rows.
 *
 * Called by an OpenClaw cron job every 2 minutes. Reads pending commands from
 * bridge_lipa_inbox, processes them, and writes responses to bridge_lipa_outbox
 * (which the inbound poller drains as reply emails).
 *
 * This script runs in the context of the besinsky-bot repo but is invoked
 * by the OpenClaw agent (Lipa), not by the bot process.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { initDB } = require('../src/db');
const { getPendingInbox, completeInboxRow } = require('../src/bridge/lipaLane');

initDB();

const pending = getPendingInbox(10);
if (pending.length === 0) {
  process.exit(0);
}

console.log(`[Lipa Bridge] ${pending.length} pending command(s)`);

// Output the commands as structured JSON for the OpenClaw agent to process
const commands = pending.map(row => ({
  inbox_id: row.id,
  request_id: row.request_id,
  command: row.command,
  args: JSON.parse(row.args_json || '{}'),
  from: row.from_addr,
  subject: row.subject,
  gmail_message_id: row.gmail_message_id,
  created_at: row.created_at,
}));

console.log(JSON.stringify({ pending_commands: commands }, null, 2));
