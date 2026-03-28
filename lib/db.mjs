import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { getProjectRoot } from "./config.mjs";

let db = null;

export function initDb() {
  const dataDir = join(getProjectRoot(), "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const dbPath = join(dataDir, "opendaemon.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL DEFAULT 'New Chat',
      engine_id   TEXT NOT NULL,
      sdk_session TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      metadata    TEXT,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv_id);
  `);

  return db;
}

export function getDb() {
  if (!db) throw new Error("Database not initialized. Call initDb() first.");
  return db;
}

// ── Conversations ──

export function createConversation(engineId) {
  const id = randomUUID().substring(0, 8);
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO conversations (id, title, engine_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(id, "New Chat", engineId, now, now);
  return { id, title: "New Chat", engine_id: engineId, created_at: now, updated_at: now };
}

export function listConversations() {
  return getDb()
    .prepare(
      "SELECT id, title, engine_id, sdk_session, created_at, updated_at FROM conversations ORDER BY updated_at DESC"
    )
    .all();
}

export function getConversation(id) {
  return getDb()
    .prepare(
      "SELECT id, title, engine_id, sdk_session, created_at, updated_at FROM conversations WHERE id = ?"
    )
    .get(id);
}

export function deleteConversation(id) {
  getDb().prepare("DELETE FROM conversations WHERE id = ?").run(id);
}

export function updateConversationTitle(id, title) {
  const now = Date.now();
  getDb()
    .prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
    .run(title, now, id);
}

export function updateConversationSdkSession(id, sessionId) {
  getDb()
    .prepare("UPDATE conversations SET sdk_session = ? WHERE id = ?")
    .run(sessionId, id);
}

function touchConversation(id) {
  const now = Date.now();
  getDb()
    .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
    .run(now, id);
}

// ── Messages ──

export function addMessage(convId, role, content, metadata = null) {
  const now = Date.now();
  const metaStr = metadata ? JSON.stringify(metadata) : null;
  const result = getDb()
    .prepare(
      "INSERT INTO messages (conv_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(convId, role, content, metaStr, now);
  touchConversation(convId);

  // Auto-title on first user message
  if (role === "user") {
    const count = getDb()
      .prepare("SELECT COUNT(*) as c FROM messages WHERE conv_id = ?")
      .get(convId).c;
    if (count === 1) {
      const title = content.trim().replace(/\n/g, " ").substring(0, 30);
      updateConversationTitle(convId, title.length < content.trim().length ? title + "..." : title);
    }
  }

  return { id: result.lastInsertRowid, conv_id: convId, role, content, metadata: metaStr, created_at: now };
}

export function getMessages(convId) {
  return getDb()
    .prepare(
      "SELECT id, conv_id, role, content, metadata, created_at FROM messages WHERE conv_id = ? ORDER BY id"
    )
    .all(convId);
}
