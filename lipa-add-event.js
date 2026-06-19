#!/usr/bin/env node
/**
 * lipa-add-event.js — CLI tool for Lipa to add calendar events
 * Usage: node lipa-add-event.js <owner> <title> <start_time> [end_time] [description]
 * owner: aviv | liat | both
 * start_time: ISO8601+03:00 or YYYY-MM-DD
 * Example: node lipa-add-event.js aviv "קריאה לניר" "2026-05-10T10:30:00+03:00"
 */

const { initDB } = require('./src/db');
const { addSharedEvent } = require('./src/calendar');

initDB();

const [,, owner, title, start_time, end_time, description] = process.argv;

if (!owner || !title || !start_time) {
  console.error('Usage: node lipa-add-event.js <owner> <title> <start_time> [end_time] [description]');
  console.error('owner: aviv | liat | both');
  process.exit(1);
}

const event = {
  title,
  start_time,
  end_time: end_time || null,
  description: description || null,
  is_reminder: true,
};

async function run() {
  try {
    const result = await addSharedEvent(event, owner);
    if (result) {
      console.log('OK:' + JSON.stringify({ id: result.id, title: result.summary, start: result.start }));
    } else {
      console.error('FAIL: addSharedEvent returned null');
      process.exit(1);
    }
  } catch (e) {
    console.error('ERROR:' + e.message);
    process.exit(1);
  }
}

run();
