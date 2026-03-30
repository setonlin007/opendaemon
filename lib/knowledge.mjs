// lib/knowledge.mjs — Knowledge CRUD (Markdown files + SQLite index)
import { getDb } from "./db.mjs";
import { logEvolution } from "./trace.mjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getProjectRoot } from "./config.mjs";

const CATEGORIES = ["preferences", "patterns", "domain", "rules", "automation"];
const KNOWLEDGE_DIR = () => join(getProjectRoot(), "data", "knowledge");

/**
 * Initialize knowledge directory and seed empty category files.
 */
export function initKnowledge() {
  const dir = KNOWLEDGE_DIR();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  for (const cat of CATEGORIES) {
    const filePath = join(dir, `${cat}.md`);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, `# ${cat.charAt(0).toUpperCase() + cat.slice(1)}\n\n`, "utf-8");
    }
  }
}

/**
 * List knowledge entries from the index, optionally filtered by category.
 */
export function listKnowledge(category = null) {
  if (category) {
    return getDb()
      .prepare(
        `SELECT id, category, title, tags, file_path, line_start, line_end,
                source_type, confidence, created_at, updated_at
         FROM knowledge_index WHERE category = ? ORDER BY updated_at DESC`
      )
      .all(category);
  }
  return getDb()
    .prepare(
      `SELECT id, category, title, tags, file_path, line_start, line_end,
              source_type, confidence, created_at, updated_at
       FROM knowledge_index ORDER BY updated_at DESC`
    )
    .all();
}

/**
 * Get the content of a knowledge entry by reading from Markdown file.
 */
export function getKnowledgeContent(id) {
  const entry = getDb()
    .prepare("SELECT * FROM knowledge_index WHERE id = ?")
    .get(id);
  if (!entry) return null;

  const filePath = join(getProjectRoot(), entry.file_path);
  if (!existsSync(filePath)) return { ...entry, content: null };

  const lines = readFileSync(filePath, "utf-8").split("\n");
  const content = lines.slice(entry.line_start - 1, entry.line_end).join("\n");
  return { ...entry, content };
}

/**
 * Add a knowledge entry: append to Markdown file and update index.
 */
export function addKnowledge(category, title, tags, content, sourceType = "reflection", confidence = 0.5) {
  if (!CATEGORIES.includes(category)) {
    throw new Error(`Invalid category: ${category}. Must be one of: ${CATEGORIES.join(", ")}`);
  }

  const dir = KNOWLEDGE_DIR();
  const relPath = `data/knowledge/${category}.md`;
  const absPath = join(dir, `${category}.md`);

  // Read current file
  let fileContent = existsSync(absPath) ? readFileSync(absPath, "utf-8") : `# ${category}\n\n`;
  const existingLines = fileContent.split("\n");

  // Build the new entry block
  const now = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const tagsStr = Array.isArray(tags) ? tags.join(", ") : tags;
  const block = [
    `## ${title}`,
    `_Tags: ${tagsStr} | Confidence: ${confidence} | Source: ${sourceType} | Updated: ${now}_`,
    "",
    content,
    "",
  ].join("\n");

  // Append
  const lineStart = existingLines.length + 1;
  fileContent = fileContent.trimEnd() + "\n\n" + block;
  writeFileSync(absPath, fileContent, "utf-8");
  const newLines = fileContent.split("\n");
  const lineEnd = newLines.length;

  // Index
  const nowMs = Date.now();
  const result = getDb()
    .prepare(
      `INSERT INTO knowledge_index
        (category, title, tags, file_path, line_start, line_end, source_type, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(category, title, tagsStr, relPath, lineStart, lineEnd, sourceType, confidence, nowMs, nowMs);

  const knowledgeId = result.lastInsertRowid;

  logEvolution("knowledge_created", {
    knowledge_id: knowledgeId,
    category,
    title,
    source: sourceType,
  });

  // Sync to FTS5 index
  syncFtsEntry(knowledgeId);

  return { id: knowledgeId, category, title, tags: tagsStr, line_start: lineStart, line_end: lineEnd };
}

/**
 * Update a knowledge entry in-place in the Markdown file and index.
 */
export function updateKnowledge(id, { content, tags, confidence } = {}) {
  const entry = getDb()
    .prepare("SELECT * FROM knowledge_index WHERE id = ?")
    .get(id);
  if (!entry) return null;

  const absPath = join(getProjectRoot(), entry.file_path);
  if (!existsSync(absPath)) return null;

  const lines = readFileSync(absPath, "utf-8").split("\n");

  // Update the block in the file
  if (content != null || tags != null || confidence != null) {
    const newTags = tags ?? entry.tags;
    const newConf = confidence ?? entry.confidence;
    const now = new Date().toISOString().split("T")[0];

    const newBlock = [
      `## ${entry.title}`,
      `_Tags: ${newTags} | Confidence: ${newConf} | Source: ${entry.source_type} | Updated: ${now}_`,
      "",
      content ?? getKnowledgeContent(id)?.content?.split("\n").slice(2).join("\n").trim() ?? "",
      "",
    ];

    // Replace lines in file
    lines.splice(entry.line_start - 1, entry.line_end - entry.line_start + 1, ...newBlock);
    writeFileSync(absPath, lines.join("\n"), "utf-8");

    const newLineEnd = entry.line_start + newBlock.length - 1;

    // Update index
    const nowMs = Date.now();
    getDb()
      .prepare(
        `UPDATE knowledge_index SET tags = ?, confidence = ?, line_end = ?, updated_at = ? WHERE id = ?`
      )
      .run(newTags, newConf, newLineEnd, nowMs, id);

    // Sync to FTS5 index
    syncFtsEntry(id);

    // Shift line numbers for entries below this one in the same file
    const lineDiff = newBlock.length - (entry.line_end - entry.line_start + 1);
    if (lineDiff !== 0) {
      getDb()
        .prepare(
          `UPDATE knowledge_index SET line_start = line_start + ?, line_end = line_end + ?
           WHERE file_path = ? AND line_start > ? AND id != ?`
        )
        .run(lineDiff, lineDiff, entry.file_path, entry.line_end, id);
    }
  }

  return { id, updated: true };
}

