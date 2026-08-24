/**
 * media-parser.js — Extract content from WhatsApp media messages.
 *
 * Images:  Claude Sonnet vision (all groups) + Tesseract OCR fallback
 * Audio:   Groq Whisper (whisper-large-v3-turbo) transcription (all groups)
 * PDFs:    pdf-parse text extraction (all groups)
 * Word:    mammoth text extraction (all groups)
 * Excel:   xlsx CSV extraction (all groups)
 */

'use strict';

const https = require('https');
const { traceCall } = require('./llm-trace');

const VISION_MODEL = 'claude-sonnet-4-5';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB limit for vision
const MAX_TEXT_CHARS = 2000;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_WHISPER_MODEL = 'whisper-large-v3-turbo';

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

  const startMs = Date.now();
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
          traceCall({
            model: VISION_MODEL,
            callSite: 'media.vision',
            inputTokens:  parsed.usage?.input_tokens  ?? 0,
            outputTokens: parsed.usage?.output_tokens ?? 0,
            durationMs: Date.now() - startMs,
            success: !parsed.error,
            error: parsed.error?.message || null,
            groupId: groupName,
          });
          resolve(text ? `[תמונה: ${text.substring(0, 300)}]` : '[תמונה]');
        } catch (e) {
          traceCall({
            model: VISION_MODEL,
            callSite: 'media.vision',
            durationMs: Date.now() - startMs,
            success: false,
            error: `PARSE_ERROR: ${e.message}`,
            groupId: groupName,
          });
          resolve('[תמונה]');
        }
      });
    });
    req.on('error', (err) => {
      traceCall({
        model: VISION_MODEL,
        callSite: 'media.vision',
        durationMs: Date.now() - startMs,
        success: false,
        error: `REQUEST_ERROR: ${err.message}`,
        groupId: groupName,
      });
      resolve('[תמונה]');
    });
    req.write(body);
    req.end();
  });
}

/** Map an audio mime type to a file extension Whisper recognizes. */
function audioExtFromMime(mimeType) {
  const m = (mimeType || '').toLowerCase();
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('webm')) return 'webm';
  if (m.includes('wav')) return 'wav';
  if (m.includes('amr')) return 'amr';
  if (m.includes('flac')) return 'flac';
  return 'ogg'; // WhatsApp voice notes are ogg/opus by default
}

/**
 * Transcribe an audio buffer via Groq's Whisper API (whisper-large-v3-turbo).
 * Returns the transcription text, or null on failure.
 *
 * The 'form-data' npm package isn't installed, so the multipart/form-data
 * body is constructed manually with an explicit boundary.
 *
 * @param {Buffer} buffer   — raw audio bytes
 * @param {string} mimeType — e.g. 'audio/ogg; codecs=opus'
 */
