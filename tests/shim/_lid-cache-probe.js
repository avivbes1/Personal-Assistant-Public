#!/usr/bin/env node
/**
 * Isolated probe used by shim.test.js to prove the lid_map cache survives a
 * process restart. Run as two separate processes sharing one FAMILYBOT_DB_PATH:
 *   node _lid-cache-probe.js save   # process 1 writes the mapping
 *   node _lid-cache-probe.js read   # process 2 (a "restart") reads it back
 * A fresh process reading what the previous one wrote is exactly the
 * survives-restart guarantee step 4 requires.
 */
const db = require('../../src/db');
db.initDB();

const LID = '444000444000@lid';
const PN = '972500000044@s.whatsapp.net';
const action = process.argv[2];

if (action === 'save') {
  db.saveLidMapping(LID, PN);
  process.exit(0);
} else if (action === 'read') {
  process.exit(db.getLidMapping(LID) === PN ? 0 : 1);
}
process.exit(2);