/**
 * Delete a knowledge entry from Markdown file and index.
 */
export function deleteKnowledge(id) {
  const entry = getDb()
    .prepare("SELECT * FROM knowledge_index WHERE id = ?")
    .get(id);
  if (!entry) return null;

  const absPath = join(getProjectRoot(), entry.file_path);
  if (existsSync(absPath)) {
    const lines = readFileSync(absPath, "utf-8").split("\n");
    const removeCount = entry.line_end - entry.line_start + 1;
    lines.splice(entry.line_start - 1, removeCount);
    writeFileSync(absPath, lines.join("\n"), "utf-8");

    // Shift line numbers for entries below
    getDb()
      .prepare(
        `UPDATE knowledge_index SET line_start = line_start - ?, line_end = line_end - ?
         WHERE file_path = ? AND line_start > ? AND id != ?`
      )
      .run(removeCount, removeCount, entry.file_path, entry.line_end, id);
  }

  getDb().prepare("DELETE FROM knowledge_index WHERE id = ?").run(id);

  // Remove from FTS5 index
  removeFtsEntry(id);

  logEvolution("knowledge_deleted", {
    knowledge_id: id,
    category: entry.category,
    title: entry.title,
  });

  return { id, deleted: true };
}

/**
 * Search knowledge entries by keywords.
 * Uses FTS5 full-text search with LIKE fallback for robustness.
 */
export function searchKnowledge(keywords, maxResults = 10) {
  if (!keywords || !keywords.length) return [];

  const terms = Array.isArray(keywords) ? keywords : keywords.split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  // Try FTS5 first
  try {
    const ftsQuery = terms.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    const ftsResults = getDb()
      .prepare(
        `SELECT ki.id, ki.category, ki.title, ki.tags, ki.file_path,
                ki.line_start, ki.line_end, ki.source_type, ki.confidence,
                ki.created_at, ki.updated_at
         FROM knowledge_fts fts
         JOIN knowledge_index ki ON ki.id = fts.rowid
         WHERE knowledge_fts MATCH ?
         ORDER BY ki.confidence DESC, ki.updated_at DESC
         LIMIT ?`
      )
      .all(ftsQuery, maxResults);
    if (ftsResults.length > 0) return ftsResults;
  } catch (_) {
    // FTS5 not available or query error — fall through to LIKE
  }

  // Fallback: LIKE-based search
  const conditions = terms.map(() => "(tags LIKE ? OR title LIKE ?)").join(" OR ");
  const params = [];
  for (const term of terms) {
    const like = `%${term}%`;
    params.push(like, like);
  }
  params.push(maxResults);

  return getDb()
    .prepare(
      `SELECT id, category, title, tags, file_path, line_start, line_end,
              source_type, confidence, created_at, updated_at
       FROM knowledge_index
       WHERE ${conditions}
       ORDER BY confidence DESC, updated_at DESC
       LIMIT ?`
    )
    .all(...params);
}

/**
 * Sync a knowledge entry into the FTS5 index.
 * Called after add/update; safe to call repeatedly.
 */
