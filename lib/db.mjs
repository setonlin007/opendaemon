import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
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

    -- ── FTS5 Full-Text Search for knowledge (P1: replaces LIKE-based search) ──
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      title, tags, content,
      content='',
      tokenize='unicode61'
    );

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

    -- ── Phase 7: Image generation metadata ──
    -- metadata JSON: { prompt, mode, weight, seed, ref_attachment_id, ... }
    -- upload 时为 NULL，generated 时存生图参数

    -- ── Phase 4: Advanced Harness ──

    -- Sub-Agent Orchestration
    CREATE TABLE IF NOT EXISTS sub_agent_runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_conv_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      parent_trace_id INTEGER REFERENCES traces(id) ON DELETE SET NULL,
      agent_type      TEXT NOT NULL,
      agent_config    TEXT,
      input_context   TEXT,
      output_result   TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      engine_id       TEXT,
      input_tokens    INTEGER,
      output_tokens   INTEGER,
      estimated_cost  REAL,
      duration_ms     INTEGER,
      created_at      INTEGER NOT NULL,
      completed_at    INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_sub_agent_parent_conv ON sub_agent_runs(parent_conv_id);
    CREATE INDEX IF NOT EXISTS idx_sub_agent_status      ON sub_agent_runs(status);

    -- Knowledge Evaluations
    CREATE TABLE IF NOT EXISTS evaluations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      knowledge_id    INTEGER REFERENCES knowledge_index(id) ON DELETE CASCADE,
      status          TEXT NOT NULL DEFAULT 'queued',
      trace_ids       TEXT,
      scores_without  TEXT,
      scores_with     TEXT,
      score_delta     REAL,
      judge_reasoning TEXT,
      engine_id       TEXT,
      eval_tokens     INTEGER,
      eval_cost       REAL,
      created_at      INTEGER NOT NULL,
      completed_at    INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_eval_knowledge ON evaluations(knowledge_id);
    CREATE INDEX IF NOT EXISTS idx_eval_status    ON evaluations(status);

    -- A/B Testing Experiments
    CREATE TABLE IF NOT EXISTS experiments (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL,
      surface           TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'active',
      variant_a         TEXT,
      variant_b         TEXT,
      conversations_a   INTEGER DEFAULT 0,
      conversations_b   INTEGER DEFAULT 0,
      feedback_a        TEXT,
      feedback_b        TEXT,
      min_conversations INTEGER DEFAULT 20,
      winner            TEXT,
      created_at        INTEGER NOT NULL,
      completed_at      INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments(status);

    CREATE TABLE IF NOT EXISTS experiment_assignments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
      conv_id       TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      variant       TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_exp_assign_conv ON experiment_assignments(conv_id);

    -- Self-Coded Tools
    CREATE TABLE IF NOT EXISTS self_coded_tools (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name             TEXT NOT NULL UNIQUE,
      description           TEXT,
      input_schema          TEXT,
      code                  TEXT,
      origin_reflection_id  INTEGER REFERENCES reflections(id) ON DELETE SET NULL,
      origin_pattern        TEXT,
      status                TEXT NOT NULL DEFAULT 'proposed',
      test_result           TEXT,
      proposed_at           INTEGER,
      installed_at          INTEGER,
      created_at            INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_self_coded_status ON self_coded_tools(status);

    -- ── Workspaces ──
    CREATE TABLE IF NOT EXISTS workspaces (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      path        TEXT NOT NULL,
      is_default  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);

  // Add parent_trace_id to traces table (safe migration for existing DBs)
  try {
    db.exec(`ALTER TABLE traces ADD COLUMN parent_trace_id INTEGER REFERENCES traces(id)`);
  } catch (_) {
    // Column already exists, ignore
  }

  // Add workspace_id to conversations table
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL`);
  } catch (_) {
    // Column already exists
  }

  // Add metadata to attachments table (for generated image params: prompt/mode/seed/...)
  try {
    db.exec(`ALTER TABLE attachments ADD COLUMN metadata TEXT`);
  } catch (_) {
    // Column already exists
  }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_workspace ON conversations(workspace_id)`);
  } catch (_) {}

  // Seed default workspace & migrate existing conversations
  {
    const now = Date.now();
    const wsPath = join(homedir(), "workspace");
    db.prepare(`INSERT OR IGNORE INTO workspaces (id, name, path, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("default", "workspace", wsPath, 1, now, now);
    // Assign all orphan conversations to default workspace
    db.prepare(`UPDATE conversations SET workspace_id = 'default' WHERE workspace_id IS NULL`).run();
  }

  return db;
}

export function getDb() {
  if (!db) throw new Error("Database not initialized. Call initDb() first.");
  return db;
}

// ── Conversations ──

export function createConversation(engineId, workspaceId = "default") {
  const id = randomUUID().substring(0, 8);
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO conversations (id, title, engine_id, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(id, "New Chat", engineId, workspaceId, now, now);
  return { id, title: "New Chat", engine_id: engineId, workspace_id: workspaceId, created_at: now, updated_at: now };
}

export function listConversations(workspaceId) {
  if (workspaceId) {
    return getDb()
      .prepare(
        "SELECT id, title, engine_id, sdk_session, workspace_id, created_at, updated_at FROM conversations WHERE (workspace_id = ? OR (? = 'default' AND workspace_id IS NULL)) ORDER BY updated_at DESC"
      )
      .all(workspaceId, workspaceId);
  }
  return getDb()
    .prepare(
      "SELECT id, title, engine_id, sdk_session, workspace_id, created_at, updated_at FROM conversations ORDER BY updated_at DESC"
    )
    .all();
}

export function getConversation(id) {
  return getDb()
    .prepare(
      "SELECT id, title, engine_id, sdk_session, workspace_id, created_at, updated_at FROM conversations WHERE id = ?"
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

// ── Sub-Agent Runs (Phase 4) ──

export function addSubAgentRun(data) {
  const now = Date.now();
  const result = getDb()
    .prepare(`INSERT INTO sub_agent_runs
      (parent_conv_id, parent_trace_id, agent_type, agent_config, input_context, status, engine_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      data.parent_conv_id, data.parent_trace_id || null, data.agent_type,
      data.agent_config ? JSON.stringify(data.agent_config) : null,
      data.input_context || null, data.status || 'pending', data.engine_id || null, now
    );
  return { id: result.lastInsertRowid, created_at: now };
}

export function updateSubAgentRun(id, updates) {
  const fields = [];
  const values = [];
  for (const [key, val] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(key === 'agent_config' ? JSON.stringify(val) : val);
  }
  values.push(id);
  getDb().prepare(`UPDATE sub_agent_runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function listSubAgentRuns(convId) {
  return getDb()
    .prepare("SELECT * FROM sub_agent_runs WHERE parent_conv_id = ? ORDER BY created_at")
    .all(convId);
}

// ── Evaluations (Phase 4) ──

export function addEvaluation(data) {
  const now = Date.now();
  const result = getDb()
    .prepare(`INSERT INTO evaluations (knowledge_id, status, trace_ids, engine_id, created_at)
      VALUES (?, ?, ?, ?, ?)`)
    .run(data.knowledge_id, data.status || 'queued',
      data.trace_ids ? JSON.stringify(data.trace_ids) : null,
      data.engine_id || null, now);
  return { id: result.lastInsertRowid, created_at: now };
}

export function updateEvaluation(id, updates) {
  const fields = [];
  const values = [];
  for (const [key, val] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push((key === 'trace_ids' || key === 'scores_without' || key === 'scores_with') ? JSON.stringify(val) : val);
  }
  values.push(id);
  getDb().prepare(`UPDATE evaluations SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function getEvaluations(filters = {}) {
  let sql = "SELECT * FROM evaluations WHERE 1=1";
  const params = [];
  if (filters.status) { sql += " AND status = ?"; params.push(filters.status); }
  if (filters.knowledge_id) { sql += " AND knowledge_id = ?"; params.push(filters.knowledge_id); }
  sql += " ORDER BY created_at DESC";
  if (filters.limit) { sql += " LIMIT ?"; params.push(filters.limit); }
  return getDb().prepare(sql).all(...params);
}

export function getOldestQueuedEvaluation() {
  return getDb()
    .prepare("SELECT * FROM evaluations WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
    .get();
}

export function getEvaluationStats() {
  return getDb()
    .prepare(`SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' AND score_delta > 0 THEN 1 ELSE 0 END) as passed,
      SUM(CASE WHEN status = 'completed' AND score_delta <= 0 THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as pending,
      AVG(CASE WHEN status = 'completed' THEN score_delta END) as avg_delta
      FROM evaluations`)
    .get();
}

// ── Experiments / A/B Testing (Phase 4) ──

export function createExperiment(data) {
  const now = Date.now();
  const result = getDb()
    .prepare(`INSERT INTO experiments
      (name, surface, status, variant_a, variant_b, min_conversations, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(data.name, data.surface, 'active',
      data.variant_a || null, data.variant_b || null,
      data.min_conversations || 20, now);
  return { id: result.lastInsertRowid, created_at: now };
}

export function getActiveExperiment() {
  return getDb()
    .prepare("SELECT * FROM experiments WHERE status = 'active' LIMIT 1")
    .get();
}

export function updateExperiment(id, updates) {
  const fields = [];
  const values = [];
  for (const [key, val] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push((key === 'feedback_a' || key === 'feedback_b') ? JSON.stringify(val) : val);
  }
  values.push(id);
  getDb().prepare(`UPDATE experiments SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function listExperiments(status) {
  if (status) {
    return getDb().prepare("SELECT * FROM experiments WHERE status = ? ORDER BY created_at DESC").all(status);
  }
  return getDb().prepare("SELECT * FROM experiments ORDER BY created_at DESC").all();
}

export function addExperimentAssignment(experimentId, convId, variant) {
  const now = Date.now();
  const result = getDb()
    .prepare("INSERT INTO experiment_assignments (experiment_id, conv_id, variant, created_at) VALUES (?, ?, ?, ?)")
    .run(experimentId, convId, variant, now);
  return { id: result.lastInsertRowid };
}

export function getExperimentAssignment(convId) {
  return getDb()
    .prepare("SELECT * FROM experiment_assignments WHERE conv_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(convId);
}

// ── Self-Coded Tools (Phase 4) ──

export function addSelfCodedTool(data) {
  const now = Date.now();
  const result = getDb()
    .prepare(`INSERT INTO self_coded_tools
      (tool_name, description, input_schema, code, origin_reflection_id, origin_pattern, status, proposed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(data.tool_name, data.description || null,
      data.input_schema ? JSON.stringify(data.input_schema) : null,
      data.code || null, data.origin_reflection_id || null,
      data.origin_pattern || null, 'proposed', now, now);
  return { id: result.lastInsertRowid, created_at: now };
}

export function updateSelfCodedTool(id, updates) {
  const fields = [];
  const values = [];
  for (const [key, val] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(key === 'input_schema' ? JSON.stringify(val) : val);
  }
  values.push(id);
  getDb().prepare(`UPDATE self_coded_tools SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function getSelfCodedTool(id) {
  return getDb().prepare("SELECT * FROM self_coded_tools WHERE id = ?").get(id);
}

export function getSelfCodedToolByName(name) {
  return getDb().prepare("SELECT * FROM self_coded_tools WHERE tool_name = ?").get(name);
}

export function listSelfCodedTools(status) {
  if (status) {
    return getDb().prepare("SELECT * FROM self_coded_tools WHERE status = ? ORDER BY created_at DESC").all(status);
  }
  return getDb().prepare("SELECT * FROM self_coded_tools ORDER BY created_at DESC").all();
}

// ── Workspaces ──

export function createWorkspace(name, path) {
  const id = randomUUID().substring(0, 8);
  const now = Date.now();
  getDb()
    .prepare("INSERT INTO workspaces (id, name, path, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, name, path, 0, now, now);
  return { id, name, path, is_default: 0, created_at: now, updated_at: now };
}

export function listWorkspaces() {
  return getDb()
    .prepare("SELECT * FROM workspaces ORDER BY is_default DESC, updated_at DESC")
    .all();
}

export function getWorkspace(id) {
  return getDb()
    .prepare("SELECT * FROM workspaces WHERE id = ?")
    .get(id);
}

export function updateWorkspace(id, updates) {
  const ws = getWorkspace(id);
  if (!ws) throw new Error("Workspace not found");
  const now = Date.now();
  const name = updates.name !== undefined ? updates.name : ws.name;
  const path = updates.path !== undefined ? updates.path : ws.path;
  getDb()
    .prepare("UPDATE workspaces SET name = ?, path = ?, updated_at = ? WHERE id = ?")
    .run(name, path, now, id);
  return { ...ws, name, path, updated_at: now };
}

export function deleteWorkspace(id) {
  const ws = getWorkspace(id);
  if (!ws) throw new Error("Workspace not found");
  if (ws.is_default) throw new Error("Cannot delete default workspace");
  // Move conversations to default workspace
  getDb().prepare("UPDATE conversations SET workspace_id = 'default' WHERE workspace_id = ?").run(id);
  getDb().prepare("DELETE FROM workspaces WHERE id = ?").run(id);
}

export function getDefaultWorkspace() {
  return getDb()
    .prepare("SELECT * FROM workspaces WHERE is_default = 1")
    .get();
}
