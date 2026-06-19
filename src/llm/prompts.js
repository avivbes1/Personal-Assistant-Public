/**
 * prompts.js — Load and render prompt templates from /prompts/*.txt
 *
 * Templates use {{VAR_NAME}} placeholders.
 * Usage:
 *   const { render } = require('./prompts');
 *   const system = render('agent-system', { BOT_NAME: 'FamilyBot', FAMILY_CONTEXT: '...' });
 */

const fs   = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname, '../../prompts');

// Cache loaded templates in memory
const cache = new Map();

function load(name) {
  if (cache.has(name)) return cache.get(name);
  const file = path.join(PROMPTS_DIR, `${name}.txt`);
  if (!fs.existsSync(file)) throw new Error(`[prompts] Template not found: ${name}.txt`);
  const template = fs.readFileSync(file, 'utf8');
  cache.set(name, template);
  return template;
}

/**
 * Load a template and substitute {{KEY}} placeholders.
 * @param {string} name - Template name (without .txt)
 * @param {object} vars - Key-value substitutions
 * @returns {string}
 */
function render(name, vars = {}) {
  let text = load(name);
  for (const [key, value] of Object.entries(vars)) {
    text = text.replaceAll(`{{${key}}}`, value ?? '');
  }
  return text.trim();
}

/** Clear cache (useful in tests) */
function clearCache() { cache.clear(); }

module.exports = { render, clearCache };
