/**
 * Video Workbench · HTTP 路由分发
 * 所有路径走 /api/vf/* 和 /vf/* (前端静态)
 */
import { readFileSync, existsSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { homedir } from "os";

import {
  createProject, getProject, getProjectBySlug, listProjects, updateProject, archiveProject,
  createRun, getRun, listRuns, updateRun,
  saveApiKey, getApiKey, listApiKeys, deleteApiKey,
  addVersion, listVersions, setCurrentVersion, nextVersionNumber,
  findVersionByPath, trashVersion,
} from "./db.mjs";
import { createReadStream } from "fs";
import { encryptKey, decryptKey } from "./keys.mjs";
import { bootstrapProjectDir, readManifest, writeManifest, setPhase } from "./manifest.mjs";
import { runSkill, killRunTree, isPhaseRunning } from "./skill-runner.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_DIR = join(__dirname, "web");

// 默认 skill scripts 路径（软链到项目目录用）
const SKILL_SCRIPTS_PATH = join(homedir(), "workspace", "skills", "video-factory", "scripts");

// 跑时注入的工作区根目录
const PROJECTS_ROOT = join(homedir(), "workspace", "projects");

// 路径正则
const RE_PROJECT_ID = /^\/api\/vf\/projects\/([\w-]+)(?:\/(.+))?$/;
const RE_RUN_ID = /^\/api\/vf\/runs\/(\d+)(?:\/(\w+))?$/;

// ─────────── helpers ───────────

function jsonRes(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const s = Buffer.concat(chunks).toString("utf8");
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function startSSE(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  send("connected", { ts: Date.now() });
  return send;
}

// ─────────── 路由 dispatch ───────────

export function createRouter({ daemonAuthSecret, projectsRoot, logsDir }) {
  return {
    match(method, path) {
      return path.startsWith("/api/vf/") || path.startsWith("/vf/") || path === "/video-factory.html";
    },

    async handle(req, res) {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;
      const method = req.method;

      try {
        // ─── 静态 web 文件 ───
        if (path === "/video-factory.html" || path.startsWith("/vf/static/")) {
          return serveStatic(path, res);
        }

        // ─── /api/vf/health ───
        if (path === "/api/vf/health") {
          return jsonRes(res, { ok: true, projects: listProjects().length });
        }

        // ─── 项目 CRUD ───
        if (path === "/api/vf/projects" && method === "GET") {
          return jsonRes(res, { projects: listProjects() });
        }
        if (path === "/api/vf/projects" && method === "POST") {
          const body = await readJsonBody(req);
          return await handleCreateProject(body, projectsRoot, res);
        }

        const mProject = path.match(RE_PROJECT_ID);
        if (mProject) {
          const projectId = mProject[1];
          const sub = mProject[2]; // 可能为 undefined, "brief", "content", "audio", ...
          return await handleProjectRoute({ projectId, sub, method, req, res, projectsRoot, logsDir, daemonAuthSecret });
        }

        // ─── Runs ───
        const mRun = path.match(RE_RUN_ID);
        if (mRun) {
          const runId = parseInt(mRun[1], 10);
          const sub = mRun[2];
          return await handleRunRoute({ runId, sub, method, res });
        }

        // ─── API keys ───
        if (path === "/api/vf/keys" && method === "GET") {
          return jsonRes(res, { keys: listApiKeys() });
        }
        if (path === "/api/vf/keys" && method === "POST") {
          const body = await readJsonBody(req);
          return handleSaveKey(body, daemonAuthSecret, res);
        }
        const mKey = path.match(/^\/api\/vf\/keys\/([\w-]+)(?:\/(.+))?$/);
        if (mKey && method === "DELETE") {
          deleteApiKey(mKey[1], mKey[2] || "default");
          return jsonRes(res, { ok: true });
        }

        return jsonRes(res, { error: "not found" }, 404);
      } catch (err) {
        console.error("[vf]", err);
        return jsonRes(res, { error: err.message || "internal error" }, err.status || 500);
      }
    },
  };
}

function serveStatic(path, res) {
  let fileName;
  if (path === "/video-factory.html") {
    fileName = "video-factory.html";
  } else {
    // /vf/static/x.css → web/x.css
    fileName = path.replace(/^\/vf\/static\//, "");
    if (!fileName || fileName.includes("..")) {
      res.writeHead(403); return res.end("forbidden");
    }
  }
  const filePath = join(WEB_DIR, fileName);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404); return res.end("not found");
  }
  const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase();
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js":  "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  }[ext] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": statSync(filePath).size,
  });
  return res.end(readFileSync(filePath));
}

