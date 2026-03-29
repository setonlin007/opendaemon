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

    -- ── Phase 2: Self-Evolution tables ──

    CREATE TABLE IF NOT EXISTS traces (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id           TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      msg_id            INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      engine_id         TEXT NOT NULL,
      prompt_summary    TEXT,
      tools_used        TEXT,
      input_tokens      INTEGER,
      output_tokens     INTEGER,
      estimated_cost    REAL,
      response_len      INTEGER,
      duration_ms       INTEGER,
      feedback          TEXT,
      feedback_note     TEXT,
      injected_knowledge TEXT,
      created_at        INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_traces_conv    ON traces(conv_id);
    CREATE INDEX IF NOT EXISTS idx_traces_created ON traces(created_at);

    CREATE TABLE IF NOT EXISTS knowledge_index (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      category    TEXT NOT NULL,
      title       TEXT NOT NULL,
      tags        TEXT,
      file_path   TEXT NOT NULL,
      line_start  INTEGER,
      line_end    INTEGER,
      source_type TEXT NOT NULL,
      confidence  REAL DEFAULT 0.5,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_tags     ON knowledge_index(tags);
    CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge_index(category);

    CREATE TABLE IF NOT EXISTS reflections (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      engine_id              TEXT NOT NULL,
      trace_start            INTEGER,
      trace_end              INTEGER,
      trace_count            INTEGER,
      insights_raw           TEXT,
      insights_accepted      INTEGER DEFAULT 0,
      insights_auto_accepted INTEGER DEFAULT 0,
      trigger_reason         TEXT,
      reflection_tokens      INTEGER,
      reflection_cost        REAL,
      created_at             INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_insights (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      reflection_id INTEGER REFERENCES reflections(id) ON DELETE CASCADE,
      category      TEXT NOT NULL,
      title         TEXT NOT NULL,
      tags          TEXT,
      content       TEXT NOT NULL,
      confidence    REAL DEFAULT 0.5,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_insights(status);

    CREATE TABLE IF NOT EXISTS evolution_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type  TEXT NOT NULL,
      event_data  TEXT,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_evo_log_type_created ON evolution_log(event_type, created_at);

    CREATE TABLE IF NOT EXISTS evolution_state (
      id                       INTEGER PRIMARY KEY CHECK (id = 1),
      last_reflection_at       INTEGER,
      bad_feedback_since_last  INTEGER DEFAULT 0,
      conv_since_last          INTEGER DEFAULT 0,
      updated_at               INTEGER NOT NULL
    );

    INSERT OR IGNORE INTO evolution_state (id, last_reflection_at, bad_feedback_since_last, conv_since_last, updated_at)
    VALUES (1, NULL, 0, 0, ${Date.now()});

    -- ── Phase 2.5: File & Image Upload ──

    CREATE TABLE IF NOT EXISTS attachments (
      id          TEXT PRIMARY KEY,
      conv_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      msg_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      filename    TEXT NOT NULL,
      mime_type   TEXT NOT NULL,
      size_bytes  INTEGER NOT NULL,
      disk_path   TEXT NOT NULL,
      category    TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_attachments_conv ON attachments(conv_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_msg  ON attachments(msg_id);
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

export function updateMessageContent(id, content) {
  getDb()
    .prepare("UPDATE messages SET content = ? WHERE id = ?")
    .run(content, id);
}

export function getMessages(convId) {
  return getDb()
    .prepare(
      "SELECT id, conv_id, role, content, metadata, created_at FROM messages WHERE conv_id = ? ORDER BY id"
    )
    .all(convId);
}
