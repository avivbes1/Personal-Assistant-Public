/**
 * media-parser.js — Extract content from WhatsApp media messages.
 *
 * Images:  Claude Sonnet vision (only for groups linked to a child via primary_child DB field)
 * PDFs:    pdf-parse text extraction (all groups)
 * Word:    mammoth text extraction (all groups)
 * Excel:   xlsx CSV extraction (all groups)
 */

'use strict';

const https = require('https');

const VISION_MODEL = 'claude-sonnet-4-5';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB limit for vision
const MAX_TEXT_CHARS = 2000;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

/**
 * Returns true if this group is linked to a child member.
 * Uses the primary_child DB field — set during group reconciliation.
 */
function isSchoolGroup(groupRecord) {
  if (!groupRecord) return false;
  // If primary_child is set, this group belongs to a child
  if (groupRecord.primary_child) return true;
  // Fallback: check if role='kid' members' names appear in description
  try {
    const { getAllFamilyMembers } = require('./db');
    const kids = getAllFamilyMembers().filter(m => m.role === 'kid');
    const desc = (groupRecord.description || '') + ' ' + (groupRecord.name || '');
    return kids.some(k => desc.includes(k.name_he) || desc.toLowerCase().includes((k.name_en || '').toLowerCase()));
  } catch (_) { return false; }
}

/**
 * Send image to Claude vision and get a Hebrew description / transcription.
 * Returns a string like "[תמונה: ...]"
 */
async function describeImage(base64Data, mimeType, groupName) {
  if (!ANTHROPIC_API_KEY) return '[תמונה]';
  if (!base64Data) return '[תמונה]';

  const body = JSON.stringify({
    model: VISION_MODEL,
    max_tokens: 600,
    system: 'You are a family assistant. Describe WhatsApp images concisely in Hebrew. If the image contains text (announcements, schedules, etc.), transcribe the important parts. If it\'s a photo, describe it in 1-2 sentences. Be brief.',
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: base64Data },
        },
        {
          type: 'text',
          text: `תמונה מהקבוצה "${groupName}". תאר בקצרה מה רואים.`,
        },
      ],
    }],
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.[0]?.text || '';
          resolve(text ? `[תמונה: ${text.substring(0, 300)}]` : '[תמונה]');
        } catch (_) { resolve('[תמונה]'); }
      });
    });
    req.on('error', () => resolve('[תמונה]'));
    req.write(body);
    req.end();
  });
}

/**
 * Parse a document (PDF / Word / Excel) and return extracted text.
 * Returns null if unsupported type.
 */
async function parseDocument(buffer, mimeType, filename) {
  const fname = (filename || '').toLowerCase();

  // PDF
  if (mimeType === 'application/pdf' || fname.endsWith('.pdf')) {
    try {
      const { PDFParse } = require('pdf-parse');
      const parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      const text = (result.text || '').replace(/\s+/g, ' ').trim();
      return text ? `[PDF: ${text.substring(0, MAX_TEXT_CHARS)}]` : '[PDF ריק]';
    } catch (e) {
      console.error('[MediaParser] PDF parse error:', e.message, e.stack?.split('\n')[1]);
      return '[PDF — לא הצלחתי לקרוא]';
    }
  }

  // Word (.doc / .docx)
  if (mimeType?.includes('word') || fname.match(/\.docx?$/)) {
    try {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      const text = (result.value || '').replace(/\s+/g, ' ').trim();
      return text ? `[Word: ${text.substring(0, MAX_TEXT_CHARS)}]` : '[Word ריק]';
    } catch (e) {
      console.warn('[MediaParser] Word parse error:', e.message);
      return '[Word — לא הצלחתי לקרוא]';
    }
  }

  // Excel (.xls / .xlsx)
  if (mimeType?.includes('spreadsheet') || mimeType?.includes('excel') || fname.match(/\.xlsx?$/)) {
    try {
      const xlsx = require('xlsx');
      const workbook = xlsx.read(buffer, { type: 'buffer' });
      let text = '';
      for (const sheetName of workbook.SheetNames.slice(0, 3)) {
        const sheet = workbook.Sheets[sheetName];
        const csv = xlsx.utils.sheet_to_csv(sheet);
        text += `[${sheetName}]\n${csv.substring(0, 600)}\n`;
      }
      return text.trim() ? `[Excel: ${text.substring(0, MAX_TEXT_CHARS)}]` : '[Excel ריק]';
    } catch (e) {
      console.warn('[MediaParser] Excel parse error:', e.message);
      return '[Excel — לא הצלחתי לקרוא]';
    }
  }

  return null; // unsupported
}

/**
 * Process a WhatsApp media message. Returns extracted content string,
 * or null if nothing could be extracted.
 *
 * @param {object} msg        — whatsapp-web.js message object
 * @param {object} groupRecord — DB group record (for school group check)
 * @param {string} groupName  — display name for context
 */
async function processMediaMessage(msg, groupRecord, groupName, { forceVision = false } = {}) {
  try {
    const type = msg.type;

    // Images: school groups always; other groups only when explicitly requested (forceVision)
    if (type === 'image' || type === 'sticker') {
      if (!forceVision && !isSchoolGroup(groupRecord)) return null;
      const media = await msg.downloadMedia();
      if (!media) return null;

      // Size check (base64 → ~75% of original, approximate)
      const approxBytes = (media.data.length * 3) / 4;
      if (approxBytes > MAX_IMAGE_BYTES) {
        console.log(`[MediaParser] Image too large (${Math.round(approxBytes / 1024)}KB), skipping vision.`);
        return null;
      }

      console.log(`[MediaParser] Describing image from "${groupName}"...`);
      return await describeImage(media.data, media.mimetype, groupName);
    }

    // Documents: all groups
    if (type === 'document') {
      const media = await msg.downloadMedia();
      if (!media) return null;

      const buffer = Buffer.from(media.data, 'base64');
      const filename = msg.filename || '';
      console.log(`[MediaParser] Parsing document "${filename}" from "${groupName}"...`);
      return await parseDocument(buffer, media.mimetype, filename);
    }

    return null; // audio, video, location, vcard etc. — no content extraction
  } catch (err) {
    console.error('[MediaParser] processMediaMessage error:', err.message);
    return null;
  }
}

module.exports = { processMediaMessage, isSchoolGroup };
