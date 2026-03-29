/**
 * Attachment management: save, retrieve, delete, and build multimodal content.
 */

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, extname } from "path";
import { getProjectRoot } from "./config.mjs";
import { getDb } from "./db.mjs";

const UPLOADS_DIR = () => join(getProjectRoot(), "data", "uploads");

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILES_PER_REQUEST = 5;

// Allowed MIME types (checked by prefix or exact match)
const ALLOWED_MIME_PREFIXES = ["image/", "text/"];
const ALLOWED_MIME_EXACT = new Set([
  "application/pdf",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-yaml",
  "application/x-sh",
]);

// Image magic bytes for server-side validation
const MAGIC_BYTES = [
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46] },
  { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF header
];

/**
 * Create uploads directory if it doesn't exist.
 */
export function initUploads() {
  const dir = UPLOADS_DIR();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Validate MIME type against whitelist.
 */
function isAllowedMime(mimeType) {
  if (ALLOWED_MIME_EXACT.has(mimeType)) return true;
  return ALLOWED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

/**
 * Validate image magic bytes.
 */
function validateMagicBytes(buffer, mimeType) {
  if (!mimeType.startsWith("image/")) return true; // only validate images
  for (const { mime, bytes } of MAGIC_BYTES) {
    if (mimeType === mime || (mime === "image/webp" && mimeType === "image/webp")) {
      const match = bytes.every((b, i) => buffer[i] === b);
      if (match) return true;
    }
  }
  // If mime claims image but no magic match, check all known image signatures
  return MAGIC_BYTES.some(({ bytes }) => bytes.every((b, i) => buffer[i] === b));
}

/**
 * Sanitize filename: strip path traversal, limit length.
 */
function sanitizeFilename(filename) {
  // Strip path components
  let name = filename.replace(/^.*[\\/]/, "");
  // Replace unsafe characters
  name = name.replace(/[^\w.\-() ]/g, "_");
  // Limit length
  if (name.length > 200) {
    const ext = extname(name);
    name = name.substring(0, 200 - ext.length) + ext;
  }
  return name || "unnamed";
}

/**
 * Determine category from MIME type.
 */
function getCategory(mimeType) {
  return mimeType.startsWith("image/") ? "image" : "file";
}

/**
 * Get file extension from MIME type or filename.
 */
function getExtension(filename, mimeType) {
  const ext = extname(filename);
  if (ext) return ext;
  // Fallback from MIME
  const mimeMap = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
    "application/json": ".json",
    "text/plain": ".txt",
  };
  return mimeMap[mimeType] || ".bin";
}

/**
 * Save an attachment to disk and DB.
 * @returns {object} attachment record
 */
export function saveAttachment(convId, filename, mimeType, buffer) {
  // Validate
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(`File too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
  }
  if (!isAllowedMime(mimeType)) {
    throw new Error(`File type not allowed: ${mimeType}`);
  }
  if (mimeType.startsWith("image/") && !validateMagicBytes(buffer, mimeType)) {
    throw new Error(`Invalid image file: magic bytes don't match ${mimeType}`);
  }

  const id = randomUUID().substring(0, 8);
  const safeName = sanitizeFilename(filename);
  const ext = getExtension(safeName, mimeType);
  const diskFilename = `${id}${ext}`;
  const diskPath = diskFilename; // relative to uploads dir
  const category = getCategory(mimeType);
  const now = Date.now();

  // Write to disk
  try {
    writeFileSync(join(UPLOADS_DIR(), diskFilename), buffer);
  } catch (err) {
    throw new Error(`Failed to write file: ${err.message}`);
  }

  // Insert DB record
  try {
    getDb()
      .prepare(
        "INSERT INTO attachments (id, conv_id, msg_id, filename, mime_type, size_bytes, disk_path, category, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, convId, safeName, mimeType, buffer.length, diskPath, category, now);
  } catch (err) {
    // Clean up file on DB error
    try { unlinkSync(join(UPLOADS_DIR(), diskFilename)); } catch {}
    throw new Error(`Failed to save attachment record: ${err.message}`);
  }

  return { id, conv_id: convId, filename: safeName, mime_type: mimeType, size_bytes: buffer.length, category, url: `/api/uploads/${id}`, created_at: now };
}

/**
 * Get attachment metadata by ID.
 */
export function getAttachment(id) {
  return getDb().prepare("SELECT * FROM attachments WHERE id = ?").get(id) || null;
}

/**
 * Get all attachments for a message.
 */
export function getAttachmentsByMessage(msgId) {
  return getDb().prepare("SELECT * FROM attachments WHERE msg_id = ?").all(msgId);
}

/**
 * Get all attachments for a conversation.
 */
export function getAttachmentsByConversation(convId) {
  return getDb().prepare("SELECT * FROM attachments WHERE conv_id = ?").all(convId);
}

/**
 * Read attachment file from disk.
 * @returns {Buffer|null}
 */
export function getAttachmentBuffer(id) {
  const att = getAttachment(id);
  if (!att) return null;
  const fullPath = join(UPLOADS_DIR(), att.disk_path);
  try {
    return readFileSync(fullPath);
  } catch {
    return null;
  }
}

/**
 * Link attachment IDs to a message ID.
 */
export function linkAttachmentsToMessage(attachmentIds, msgId) {
  if (!attachmentIds || attachmentIds.length === 0) return;
  const stmt = getDb().prepare("UPDATE attachments SET msg_id = ? WHERE id = ?");
  for (const attId of attachmentIds) {
    stmt.run(msgId, attId);
  }
}

/**
 * Delete attachment files from disk for a conversation.
 * Best-effort: errors are logged but not thrown.
 */
export function deleteAttachmentFiles(convId) {
  try {
    const rows = getDb().prepare("SELECT disk_path FROM attachments WHERE conv_id = ?").all(convId);
    for (const row of rows) {
      try {
        unlinkSync(join(UPLOADS_DIR(), row.disk_path));
      } catch {}
    }
  } catch (err) {
    console.error("[attachments] cleanup error:", err.message);
  }
}

/**
 * Extract text content from a file buffer.
 */
export function extractTextContent(buffer, mimeType) {
  // Text-based files: just decode as UTF-8
  if (mimeType.startsWith("text/") || mimeType === "application/json" || mimeType === "application/javascript" || mimeType === "application/xml" || mimeType === "application/x-yaml" || mimeType === "application/x-sh") {
    return buffer.toString("utf-8");
  }
  // PDF: can't extract without dependency, return null (engine-specific handling)
  return null;
}

/**
 * Build Claude SDK content blocks from prompt + attachments.
 * @returns {Array} content blocks for Claude API
 */
export function buildClaudeContent(prompt, attachments) {
  const content = [];

  for (const att of attachments) {
    const buffer = getAttachmentBuffer(att.id);
    if (!buffer) continue;

    if (att.category === "image") {
      content.push({
        type: "image",
        source: { type: "base64", media_type: att.mime_type, data: buffer.toString("base64") },
      });
    } else if (att.mime_type === "application/pdf") {
      // Claude supports PDF natively as document type
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") },
      });
    } else {
      // Text-based file
      const text = extractTextContent(buffer, att.mime_type);
      if (text) {
        content.push({ type: "text", text: `--- ${att.filename} ---\n${text}\n---` });
      }
    }
  }

  // User prompt as final text block
  if (prompt && prompt.trim()) {
    content.push({ type: "text", text: prompt });
  }

  return content;
}

