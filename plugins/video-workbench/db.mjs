/**
 * Video Workbench · 独立 SQLite (data/vf.db)
 *
 * 5 张表 + AES key 加密。完全独立于 opendaemon.db，删插件时直接 rm vf.db。
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

let db = null;

export function initVfDb(dataDir) {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "vf.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS vf_projects (
      id              TEXT PRIMARY KEY,
      slug            TEXT NOT NULL UNIQUE,
      title           TEXT NOT NULL,
      workspace_path  TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'brief',
      engine_id       TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vf_projects_status ON vf_projects(status);
    CREATE INDEX IF NOT EXISTS idx_vf_projects_updated ON vf_projects(updated_at DESC);

    CREATE TABLE IF NOT EXISTS vf_pipeline_runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id      TEXT NOT NULL REFERENCES vf_projects(id) ON DELETE CASCADE,
      phase           TEXT NOT NULL,
      script_path     TEXT NOT NULL,
      argv_json       TEXT,
      env_keys_json   TEXT,
      pid             INTEGER,
      status          TEXT NOT NULL DEFAULT 'queued',
      exit_code       INTEGER,
      started_at      INTEGER,
      finished_at     INTEGER,
      log_path        TEXT,
      output_files_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_vf_runs_project_phase ON vf_pipeline_runs(project_id, phase);
    CREATE INDEX IF NOT EXISTS idx_vf_runs_status ON vf_pipeline_runs(status);

    CREATE TABLE IF NOT EXISTS vf_api_keys (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      provider    TEXT NOT NULL,
      label       TEXT NOT NULL DEFAULT 'default',
      key_cipher  BLOB NOT NULL,
      key_iv      BLOB NOT NULL,
      last_used_at INTEGER,
      created_at  INTEGER NOT NULL,
      UNIQUE(provider, label)
    );

    CREATE TABLE IF NOT EXISTS vf_versions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id      TEXT NOT NULL REFERENCES vf_projects(id) ON DELETE CASCADE,
      artifact_type   TEXT NOT NULL,
      version         INTEGER NOT NULL,
      file_rel_path   TEXT NOT NULL,
      is_current      INTEGER NOT NULL DEFAULT 0,
      is_trashed      INTEGER NOT NULL DEFAULT 0,
      metadata_json   TEXT,
      created_at      INTEGER NOT NULL,
      UNIQUE(project_id, artifact_type, version)
    );
    CREATE INDEX IF NOT EXISTS idx_vf_versions_current
      ON vf_versions(project_id, artifact_type, is_current);

    CREATE TABLE IF NOT EXISTS vf_recording_sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  TEXT NOT NULL REFERENCES vf_projects(id) ON DELETE CASCADE,
      step        INTEGER NOT NULL DEFAULT 0,
      state_json  TEXT,
      started_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);

  return db;
}

export function getDb() {
  if (!db) throw new Error("vf db not initialized");
  return db;
}

// ─────────── 项目 CRUD ───────────

export function createProject({ id, slug, title, workspacePath, engineId = null }) {
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO vf_projects (id, slug, title, workspace_path, status, engine_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'brief', ?, ?, ?)
  `).run(id, slug, title, workspacePath, engineId, now, now);
  return getProject(id);
}

export function getProject(id) {
  return getDb().prepare("SELECT * FROM vf_projects WHERE id = ?").get(id);
}

export function getProjectBySlug(slug) {
  return getDb().prepare("SELECT * FROM vf_projects WHERE slug = ?").get(slug);
}

export function listProjects() {
  return getDb().prepare("SELECT * FROM vf_projects WHERE status != 'archived' ORDER BY updated_at DESC").all();
}

export function updateProject(id, fields) {
  const allowed = ["title", "status", "engine_id"];
  const sets = [], vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  }
  if (!sets.length) return getProject(id);
  sets.push("updated_at = ?"); vals.push(Date.now()); vals.push(id);
  getDb().prepare(`UPDATE vf_projects SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getProject(id);
}

export function archiveProject(id) {
  getDb().prepare("UPDATE vf_projects SET status = 'archived', updated_at = ? WHERE id = ?")
    .run(Date.now(), id);
}

// ─────────── Pipeline runs ───────────

export function createRun({ projectId, phase, scriptPath, argvJson, envKeysJson, logPath }) {
  const r = getDb().prepare(`
    INSERT INTO vf_pipeline_runs (project_id, phase, script_path, argv_json, env_keys_json, status, started_at, log_path)
    VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
  `).run(projectId, phase, scriptPath, argvJson || null, envKeysJson || null, Date.now(), logPath || null);
  return r.lastInsertRowid;
}

export function updateRun(id, fields) {
  const allowed = ["status", "exit_code", "finished_at", "pid", "output_files_json"];
  const sets = [], vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  }
  if (!sets.length) return;
  vals.push(id);
  getDb().prepare(`UPDATE vf_pipeline_runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function getRun(id) {
  return getDb().prepare("SELECT * FROM vf_pipeline_runs WHERE id = ?").get(id);
}

export function listRuns(projectId, { phase = null, limit = 50 } = {}) {
  if (phase) {
    return getDb().prepare(
      "SELECT * FROM vf_pipeline_runs WHERE project_id = ? AND phase = ? ORDER BY id DESC LIMIT ?"
    ).all(projectId, phase, limit);
  }
  return getDb().prepare(
    "SELECT * FROM vf_pipeline_runs WHERE project_id = ? ORDER BY id DESC LIMIT ?"
  ).all(projectId, limit);
}

// ─────────── API keys ───────────

export function saveApiKey({ provider, label, keyCipher, keyIv }) {
  getDb().prepare(`
    INSERT INTO vf_api_keys (provider, label, key_cipher, key_iv, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(provider, label) DO UPDATE SET
      key_cipher = excluded.key_cipher,
      key_iv = excluded.key_iv,
      created_at = excluded.created_at
  `).run(provider, label || "default", keyCipher, keyIv, Date.now());
}

export function getApiKey(provider, label = "default") {
  return getDb().prepare(
    "SELECT * FROM vf_api_keys WHERE provider = ? AND label = ?"
  ).get(provider, label);
}

export function listApiKeys() {
  // 不返回密文，只返回元数据
  return getDb().prepare(
    "SELECT id, provider, label, last_used_at, created_at FROM vf_api_keys ORDER BY provider, label"
  ).all();
}

export function deleteApiKey(provider, label = "default") {
  getDb().prepare("DELETE FROM vf_api_keys WHERE provider = ? AND label = ?").run(provider, label);
}

export function touchApiKey(provider, label = "default") {
  getDb().prepare(
    "UPDATE vf_api_keys SET last_used_at = ? WHERE provider = ? AND label = ?"
  ).run(Date.now(), provider, label);
}

// ─────────── Versions ───────────

export function addVersion({ projectId, artifactType, version, fileRelPath, metadataJson, setCurrent = true }) {
  const now = Date.now();
  if (setCurrent) {
    getDb().prepare(
      "UPDATE vf_versions SET is_current = 0 WHERE project_id = ? AND artifact_type = ?"
    ).run(projectId, artifactType);
  }
  getDb().prepare(`
    INSERT INTO vf_versions (project_id, artifact_type, version, file_rel_path, is_current, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, artifactType, version, fileRelPath, setCurrent ? 1 : 0, metadataJson || null, now);
}

export function nextVersionNumber(projectId, artifactType) {
  const r = getDb().prepare(
    "SELECT COALESCE(MAX(version), 0) AS m FROM vf_versions WHERE project_id = ? AND artifact_type = ?"
  ).get(projectId, artifactType);
  return (r?.m || 0) + 1;
}

export function listVersions(projectId, artifactType = null) {
  if (artifactType) {
    return getDb().prepare(
      "SELECT * FROM vf_versions WHERE project_id = ? AND artifact_type = ? AND is_trashed = 0 ORDER BY version DESC"
    ).all(projectId, artifactType);
  }
  return getDb().prepare(
    "SELECT * FROM vf_versions WHERE project_id = ? AND is_trashed = 0 ORDER BY artifact_type, version DESC"
  ).all(projectId);
}

export function setCurrentVersion(projectId, artifactType, version) {
  getDb().prepare(
    "UPDATE vf_versions SET is_current = 0 WHERE project_id = ? AND artifact_type = ?"
  ).run(projectId, artifactType);
  getDb().prepare(
    "UPDATE vf_versions SET is_current = 1 WHERE project_id = ? AND artifact_type = ? AND version = ?"
  ).run(projectId, artifactType, version);
}