export function syncFtsEntry(id) {
  try {
    const entry = getDb()
      .prepare("SELECT id, title, tags FROM knowledge_index WHERE id = ?")
      .get(id);
    if (!entry) return;

    const full = getKnowledgeContent(id);
    const content = full?.content ?? "";

    // For contentless FTS5: just INSERT (rebuild handles clean state)
    // Duplicate rowids are handled gracefully by FTS5
    try {
      getDb()
        .prepare("INSERT INTO knowledge_fts (rowid, title, tags, content) VALUES (?, ?, ?, ?)")
        .run(id, entry.title, entry.tags || "", content);
    } catch (insertErr) {
      // If rowid already exists, ignore — will be correct after next rebuild
    }
  } catch (err) {
    // FTS5 table might not exist yet in older DBs — silently skip
    console.warn("[knowledge] FTS sync failed for id", id, ":", err.message);
  }
}

/**
 * Remove a knowledge entry from the FTS5 index.
 * Contentless FTS5 tables require special delete syntax.
 */
export function removeFtsEntry(id) {
  try {
    // For contentless FTS5, we need to supply the old values for deletion
    const entry = getDb()
      .prepare("SELECT title, tags FROM knowledge_index WHERE id = ?")
      .get(id);
    if (entry) {
      getDb()
        .prepare("INSERT INTO knowledge_fts(knowledge_fts, rowid, title, tags, content) VALUES('delete', ?, ?, ?, '')")
        .run(id, entry.title, entry.tags || "");
    }
  } catch (_) {
    // Silently skip — entry might not exist in FTS
  }
}

/**
 * Rebuild entire FTS5 index from knowledge_index table.
 * Useful for migration or recovery.
 */
export function rebuildFtsIndex() {
  try {
    const db = getDb();
    // Contentless FTS5 tables don't support DELETE — drop and recreate
    db.exec("DROP TABLE IF EXISTS knowledge_fts");
    db.exec(`CREATE VIRTUAL TABLE knowledge_fts USING fts5(
      title, tags, content,
      content='',
      tokenize='unicode61'
    )`);
    const entries = listKnowledge();
    for (const entry of entries) {
      syncFtsEntry(entry.id);
    }
    console.log(`[knowledge] FTS index rebuilt: ${entries.length} entries`);
  } catch (err) {
    console.warn("[knowledge] FTS rebuild failed:", err.message);
  }
}

/**
 * Get all knowledge entries as formatted text (for injection / reflection).
 */
export function getAllKnowledgeFormatted() {
  const entries = listKnowledge();
  if (!entries.length) return "";

  const sections = [];
  for (const entry of entries) {
    const full = getKnowledgeContent(entry.id);
    if (full?.content) {
      sections.push(full.content.trim());
    }
  }
  return sections.join("\n\n");
}

/**
 * Sync workspace knowledge from ~/workspace/.workspace.json into the knowledge base.
 * Called once at startup. Silently skips if .workspace.json doesn't exist.
 */
export function syncWorkspaceKnowledge() {
  try {
    const wsPath = join(homedir(), "workspace", ".workspace.json");
    if (!existsSync(wsPath)) {
      console.log("[workspace] .workspace.json not found, skipping knowledge sync");
      return;
    }

    const ws = JSON.parse(readFileSync(wsPath, "utf-8"));
    if (!ws.projects || !Object.keys(ws.projects).length) return;

    // Build knowledge content
    let content = "当前 workspace: ~/workspace\n项目列表:\n";
    for (const [name, proj] of Object.entries(ws.projects)) {
      content += `- ${name} (${proj.path}) — ${proj.type}, ${proj.description}\n`;
    }
    content += "\n规则:\n";
    content += '- 开发任务不确定项目时，询问用户："你指的是哪个项目？"\n';
    content += `- 非代码产物（Excel、文档、图片等）存到 ~/workspace/${ws.artifacts_path || "artifacts"}/ 对应子目录\n`;
    content += `- 产物下载链接: /api/workspace/files/{path}`;

    const title = "Workspace 结构";
    const tags = "workspace, project, file, code, develop, 项目, 开发, 文件, 创建, 修改";

    // Check if workspace knowledge already exists — update or create
    const db = getDb();
    const existing = db
      .prepare("SELECT id FROM knowledge_index WHERE title = ? AND category = ?")
      .get(title, "rules");

    if (existing) {
      updateKnowledge(existing.id, { content, tags, confidence: 1.0 });
      console.log("[workspace] updated existing workspace knowledge entry");
    } else {
      addKnowledge("rules", title, tags, content, "system", 1.0);
      console.log("[workspace] created workspace knowledge entry");
    }
  } catch (err) {
    console.error("[workspace] failed to sync workspace knowledge:", err.message);
  }
}
