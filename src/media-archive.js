'use strict';

/**
 * media-archive.js — Persist raw WhatsApp media attachments to disk.
 *
 * Every media attachment from a monitored group is downloaded and saved under
 *   data/media-archive/{groupId}/{timestamp}_{msgId}.{ext}
 * so it can be re-processed later (retry pipeline, or when a user asks
 * "מה במכתב?" long after the message arrived and the live msg object is gone).
 *
 * Files are kept for 90 days; cleanupOldMedia() prunes older ones.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const ARCHIVE_ROOT = path.join(__dirname, '..', 'data', 'media-archive');
const RETENTION_DAYS = 90;

// mime → file extension. Documents fall back to their original filename ext.
const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/ogg': 'ogg',
  'audio/ogg; codecs=opus': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'm4a',
  'audio/amr': 'amr',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

const EXT_TO_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', amr: 'audio/amr', wav: 'audio/wav',
  mp4: 'video/mp4', '3gp': 'video/3gpp', mov: 'video/quicktime',
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Make a JID / arbitrary string safe to use as a directory name. */
function sanitize(s) {
  return String(s || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Pick a file extension from mime type, falling back to the original filename. */
function extFor(mimeType, filename) {
  const clean = (mimeType || '').toLowerCase().trim();
  if (MIME_TO_EXT[clean]) return MIME_TO_EXT[clean];
  const base = clean.split(';')[0].trim();
  if (MIME_TO_EXT[base]) return MIME_TO_EXT[base];
  const fromName = (filename || '').split('.').pop();
  if (fromName && fromName.length <= 5 && /^[a-z0-9]+$/i.test(fromName)) return fromName.toLowerCase();
  return 'bin';
}

/** mime type from a stored file's extension (for getArchivedMedia). */
function mimeForExt(ext) {
  return EXT_TO_MIME[(ext || '').toLowerCase()] || 'application/octet-stream';
}

function groupDir(groupId) {
  return path.join(ARCHIVE_ROOT, sanitize(groupId));
}

/**
 * Download and archive a media attachment to disk.
 *
 * @param {object} msg       — Baileys/whatsapp-web.js message object (must support downloadMedia())
 * @param {string} groupId   — group JID (used for the sub-directory)
 * @param {string} groupName — display name (logging only)
 * @returns {Promise<{path:string, mimeType:string, size:number}|null>} null on failure
 */
async function archiveMedia(msg, groupId, groupName) {
  try {
    if (!msg || !msg.hasMedia) return null;

    const media = await msg.downloadMedia();
    if (!media || !media.data) {
      logger.warn({ component: 'MediaArchive', group: groupName }, 'downloadMedia returned nothing');
      return null;
    }

    const buffer = Buffer.from(media.data, 'base64');
    if (!buffer.length) return null;

    const dir = groupDir(groupId);
    fs.mkdirSync(dir, { recursive: true });

    // timestamp in ms — matches the messages table `timestamp` column so
    // getArchivedMedia() can locate the file by the DB message timestamp.
    const tsMs = (msg.timestamp ? msg.timestamp * 1000 : Date.now());
    const msgId = sanitize((msg.id && (msg.id.id || msg.id._serialized)) || tsMs);
    const ext = extFor(media.mimetype, msg.filename || media.filename);
    const filePath = path.join(dir, `${tsMs}_${msgId}.${ext}`);

    fs.writeFileSync(filePath, buffer);
    logger.info({ component: 'MediaArchive', group: groupName, path: filePath, size: buffer.length }, 'Archived media');

    return { path: filePath, mimeType: media.mimetype || mimeForExt(ext), size: buffer.length };
  } catch (err) {
    logger.error({ component: 'MediaArchive', group: groupName, err: err.message }, 'archiveMedia failed');
    return null;
  }
}

/**
 * Retrieve a previously archived attachment by its message timestamp (ms).
 * Scans the group directory for a file named `{messageTimestamp}_*`.
 *
 * @param {string} groupId
 * @param {number} messageTimestamp — ms timestamp of the message
 * @returns {{path:string, mimeType:string, size:number, buffer:Buffer}|null}
 */
function getArchivedMedia(groupId, messageTimestamp) {
  try {
    const dir = groupDir(groupId);
    if (!fs.existsSync(dir)) return null;
    const prefix = `${messageTimestamp}_`;
    const match = fs.readdirSync(dir).find(f => f.startsWith(prefix));
    if (!match) return null;
    const filePath = path.join(dir, match);
    const buffer = fs.readFileSync(filePath);
    const ext = match.split('.').pop();
    return { path: filePath, mimeType: mimeForExt(ext), size: buffer.length, buffer };
  } catch (err) {
    logger.warn({ component: 'MediaArchive', groupId, err: err.message }, 'getArchivedMedia failed');
    return null;
  }
}

/**
 * Delete archived files older than RETENTION_DAYS. Removes empty group dirs.
 * @returns {{deleted:number, freedBytes:number}}
 */
function cleanupOldMedia(maxAgeDays = RETENTION_DAYS) {
  let deleted = 0;
  let freedBytes = 0;
  try {
    if (!fs.existsSync(ARCHIVE_ROOT)) return { deleted, freedBytes };
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const groupName of fs.readdirSync(ARCHIVE_ROOT)) {
      const dir = path.join(ARCHIVE_ROOT, groupName);
      let stat;
      try { stat = fs.statSync(dir); } catch (_) { continue; }
      if (!stat.isDirectory()) continue;
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fp = path.join(dir, file);
        try {
          const fstat = fs.statSync(fp);
          if (fstat.mtimeMs < cutoff) {
            freedBytes += fstat.size;
            fs.unlinkSync(fp);
            deleted++;
          }
        } catch (_) {}
      }
      // Remove now-empty group directory
      try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch (_) {}
    }
    if (deleted > 0) logger.info({ component: 'MediaArchive', deleted, freedKB: Math.round(freedBytes / 1024) }, 'Cleaned old media');
  } catch (err) {
    logger.warn({ component: 'MediaArchive', err: err.message }, 'cleanupOldMedia failed');
  }
  return { deleted, freedBytes };
}

module.exports = { archiveMedia, getArchivedMedia, cleanupOldMedia, mimeForExt };