/**
 * Build OpenAI content array from prompt + attachments.
 * @returns {Array} content array for OpenAI API
 */
export function buildOpenAIContent(prompt, attachments) {
  const content = [];

  for (const att of attachments) {
    const buffer = getAttachmentBuffer(att.id);
    if (!buffer) continue;

    if (att.category === "image") {
      const dataUri = `data:${att.mime_type};base64,${buffer.toString("base64")}`;
      content.push({ type: "image_url", image_url: { url: dataUri } });
    } else {
      // Text-based or PDF: extract text and include as text block
      const text = extractTextContent(buffer, att.mime_type);
      if (text) {
        content.push({ type: "text", text: `--- ${att.filename} ---\n${text}\n---` });
      } else if (att.mime_type === "application/pdf") {
        content.push({ type: "text", text: `[Attached PDF: ${att.filename} (${(att.size_bytes / 1024).toFixed(0)}KB) — PDF text extraction not available]` });
      }
    }
  }

  // User prompt as final text block
  if (prompt && prompt.trim()) {
    content.push({ type: "text", text: prompt });
  }

  return content;
}

/**
 * Get attachment records for message IDs (for message API enrichment).
 * @param {number[]} msgIds
 * @returns {Map<number, Array>} map of msgId -> attachments
 */
export function getAttachmentsForMessages(msgIds) {
  if (!msgIds || msgIds.length === 0) return new Map();
  const placeholders = msgIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT id, msg_id, filename, mime_type, size_bytes, category, created_at FROM attachments WHERE msg_id IN (${placeholders})`)
    .all(...msgIds);

  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.msg_id)) map.set(row.msg_id, []);
    map.get(row.msg_id).push({
      id: row.id,
      filename: row.filename,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      category: row.category,
      url: `/api/uploads/${row.id}`,
    });
  }
  return map;
}

export { MAX_FILES_PER_REQUEST };
