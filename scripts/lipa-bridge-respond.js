#!/usr/bin/env node
'use strict';
/**
 * lipa-bridge-respond.js — Write a response to the Lipa Bridge outbox.
 *
 * Usage:
 *   node scripts/lipa-bridge-respond.js <inbox_id> <request_id> '<response_json>' [original_subject] [in_reply_to]
 *
 * Called by the OpenClaw agent after processing a Lipa Bridge command.
 * The inbound poller will pick up the response and send it as a reply email.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { initDB } = require('../src/db');
const { completeInboxRow } = require('../src/bridge/lipaLane');

const [,, inboxIdStr, requestId, responseJson, originalSubject, inReplyTo] = process.argv;

if (!inboxIdStr || !responseJson) {
  console.error('Usage: lipa-bridge-respond.js <inbox_id> <request_id> \'<response_json>\' [original_subject] [in_reply_to]');
  process.exit(1);
}

initDB();

const inboxId = parseInt(inboxIdStr, 10);
const responseObj = JSON.parse(responseJson);

completeInboxRow(inboxId, requestId || null, responseObj, originalSubject || null, inReplyTo || null);
console.log(`[Lipa Bridge] Response queued for inbox_id=${inboxId}`);
