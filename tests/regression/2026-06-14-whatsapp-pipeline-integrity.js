const path = require('path');
/**
 * Regression: 2026-06-14
 * Incident: `isBacklogMessage` was deleted in a refactor. Every incoming message
 *   crashed with "isBacklogMessage is not defined" inside handleGroupMessage's try/catch.
 *   The catch swallowed the error silently → 0 notices created for 48h → digest ran empty.
 *
 * This test verifies:
 * 1. isBacklogMessage is defined in whatsapp.js
 * 2. handleGroupMessage exists and calls isBacklogMessage
 * 3. _backlogCutoffMs (the backing variable) is also present
 *
 * Pattern: static source analysis — catches "deleted in refactor" without starting WhatsApp client.
 */

const fs = require('fs');

const WHATSAPP_PATH = path.join(__dirname, '../../src/whatsapp.js');

module.exports = {
  async run() {
    if (!fs.existsSync(WHATSAPP_PATH)) {
      return { pass: false, message: 'whatsapp.js not found' };
    }

    const src = fs.readFileSync(WHATSAPP_PATH, 'utf8');

    // 1. isBacklogMessage must be defined
    const hasDef = /const\s+isBacklogMessage\s*=/.test(src);
    if (!hasDef) {
      return { pass: false, message: 'isBacklogMessage is not defined in whatsapp.js — will crash on every incoming message' };
    }

    // 2. _backlogCutoffMs backing variable must exist
    const hasCutoff = /let\s+_backlogCutoffMs/.test(src) || /const\s+_backlogCutoffMs/.test(src);
    if (!hasCutoff) {
      return { pass: false, message: '_backlogCutoffMs variable missing — isBacklogMessage will always throw' };
    }

    // 3. handleGroupMessage must exist and call isBacklogMessage
    const hasHandler = /async function handleGroupMessage/.test(src);
    if (!hasHandler) {
      return { pass: false, message: 'handleGroupMessage not found in whatsapp.js' };
    }

    const handlerBlock = src.slice(src.indexOf('async function handleGroupMessage'));
    const callsIsBacklog = /isBacklogMessage\s*\(/.test(handlerBlock);
    if (!callsIsBacklog) {
      return { pass: false, message: 'handleGroupMessage does not call isBacklogMessage — check if backlog filtering was removed' };
    }

    return {
      pass: true,
      message: 'isBacklogMessage defined, _backlogCutoffMs present, handleGroupMessage calls it correctly',
    };
  },
};