async function transcribeAudio(buffer, mimeType) {
  if (!GROQ_API_KEY) {
    console.warn('[MediaParser] GROQ_API_KEY not set — cannot transcribe audio.');
    return null;
  }
  if (!buffer || !buffer.length) return null;

  try {
    const CRLF = '\r\n';
    const boundary = '----AudioBoundary' + Date.now().toString(16);
    const ext = audioExtFromMime(mimeType);

    const preamble =
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="model"${CRLF}${CRLF}` +
      `${GROQ_WHISPER_MODEL}${CRLF}` +
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="language"${CRLF}${CRLF}` +
      `he${CRLF}` +
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="file"; filename="audio.${ext}"${CRLF}` +
      `Content-Type: ${mimeType || 'audio/ogg'}${CRLF}${CRLF}`;
    const epilogue = `${CRLF}--${boundary}--${CRLF}`;

    const body = Buffer.concat([
      Buffer.from(preamble, 'utf8'),
      buffer,
      Buffer.from(epilogue, 'utf8'),
    ]);

    const startMs = Date.now();
    return await new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.groq.com',
        path: '/openai/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const text = (parsed.text || '').trim();
            if (text) {
              traceCall({
                model: GROQ_WHISPER_MODEL,
                callSite: 'media.transcribe',
                durationMs: Date.now() - startMs,
                success: true,
              });
              return resolve(text);
            }
            console.error('[MediaParser] Groq transcription returned no text:', data.substring(0, 200));
            traceCall({
              model: GROQ_WHISPER_MODEL,
              callSite: 'media.transcribe',
              durationMs: Date.now() - startMs,
              success: false,
              error: parsed.error?.message || 'no text returned',
            });
            resolve(null);
          } catch (e) {
            console.error('[MediaParser] Groq transcription parse error:', e.message, data.substring(0, 200));
            traceCall({
              model: GROQ_WHISPER_MODEL,
              callSite: 'media.transcribe',
              durationMs: Date.now() - startMs,
              success: false,
              error: `PARSE_ERROR: ${e.message}`,
            });
            resolve(null);
          }
        });
      });
      req.on('error', (e) => {
        console.error('[MediaParser] Groq transcription request error:', e.message);
        traceCall({
          model: GROQ_WHISPER_MODEL,
          callSite: 'media.transcribe',
          durationMs: Date.now() - startMs,
          success: false,
          error: `REQUEST_ERROR: ${e.message}`,
        });
        resolve(null);
      });
      req.write(body);
      req.end();
    });
  } catch (e) {
    console.error('[MediaParser] transcribeAudio error:', e.message);
    return null;
  }
}

/**
 * Fallback OCR via Tesseract (Hebrew) when vision returns nothing useful.
 * Writes the image to a temp file and shells out to `tesseract`.
 * Returns extracted text, or null if OCR is unavailable / empty.
 */
function tryOcr(buffer, mimeType) {
  try {
    const { execSync } = require('child_process');
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const ext = (mimeType || '').includes('png') ? 'png' : 'jpg';
    const tmpfile = path.join(os.tmpdir(), `bot-ocr-${Date.now()}.${ext}`);
    fs.writeFileSync(tmpfile, buffer);
    try {
      const out = execSync(`tesseract ${tmpfile} stdout -l heb 2>/dev/null`, {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      });
      const text = (out || '').replace(/\s+/g, ' ').trim();
      return text || null;
    } finally {
      try { fs.unlinkSync(tmpfile); } catch (_) {}
    }
  } catch (e) {
    console.warn('[MediaParser] OCR fallback failed:', e.message);
    return null;
  }
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
 * Extract content from an already-downloaded media buffer. This is the shared
 * core used both by live processing (processMediaMessage) and by the retry
 * pipeline (which re-reads archived files — see media-archive.js / /media/retry),
 * where the original message object is no longer available.
 *
 * @param {Buffer} buffer    — raw media bytes
 * @param {string} mimeType  — media mime type
 * @param {string} type      — 'image' | 'sticker' | 'audio' | 'ptt' | 'document'
 * @param {string} filename  — original filename (documents)
 * @param {string} groupName — display name for context
 * @returns {Promise<string|null>} extracted content, or null if nothing extractable
 */
async function extractFromMedia(buffer, mimeType, type, filename, groupName) {
  if (!buffer || !buffer.length) return null;

  // Images / stickers
  if (type === 'image' || type === 'sticker') {
    if (buffer.length > MAX_IMAGE_BYTES) {
      console.log(`[MediaParser] Image too large (${Math.round(buffer.length / 1024)}KB), skipping vision.`);
      return null;
    }
    console.log(`[MediaParser] Describing image from "${groupName}"...`);
    let described = await describeImage(buffer.toString('base64'), mimeType, groupName);
    // OCR fallback: if vision produced nothing useful, try Tesseract (Hebrew).
    if (described === '[תמונה]') {
      const ocr = tryOcr(buffer, mimeType);
      if (ocr) {
        console.log(`[MediaParser] OCR fallback recovered ${ocr.length} chars from "${groupName}".`);
        described = `[תמונה (OCR): ${ocr.substring(0, 300)}]`;
      }
    }
    return described;
  }

  // Audio / voice notes (baileys maps both 'audio' and voice to 'ptt')
  if (type === 'audio' || type === 'ptt') {
    console.log(`[MediaParser] Transcribing voice note from "${groupName}"...`);
    const transcription = await transcribeAudio(buffer, mimeType);
    if (!transcription) return null;
    return `[הקלטה: ${transcription}]`;
  }

  // Documents (PDF / Word / Excel)
  if (type === 'document') {
    console.log(`[MediaParser] Parsing document "${filename || ''}" from "${groupName}"...`);
    return await parseDocument(buffer, mimeType, filename || '');
  }

  return null; // video, location, vcard etc. — no content extraction
}

/**
 * Process a WhatsApp media message. Returns extracted content string,
 * or null if nothing could be extracted.
 *
 * @param {object} msg        — whatsapp-web.js message object
 * @param {object} groupRecord — DB group record (reserved for future per-group tuning)
 * @param {string} groupName  — display name for context
 * @param {object} opts        — { forceVision } kept for backward compatibility (images are
 *                               now processed for all groups regardless of this flag)
 */
async function processMediaMessage(msg, groupRecord, groupName, { forceVision = false } = {}) {
  try {
    const type = msg.type;
    if (!['image', 'sticker', 'audio', 'ptt', 'document'].includes(type)) {
      return null; // video, location, vcard etc. — no content extraction
    }

    const media = await msg.downloadMedia();
    if (!media || !media.data) return null;

    const buffer = Buffer.from(media.data, 'base64');
    return await extractFromMedia(buffer, media.mimetype, type, msg.filename || media.filename, groupName);
  } catch (err) {
    console.error('[MediaParser] processMediaMessage error:', err.message);
    return null;
  }
}

module.exports = { processMediaMessage, extractFromMedia, transcribeAudio, isSchoolGroup };