// ─────────── 项目 CRUD ───────────

async function handleCreateProject(body, projectsRoot, res) {
  const { slug, title, engine_id } = body;
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return jsonRes(res, { error: "invalid slug (a-z 0-9 -)" }, 400);
  }
  if (!title || title.length > 120) {
    return jsonRes(res, { error: "title required (<=120)" }, 400);
  }
  const dup = getProjectBySlug(slug);
  if (dup) return jsonRes(res, { error: `slug "${slug}" already exists` }, 409);

  const workspacePath = join(projectsRoot, slug);
  if (existsSync(workspacePath)) {
    return jsonRes(res, { error: `directory ${workspacePath} already exists, choose different slug` }, 409);
  }

  const id = randomUUID();
  const project = createProject({ id, slug, title, workspacePath, engineId: engine_id || null });

  try {
    await bootstrapProjectDir(workspacePath, id, slug, title, SKILL_SCRIPTS_PATH);
  } catch (err) {
    console.error("[vf] bootstrap failed:", err);
    return jsonRes(res, { error: `bootstrap failed: ${err.message}` }, 500);
  }

  return jsonRes(res, { project }, 201);
}

async function handleProjectRoute({ projectId, sub, method, req, res, projectsRoot, logsDir, daemonAuthSecret }) {
  const project = getProject(projectId);
  if (!project) return jsonRes(res, { error: "project not found" }, 404);

  // GET /api/vf/projects/:id
  if (!sub && method === "GET") {
    const manifest = readManifest(project.workspace_path);
    return jsonRes(res, {
      project,
      manifest,
      versions: listVersions(projectId),
      runs: listRuns(projectId, { limit: 20 }),
    });
  }

  // DELETE /api/vf/projects/:id (软删)
  if (!sub && method === "DELETE") {
    archiveProject(projectId);
    // 不动磁盘文件，留给用户手动清理
    return jsonRes(res, { ok: true, archived: true });
  }

  // PUT /api/vf/projects/:id/brief
  if (sub === "brief" && method === "PUT") {
    const body = await readJsonBody(req);
    const briefPath = join(project.workspace_path, "brief.json");
    const fs = await import("fs/promises");
    await fs.writeFile(briefPath, JSON.stringify(body, null, 2));
    setPhase(project.workspace_path, "content");
    updateProject(projectId, { status: "content" });
    return jsonRes(res, { ok: true, brief_path: "brief.json" });
  }

  // GET /api/vf/projects/:id/manifest
  if (sub === "manifest" && method === "GET") {
    return jsonRes(res, readManifest(project.workspace_path) || {});
  }

  // POST /api/vf/projects/:id/audio  (SSE)
  if (sub === "audio" && method === "POST") {
    const body = await readJsonBody(req);
    return await handleAudioSynth({ project, body, projectId, logsDir, daemonAuthSecret, res });
  }

  // POST /api/vf/projects/:id/lint  (SSE)
  if (sub === "lint" && method === "POST") {
    return await handleSyncAudit({ project, projectId, logsDir, res, lintMode: true });
  }

  // POST /api/vf/projects/:id/sync-audit  (SSE)
  if (sub === "sync-audit" && method === "POST") {
    return await handleSyncAudit({ project, projectId, logsDir, res, lintMode: false });
  }

  // GET /api/vf/projects/:id/runs
  if (sub === "runs" && method === "GET") {
    return jsonRes(res, { runs: listRuns(projectId, { limit: 50 }) });
  }

  // GET /api/vf/projects/:id/versions[?type=final]
  if (sub === "versions" && method === "GET") {
    const url = new URL(req.url, "http://localhost");
    const type = url.searchParams.get("type");
    return jsonRes(res, { versions: listVersions(projectId, type) });
  }

  // POST /api/vf/projects/:id/versions/:type/:version/switch
  // POST /api/vf/projects/:id/versions/:type/:version/trash
  // GET  /api/vf/projects/:id/files/<rel...>
  if (sub?.startsWith("versions/")) {
    return await handleVersionAction({ project, projectId, sub, method, res });
  }
  if (sub?.startsWith("files/")) {
    const rel = sub.substring("files/".length);
    return await serveProjectFile({ project, rel, method, req, res });
  }

  return jsonRes(res, { error: `unknown route: /api/vf/projects/${projectId}/${sub}` }, 404);
}

