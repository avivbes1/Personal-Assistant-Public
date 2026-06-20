'use strict';
/**
 * validateOutgoing(text) — gate before sending any message to the master group.
 * Returns { ok: true } or { ok: false, reason: '...' }
 */
function validateOutgoing(text) {
  if (!text || typeof text !== 'string') return { ok: false, reason: 'empty or non-string' };
  const t = text.trim();
  if (t.length < 10) return { ok: false, reason: 'too short' };

  // Detect "moved from X to X" (same value) — e.g. "הוזז מ-17:45 ל-17:45"
  const movedFrom = t.match(/מ-(.+?)\s+ל-(.+?)(?:\s|$)/);
  if (movedFrom && movedFrom[1].trim() === movedFrom[2].trim()) {
    return { ok: false, reason: `no actual change: from "${movedFrom[1]}" to "${movedFrom[2]}"` };
  }

  // Detect raw code/XML
  if (/<\w+>|<\/\w+>/.test(t)) return { ok: false, reason: 'contains XML/HTML tags' };
  if (/```|\{"/.test(t)) return { ok: false, reason: 'contains raw code' };

  // Detect error strings
  if (/TypeError|undefined|null\b|traceback|Error:/i.test(t)) {
    return { ok: false, reason: 'contains error text' };
  }

  return { ok: true };
}

/**
 * repairMessage(text, reason) — call Moonshot Kimi to rewrite a rejected message.
 * Returns the repaired string, or null if it can't be fixed.
 */
const https = require('https');

async function repairMessage(text, reason) {
  const moonShotKey = process.env.MOONSHOT_API_KEY;

  const prompt = `You are a WhatsApp message formatter for a family group chat. A message failed a quality check for this reason: "${reason}".

Original message:
${text}

Rewrite it as a clean, short Hebrew WhatsApp message with just the essential information. Rules:
- If it says something moved from time X to time X (same time), just state the final time once: "משחק ב-[time]"
- Remove duplicate information
- Remove any XML, code, or error text — keep only the human-readable facts
- Keep it under 3 lines
- If there is genuinely no useful information in the original, reply with exactly: NO_USEFUL_INFO

Reply with ONLY the rewritten message, nothing else.`;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'kimi-k2.6',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
    });

    const req = https.request({
      hostname: 'api.moonshot.ai',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${moonShotKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const reply = parsed.choices?.[0]?.message?.content?.trim();
          if (!reply || reply === 'NO_USEFUL_INFO') return resolve(null);
          resolve(reply);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

module.exports = { validateOutgoing, repairMessage };
