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
import { runSkill, killRunTree, isPhaseRunning, getActiveRunId } from "./skill-runner.mjs";

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

export function createRouter({ daemonAuthSecret, projectsRoot, logsDir, parseMultipart, streamClaude }) {
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

        // ─── /api/vf/active-runs (Status Tray 轮询) ───
        if (path === "/api/vf/active-runs") {
          const { getDb } = await import("./db.mjs");
          const rows = getDb().prepare(
            "SELECT r.id, r.project_id, r.phase, r.started_at, p.slug, p.title FROM vf_pipeline_runs r JOIN vf_projects p ON p.id = r.project_id WHERE r.status = 'running' ORDER BY r.started_at DESC"
          ).all();
          return jsonRes(res, { runs: rows });
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
          return await handleProjectRoute({ projectId, sub, method, req, res, projectsRoot, logsDir, daemonAuthSecret, parseMultipart, streamClaude });
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

async function handleProjectRoute({ projectId, sub, method, req, res, projectsRoot, logsDir, daemonAuthSecret, parseMultipart, streamClaude }) {
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

  // POST /api/vf/projects/:id/recording/playwright  (SSE)
  if (sub === "recording/playwright" && method === "POST") {
    return await handleRecording({ project, projectId, logsDir, res });
  }

  // POST /api/vf/projects/:id/encode  (SSE)
  if (sub === "encode" && method === "POST") {
    const body = await readJsonBody(req);
    return await handleEncode({ project, projectId, body, logsDir, res });
  }

  // POST /api/vf/projects/:id/build-timing  (SSE) · 跑完音频要 build-timing.py 才能录
  if (sub === "build-timing" && method === "POST") {
    return await handleBuildTiming({ project, projectId, logsDir, res });
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

  // ── 文件上传 ──
  // POST /api/vf/projects/:id/uploads  (multipart) → 落到 <project>/uploads/
  if (sub === "uploads" && method === "POST") {
    return await handleUpload({ project, projectId, req, res, parseMultipart });
  }

  // ── Mac 录屏流程 ──
  if (sub === "mac/build-master-audio" && method === "POST") {
    return await handleMacScript({ project, projectId, logsDir, res,
      phase: "build-master", script: "build-master-audio.py", cmd: "python3", args: [] });
  }
  if (sub === "mac/analyze" && method === "POST") {
    const body = await readJsonBody(req);
    if (!body.mov_rel) return jsonRes(res, { error: "mov_rel required" }, 400);
    return await handleMacScript({ project, projectId, logsDir, res,
      phase: "analyze", script: "analyze-recording.sh", cmd: "bash",
      args: [join(project.workspace_path, body.mov_rel)] });
  }
  if (sub === "mac/process" && method === "POST") {
    const body = await readJsonBody(req);
    if (!body.mov_rel) return jsonRes(res, { error: "mov_rel required" }, 400);
    const trimStart = String(body.trim_start ?? 0);
    const cropSpec = body.crop || "";
    return await handleMacProcess({ project, projectId, logsDir, res,
      movRel: body.mov_rel, trimStart, cropSpec });
  }

  // ── 发布：封面 ──
  if (sub === "publish/covers" && method === "POST") {
    const body = await readJsonBody(req);
    return await handleGenCovers({ project, projectId, logsDir, res, body });
  }

  // ── 发布：多平台文案 ──
  if (sub === "publish/copy" && method === "POST") {
    if (!streamClaude) return jsonRes(res, { error: "Claude SDK not wired" }, 500);
    const body = await readJsonBody(req);
    return await handlePublishCopy({ project, projectId, res, body, streamClaude });
  }

  // ── Content 一键生成 ──
  if (sub === "content/generate" && method === "POST") {
    if (!streamClaude) return jsonRes(res, { error: "Claude SDK not wired" }, 500);
    return await handleContentGenerate({ project, projectId, res, streamClaude });
  }

  // ── Scaffold 视觉模板 ──
  if (sub === "scaffold" && method === "POST") {
    const body = await readJsonBody(req);
    return await handleScaffold({ project, projectId, body, res });
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

// ─────────── P0-1 文件上传 ───────────
async function handleUpload({ project, projectId, req, res, parseMultipart }) {
  if (!parseMultipart) {
    return jsonRes(res, { error: "multipart parser not wired" }, 500);
  }
  try {
    const { files } = await parseMultipart(req);
    if (!files.length) return jsonRes(res, { error: "no file uploaded" }, 400);
    const fs = await import("fs/promises");
    const { existsSync, mkdirSync } = await import("fs");
    const uploadsDir = join(project.workspace_path, "uploads");
    if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
    const saved = [];
    for (const f of files) {
      // 防穿越：filename 只允许文件名，不含路径
      const safeName = (f.filename || "upload.bin").replace(/[\/\\]/g, "_").substring(0, 200);
      const dst = join(uploadsDir, safeName);
      await fs.writeFile(dst, f.data);
      saved.push({
        filename: safeName,
        rel_path: `uploads/${safeName}`,
        size: f.data.length,
        content_type: f.contentType,
      });
    }
    return jsonRes(res, { ok: true, files: saved });
  } catch (err) {
    return jsonRes(res, { error: `upload failed: ${err.message}` }, 500);
  }
}

// ─────────── P0-4 Mac 录屏流程 ───────────
async function handleMacScript({ project, projectId, logsDir, res, phase, script, cmd, args }) {
  if (isPhaseRunning(projectId, phase)) {
    return jsonRes(res, { error: `${phase} already running` }, 409);
  }
  const scriptPath = join(SKILL_SCRIPTS_PATH, script);
  if (!existsSync(scriptPath)) {
    return jsonRes(res, { error: `${script} not found` }, 500);
  }
  const send = startSSE({ req: null }, res);
  try {
    const { promise } = await runSkill({
      projectId, phase, cmd, args: [scriptPath, ...args],
      cwd: project.workspace_path, logsDir, createRunFn: createRun,
      onSSE: (event, data) => send(event, data),
    });
    await promise;
  } catch (err) {
    send("error", { message: err.message });
  }
  send("end", { ts: Date.now() });
  res.end();
}

async function handleMacProcess({ project, projectId, logsDir, res, movRel, trimStart, cropSpec }) {
  if (isPhaseRunning(projectId, "mac-process")) {
    return jsonRes(res, { error: "mac process already running" }, 409);
  }
  const scriptPath = join(SKILL_SCRIPTS_PATH, "process-mac-recording.sh");
  if (!existsSync(scriptPath)) {
    return jsonRes(res, { error: "process-mac-recording.sh not found" }, 500);
  }
  const movAbs = join(project.workspace_path, movRel);
  if (!existsSync(movAbs)) {
    return jsonRes(res, { error: `mov not found: ${movRel}` }, 400);
  }
  // 算下一个 final 版本号
  const nextVer = nextVersionNumber(projectId, "final");
  // process-mac-recording.sh 默认输出到 recordings-mac/final.mp4
  // 我们 wrap 一下：跑完后把 final.mp4 重命名为 final-v{N}.mp4 并登记

  const args = [scriptPath, movAbs, trimStart];
  if (cropSpec) args.push(cropSpec);

  const send = startSSE({ req: null }, res);
  send("log", { level: "info", line: `▶ Mac process: mov=${movRel} trim=${trimStart}s crop=${cropSpec || "(auto)"}` });

  try {
    const { promise } = await runSkill({
      projectId, phase: "mac-process", cmd: "bash", args,
      cwd: project.workspace_path, logsDir, createRunFn: createRun,
      onSSE: (event, data) => send(event, data),
      onComplete: async ({ exitCode }) => {
        if (exitCode === 0) {
          // 把 recordings-mac/final.mp4 → final-v{N}.mp4 并登记
          const src = join(project.workspace_path, "recordings-mac", "final.mp4");
          if (existsSync(src)) {
            const fs = await import("fs/promises");
            const dstRel = `recordings-mac/final-v${nextVer}.mp4`;
            const dstAbs = join(project.workspace_path, dstRel);
            await fs.rename(src, dstAbs);
            const size = statSync(dstAbs).size;
            addVersion({
              projectId, artifactType: "final", version: nextVer,
              fileRelPath: dstRel,
              metadataJson: JSON.stringify({ size, source: "process-mac-recording.sh", trim_start: trimStart, crop: cropSpec }),
              setCurrent: true,
            });
            send("artifact_added", { type: "final", version: nextVer, path: dstRel, size });
          }
        }
      },
    });
    await promise;
  } catch (err) {
    send("error", { message: err.message });
  }
  send("end", { ts: Date.now() });
  res.end();
}

// ─────────── P0-5 发布：封面 + 多平台文案 ───────────
async function handleGenCovers({ project, projectId, logsDir, res, body }) {
  if (isPhaseRunning(projectId, "gen-covers")) {
    return jsonRes(res, { error: "gen-covers already running" }, 409);
  }
  // gen-covers.py 不在 skill scripts，从同步过来的位置（已 cp 到 skill 目录）
  const scriptPath = join(SKILL_SCRIPTS_PATH, "gen-covers.py");
  if (!existsSync(scriptPath)) {
    return jsonRes(res, { error: "gen-covers.py not found in skill" }, 500);
  }
  const send = startSSE({ req: null }, res);
  try {
    const { promise } = await runSkill({
      projectId, phase: "gen-covers", cmd: "python3", args: [scriptPath],
      cwd: project.workspace_path, logsDir, createRunFn: createRun,
      onSSE: (event, data) => send(event, data),
      onComplete: async ({ exitCode }) => {
        if (exitCode === 0) {
          // 扫 covers/ 下新生成的 cover-*.png 入库
          const fs = await import("fs/promises");
          const coversDir = join(project.workspace_path, "covers");
          if (existsSync(coversDir)) {
            const list = (await fs.readdir(coversDir)).filter(f => f.startsWith("cover-") && f.endsWith(".png")).sort();
            let cv = 0;
            for (const f of list) {
              cv++;
              const abs = join(coversDir, f);
              const sz = statSync(abs).size;
              addVersion({
                projectId, artifactType: "cover", version: cv,
                fileRelPath: `covers/${f}`,
                metadataJson: JSON.stringify({ size: sz }),
                setCurrent: cv === 1,
              });
            }
            send("artifact_added", { type: "cover", count: list.length });
          }
        }
      },
    });
    await promise;
  } catch (err) {
    send("error", { message: err.message });
  }
  send("end", { ts: Date.now() });
  res.end();
}

async function handlePublishCopy({ project, projectId, res, body, streamClaude }) {
  // 读 brief + script 拼 prompt
  const fs = await import("fs/promises");
  const briefPath = join(project.workspace_path, "brief.json");
  const scriptMdPath = join(project.workspace_path, "script.md");
  const outlineMdPath = join(project.workspace_path, "outline.md");

  let brief = "{}", script = "", outline = "";
  if (existsSync(briefPath))     brief    = await fs.readFile(briefPath, "utf8");
  if (existsSync(scriptMdPath))  script   = await fs.readFile(scriptMdPath, "utf8");
  if (existsSync(outlineMdPath)) outline  = await fs.readFile(outlineMdPath, "utf8");

  const platforms = body.platforms || ["bilibili", "xiaohongshu", "douyin", "weixin-video", "youtube"];
  const prompt = `你是视频发布助手。给定项目信息，为每个平台生成发布文案。

### 项目 Brief
\`\`\`json
${brief}
\`\`\`

### 口播稿摘要
${script.substring(0, 3000)}

### 大纲
${outline.substring(0, 2000)}

### 任务
为下面 ${platforms.length} 个平台分别输出文案：${platforms.join("、")}

每个平台输出格式（用 markdown，平台之间用 \`---\` 分隔）：

## bilibili
**标题**：（≤ 60 字，含品牌词）
**简介**：（≤ 250 字，含关键词 SEO）
**标签**：tag1, tag2, tag3...（6-10 个）

## xiaohongshu
**标题**：（≤ 20 字，含 emoji，直接利益）
**正文**：（含 hashtag）

## douyin / weixin-video / youtube：同理按平台特性

注意：
- 标题不要太"AI 味"
- 用第二人称
- 钩子在前
- xiaohongshu 多 emoji，bilibili 偏正式，douyin 钩子最强`;

  const send = startSSE({ req: null }, res);
  send("log", { level: "info", line: "▶ 调 Claude 生成多平台文案..." });

  let fullText = "";
  try {
    await streamClaude({
      prompt,
      convId: `vf-publish-${projectId}`,
      onEvent: (type, data) => {
        if (type === "delta" && data?.text) {
          fullText += data.text;
          send("log", { level: "info", line: `+ ${data.text.substring(0, 200)}` });
        } else if (type === "error") {
          send("error", { message: data?.message || "claude error" });
        }
      },
    });

    // 写文件
    const publishDir = join(project.workspace_path, "publish");
    if (!existsSync(publishDir)) (await import("fs")).mkdirSync(publishDir, { recursive: true });
    const outPath = join(publishDir, `copy.md`);
    await fs.writeFile(outPath, fullText);
    send("log", { level: "info", line: `✓ 写入 publish/copy.md (${fullText.length} 字)` });

    // 登记版本
    const ver = nextVersionNumber(projectId, "publish-copy");
    addVersion({
      projectId, artifactType: "publish-copy", version: ver,
      fileRelPath: "publish/copy.md",
      metadataJson: JSON.stringify({ size: fullText.length, platforms }),
      setCurrent: true,
    });
    send("artifact_added", { type: "publish-copy", version: ver });
  } catch (err) {
    send("error", { message: err.message });
  }
  send("end", { ts: Date.now() });
  res.end();
}

// ─────────── P0-2 Content 一键生成 ───────────
async function handleContentGenerate({ project, projectId, res, streamClaude }) {
  const fs = await import("fs/promises");
  const briefPath = join(project.workspace_path, "brief.json");
  if (!existsSync(briefPath)) {
    return jsonRes(res, { error: "brief.json not found; fill Brief tab first" }, 400);
  }
  const brief = await fs.readFile(briefPath, "utf8");

  const prompt = `你是 video-factory skill 的内容产出助手。

### 项目 Brief
\`\`\`json
${brief}
\`\`\`

### 任务
基于 brief，一次产出 4 个文件。输出严格按下面 4 段，**每段都要有清晰的开始/结束标记**（### FILE: <name>）：

### FILE: article.md
（保留 100% 信息密度的书面版原素材，~ 600-1500 字）

### FILE: script.md
（B 站风口播稿。短句 ≤ 20 字、第二人称、信息保留度 ≥ 60%、开头 3 秒钩子。按"节拍"切，每个节拍 ≤ 30 字。整篇按 brief 的 duration_target_s 估算，4 字/秒。）

### FILE: outline.md
（章节切分。5 章左右：钩子 / 核心定位 / 价值场景 / 上手 / 进阶 CTA。每章列出 step 数和信息池。）

### FILE: audio-segments.json
（JSON 数组，每个 step 一行。schema：[{"chapter":"hook","step":1,"text":"...","audio":"hook/1.mp3"}, ...]
按 outline 的章节展开成 25-35 个 step，每个 text ≤ 30 字。chapter 用：hook / use-cases / examples / install / closing。）

### TTS 改写规则（audio-segments.json 必须遵守）
- 百分号 → "百分之 N"
- 阿拉伯数字 → 汉字
- "/init" → "斜杠 init"
- 破折号"——" → 句号 + 短句
- 单句 ≤ 25 字`;

  const send = startSSE({ req: null }, res);
  send("log", { level: "info", line: "▶ 调 Claude 生成 article / script / outline / audio-segments..." });

  let fullText = "";
  try {
    await streamClaude({
      prompt,
      convId: `vf-content-${projectId}`,
      onEvent: (type, data) => {
        if (type === "delta" && data?.text) {
          fullText += data.text;
          if (data.text.length < 400) send("log", { level: "info", line: data.text.trim() });
        } else if (type === "error") {
          send("error", { message: data?.message || "claude error" });
        }
      },
    });

    // 解析 ### FILE: 块
    const files = {};
    const re = /^###\s+FILE:\s*([\w.-]+)\s*$/m;
    let m;
    const parts = fullText.split(/^###\s+FILE:\s*([\w.-]+)\s*$/m);
    // 形式: [前文, fname1, content1, fname2, content2, ...]
    for (let i = 1; i < parts.length; i += 2) {
      files[parts[i].trim()] = parts[i + 1] ? parts[i + 1].trim() : "";
    }

    if (!Object.keys(files).length) {
      send("error", { message: "Claude 输出没有可识别的 ### FILE: 块，请重试或手工调整 prompt" });
      send("end", { ts: Date.now() }); return res.end();
    }

    const written = [];
    for (const [fname, content] of Object.entries(files)) {
      let body = content;
      // audio-segments.json 提取 ```json ... ``` 代码块（如果有）
      if (fname.endsWith(".json")) {
        const cm = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (cm) body = cm[1].trim();
      }
      const dst = join(project.workspace_path, fname);
      await fs.writeFile(dst, body);
      const sz = statSync(dst).size;
      send("log", { level: "info", line: `✓ ${fname} (${sz} bytes)` });

      // 登记版本（不同类型分开）
      const type = fname.replace(/\.\w+$/, "").replace(/-v\d+$/, "");
      const ver = nextVersionNumber(projectId, type);
      addVersion({
        projectId, artifactType: type, version: ver,
        fileRelPath: fname,
        metadataJson: JSON.stringify({ size: sz, source: "claude-content-generate" }),
        setCurrent: true,
      });
      written.push({ file: fname, version: ver });
    }

    send("artifact_added", { type: "content", written });
    send("log", { level: "info", line: `✓ 全部完成 · 写入 ${written.length} 个文件` });
  } catch (err) {
    send("error", { message: err.message });
  }
  send("end", { ts: Date.now() });
  res.end();
}

// ─────────── P0-3 视觉模板 scaffold ───────────
async function handleScaffold({ project, projectId, body, res }) {
  const fs = await import("fs/promises");
  // 母板：opendaemon/data/video/claude-code-guide-v9-mac.html
  // 替换 token: {{TITLE}} {{ACCENT}} 等
  const templatePath = join(
    "/root/workspace/projects/opendaemon/data/video",
    "claude-code-guide-v9-mac.html"
  );
  if (!existsSync(templatePath)) {
    return jsonRes(res, { error: "scaffold template not found" }, 500);
  }
  const template = await fs.readFile(templatePath, "utf8");

  const title = body.title || project.title || "Untitled Video";
  const accent = body.accent || "#D97757"; // 默认珊瑚橙
  const mintAccent = body.mint || "#4ADE80";

  // 简单 token 替换（不动 scenes / 动画结构，只换标题和主色）
  let scaffolded = template
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace(/--coral:#D97757;/g, `--coral:${accent};`)
    .replace(/--mint:#4ADE80;/g, `--mint:${mintAccent};`);

  // 写到项目 public/index.html
  const publicDir = join(project.workspace_path, "public");
  if (!existsSync(publicDir)) (await import("fs")).mkdirSync(publicDir, { recursive: true });
  const dst = join(publicDir, "index.html");
  await fs.writeFile(dst, scaffolded);
  const sz = statSync(dst).size;

  // 登记版本
  const ver = nextVersionNumber(projectId, "html");
  addVersion({
    projectId, artifactType: "html", version: ver,
    fileRelPath: "public/index.html",
    metadataJson: JSON.stringify({ size: sz, source: "scaffold-from-v9-mac", title, accent }),
    setCurrent: true,
  });

  return jsonRes(res, {
    ok: true,
    file: "public/index.html",
    version: ver,
    size: sz,
    preview_url: `/api/vf/projects/${projectId}/files/public/index.html`,
    note: "已基于 v9-mac.html 套娃 · 改了 title 和主色 · scenes / audio 路径 / 动画都保留，需手工补对应项目的 mp3 才能跑",
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  })[m]);
}

async function handleRecording({ project, projectId, logsDir, res }) {
  if (isPhaseRunning(projectId, "recording")) {
    return jsonRes(res, { error: "recording already running", active_run: getActiveRunId(projectId, "recording") }, 409);
  }
  const scriptPath = join(SKILL_SCRIPTS_PATH, "record-video-paged.py");
  if (!existsSync(scriptPath)) {
    return jsonRes(res, { error: `record-video-paged.py not found at ${scriptPath}` }, 500);
  }
  const send = startSSE({ req: null }, res);
  send("log", { level: "info", line: `▶ 启动 Playwright 录制（30-40 min）...` });
  try {
    const { promise } = await runSkill({
      projectId, phase: "recording", cmd: "python3", args: [scriptPath],
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

async function handleEncode({ project, projectId, body, logsDir, res }) {
  if (isPhaseRunning(projectId, "encode")) {
    return jsonRes(res, { error: "encode already running" }, 409);
  }
  const scriptPath = join(SKILL_SCRIPTS_PATH, "encode-mp4.sh");
  if (!existsSync(scriptPath)) {
    return jsonRes(res, { error: `encode-mp4.sh not found` }, 500);
  }

  // 默认输入 = recordings-paged/*.webm 拼接成片
  const inputRel = body.input || "recordings-paged/claude-code-guide-paged.webm";
  // 输出文件命名：final-v{next}.mp4
  const nextVer = nextVersionNumber(projectId, "final");
  const outputRel = body.output || `final-v${nextVer}.mp4`;

  const inputAbs = join(project.workspace_path, inputRel);
  if (!existsSync(inputAbs)) {
    return jsonRes(res, { error: `input not found: ${inputAbs}` }, 400);
  }

  const send = startSSE({ req: null }, res);
  send("log", { level: "info", line: `▶ 编码 ${inputRel} → ${outputRel} (libx264 medium CRF 20)` });

  try {
    const { promise } = await runSkill({
      projectId, phase: "encode", cmd: "bash",
      args: [scriptPath, inputRel, outputRel],
      cwd: project.workspace_path,
      logsDir,
      createRunFn: createRun,
      onSSE: (event, data) => send(event, data),
      onComplete: ({ exitCode }) => {
        if (exitCode === 0) {
          // 编码成功 → 自动登记新版本
          const outputAbs = join(project.workspace_path, outputRel);
          if (existsSync(outputAbs)) {
            const size = statSync(outputAbs).size;
            addVersion({
              projectId,
              artifactType: "final",
              version: nextVer,
              fileRelPath: outputRel,
              metadataJson: JSON.stringify({ size, source: "encode-mp4.sh" }),
              setCurrent: true,
            });
            send("artifact_added", { type: "final", version: nextVer, path: outputRel, size });
          }
        }
      },
    });
    await promise;
  } catch (err) {
    send("error", { message: err.message });
  }
  send("end", { ts: Date.now() });
  res.end();
}

async function handleBuildTiming({ project, projectId, logsDir, res }) {
  if (isPhaseRunning(projectId, "build-timing")) {
    return jsonRes(res, { error: "build-timing already running" }, 409);
  }
  const scriptPath = join(SKILL_SCRIPTS_PATH, "build-timing.py");
  if (!existsSync(scriptPath)) {
    return jsonRes(res, { error: `build-timing.py not found` }, 500);
  }
  const send = startSSE({ req: null }, res);
  try {
    const { promise } = await runSkill({
      projectId, phase: "build-timing", cmd: "python3", args: [scriptPath],
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