async function handleVersionAction({ project, projectId, sub, method, res }) {
  // sub 格式: versions/<type>/<version>/<action>
  const parts = sub.split("/");
  if (parts.length < 4) return jsonRes(res, { error: "invalid version path" }, 400);
  const [, type, verStr, action] = parts;
  const version = parseInt(verStr, 10);
  if (isNaN(version)) return jsonRes(res, { error: "invalid version number" }, 400);

  if (action === "switch" && method === "POST") {
    setCurrentVersion(projectId, type, version);
    return jsonRes(res, { ok: true, type, version });
  }
  if (action === "trash" && method === "POST") {
    trashVersion(projectId, type, version);
    return jsonRes(res, { ok: true, type, version });
  }
  return jsonRes(res, { error: `unknown version action: ${action}` }, 404);
}

async function serveProjectFile({ project, rel, method, req, res }) {
  if (method !== "GET") return jsonRes(res, { error: "method not allowed" }, 405);
  if (!rel || rel.includes("..")) return jsonRes(res, { error: "invalid path" }, 403);

  rel = decodeURIComponent(rel);

  // 安全：只允许 versions 表里登记过的路径
  const reg = findVersionByPath(project.id, rel);
  if (!reg) {
    return jsonRes(res, { error: "file not registered in versions table" }, 404);
  }

  // 解析真实路径：__daemon_data__ 前缀指向 daemon data/ 目录
  let absPath;
  if (rel.startsWith("__daemon_data__/")) {
    const daemonData = join(import.meta.url.includes("file://")
      ? new URL("../../data/", import.meta.url).pathname
      : "/root/workspace/projects/opendaemon/data/",
      rel.substring("__daemon_data__/".length));
    absPath = daemonData;
  } else {
    absPath = join(project.workspace_path, rel);
  }

  // 兜底：解析后路径必须在合法根目录内
  const ok = absPath.startsWith(project.workspace_path) ||
             absPath.startsWith("/root/workspace/projects/opendaemon/data/");
  if (!ok) return jsonRes(res, { error: "path escape" }, 403);

  if (!existsSync(absPath)) {
    return jsonRes(res, { error: `file not found: ${absPath}` }, 404);
  }

  const stat = statSync(absPath);
  if (!stat.isFile()) return jsonRes(res, { error: "not a file" }, 404);

  // MIME by ext
  const ext = absPath.substring(absPath.lastIndexOf(".")).toLowerCase();
  const MIME = {
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
  };
  const contentType = MIME[ext] || "application/octet-stream";

  // ?download=1 强制下载
  const url = new URL(req.url, "http://localhost");
  const forceDownload = url.searchParams.get("download") === "1";
  const fileName = rel.split("/").pop();
  const previewable = [".png",".jpg",".jpeg",".webp",".svg",".mp4",".webm",".mp3",".json",".md",".txt"].includes(ext);
  const disposition = (previewable && !forceDownload)
    ? `inline; filename="${fileName}"`
    : `attachment; filename="${fileName}"`;

  // Range support for video/audio streaming
  const range = req.headers.range;
  const fileSize = stat.size;
  if (range && previewable && !forceDownload && /^bytes=/.test(range)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : fileSize - 1;
      if (isNaN(start)) start = 0;
      if (isNaN(end) || end >= fileSize) end = fileSize - 1;
      if (start > end || start >= fileSize) {
        res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
        return res.end();
      }
      res.writeHead(206, {
        "Content-Type": contentType,
        "Content-Disposition": disposition,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
      });
      return createReadStream(absPath, { start, end }).pipe(res);
    }
  }

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Disposition": disposition,
    "Content-Length": fileSize,
    "Accept-Ranges": "bytes",
  });
  return createReadStream(absPath).pipe(res);
}

async function handleAudioSynth({ project, body, projectId, logsDir, daemonAuthSecret, res }) {
  if (isPhaseRunning(projectId, "audio")) {
    return jsonRes(res, { error: "audio synth already running" }, 409);
  }

  const provider = body.provider || "minimax";
  const voice = body.voice || "male-qn-qingse";
  const model = body.model || "speech-02-hd";
  const speed = String(body.speed ?? 1.0);
  const force = body.force === true;

  // 取 key
  let envKey = {};
  let scriptName;
  if (provider === "minimax") {
    const row = getApiKey("minimax", body.label || "default");
    if (!row) return jsonRes(res, { error: "MiniMax key not configured" }, 400);
    try {
      const plaintext = decryptKey(row, daemonAuthSecret);
      envKey.MINIMAX_API_KEY = plaintext;
    } catch (err) {
      return jsonRes(res, { error: "key decrypt failed" }, 500);
    }
    scriptName = "synthesize-audio-mmx-api.py";
  } else if (provider === "edge") {
    scriptName = "synthesize-audio-edge.py";
  } else {
    return jsonRes(res, { error: `unknown provider: ${provider}` }, 400);
  }

  const scriptPath = join(SKILL_SCRIPTS_PATH, scriptName);
  if (!existsSync(scriptPath)) {
    return jsonRes(res, { error: `script not found: ${scriptPath}` }, 500);
  }

  const send = startSSE({ req: null }, res);
  const args = [scriptPath, "--voice", voice, "--model", model, "--speed", speed];
  if (force) args.push("--force");

  try {
    const { promise } = await runSkill({
      projectId,
      phase: "audio",
      cmd: "python3",
      args,
      cwd: project.workspace_path,
      env: envKey,
      logsDir,
      createRunFn: createRun,
      onSSE: (event, data) => send(event, data),
    });
    await promise;
  } catch (err) {
    send("error", { message: err.message });
  }
  send("end", { ts: Date.now() });
  res.end();
}

async function handleSyncAudit({ project, projectId, logsDir, res, lintMode }) {
  const phase = lintMode ? "lint" : "sync-audit";
  if (isPhaseRunning(projectId, phase)) {
    return jsonRes(res, { error: `${phase} already running` }, 409);
  }
  const scriptPath = join(SKILL_SCRIPTS_PATH, "sync-audit.py");
  if (!existsSync(scriptPath)) {
    return jsonRes(res, { error: `sync-audit.py not found` }, 500);
  }
  const send = startSSE({ req: null }, res);
  const args = [scriptPath];
  if (lintMode) args.push("--lint");

  try {
    const { promise } = await runSkill({
      projectId, phase, cmd: "python3", args,
      cwd: project.workspace_path,
      logsDir,
      createRunFn: createRun,
      onSSE: (event, data) => send(event, data),
    });
    await promise;
  } catch (err) {
    send("error", { message: err.message });
  }
  send("end", { ts: Date.now() });
  res.end();
}

// ─────────── runs ───────────

async function handleRunRoute({ runId, sub, method, res }) {
  const run = getRun(runId);
  if (!run) return jsonRes(res, { error: "run not found" }, 404);

  if (!sub && method === "GET") {
    return jsonRes(res, { run });
  }

  if (sub === "log" && method === "GET") {
    if (!run.log_path || !existsSync(run.log_path)) {
      return jsonRes(res, { error: "log not available" }, 404);
    }
    const content = readFileSync(run.log_path, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(content),
    });
    return res.end(content);
  }

  if (sub === "kill" && method === "POST") {
    const ok = await killRunTree(runId);
    return jsonRes(res, { ok });
  }

  return jsonRes(res, { error: `unknown run route: /api/vf/runs/${runId}/${sub}` }, 404);
}

// ─────────── keys ───────────

function handleSaveKey(body, daemonAuthSecret, res) {
  const { provider, label = "default", key } = body;
  if (!provider || !key) return jsonRes(res, { error: "provider and key required" }, 400);
  if (!daemonAuthSecret) return jsonRes(res, { error: "auth secret not available for key derivation" }, 500);
  try {
    const { cipher, iv } = encryptKey(key, daemonAuthSecret);
    saveApiKey({ provider, label, keyCipher: cipher, keyIv: iv });
    return jsonRes(res, { ok: true });
  } catch (err) {
    return jsonRes(res, { error: `encrypt failed: ${err.message}` }, 500);
  }
}
