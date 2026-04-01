import { gzipSync } from "zlib";
import http from "http";
import https from "https";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join, basename } from "path";
import { readFileSync, existsSync, statSync, readdirSync, mkdirSync, writeFileSync } from "fs";
import { execSync, exec } from "child_process";
import { homedir } from "os";

import { loadConfig, getEngineById, getEngines, getEngineFullConfig, saveEngines, mergeEngineUpdate, needsSetup, createInitialConfig } from "./lib/config.mjs";
import { initDb, createConversation, listConversations, getConversation, deleteConversation, addMessage, updateMessageContent, getMessages, updateConversationSdkSession } from "./lib/db.mjs";
import { createAuth } from "./lib/auth.mjs";
import { streamOpenAI } from "./lib/engine-openai.mjs";
import { BUILTIN_TOOL_DEFINITIONS, BUILTIN_TOOL_NAMES, executeBuiltinTool } from "./lib/builtin-tools.mjs";
import { MCPManager } from "./lib/mcp-manager.mjs";
import { registerEngine, getEngineHandler, getRegisteredEngines } from "./lib/engine-registry.mjs";
import { loadPlugins } from "./lib/plugin-loader.mjs";
import { addTrace, updateTraceFeedback, getTraces, getTraceStats } from "./lib/trace.mjs";
import { initUploads, saveAttachment, getAttachment, getAttachmentBuffer, linkAttachmentsToMessage, deleteAttachmentFiles, getAttachmentsForMessages, buildClaudeContent, buildOpenAIContent, MAX_FILES_PER_REQUEST } from "./lib/attachments.mjs";
import { parseMultipart } from "./lib/multipart.mjs";
import { initKnowledge, listKnowledge, getKnowledgeContent, updateKnowledge, deleteKnowledge, syncWorkspaceKnowledge, rebuildFtsIndex } from "./lib/knowledge.mjs";
import { buildInjectedContext } from "./lib/injector.mjs";
import { loadGoals, saveGoals, prepareReflection, processReflectionResult, getPendingInsights, acceptPendingInsight, rejectPendingInsight, getReflectionHistory } from "./lib/reflect.mjs";
import { initEvolution, onChatComplete, onFeedback, getEvolutionState, getEvolutionLog, getEvolutionStats } from "./lib/evolution.mjs";
import { shouldDispatch, dispatch, getOrchestratorConfig, AGENT_TYPES } from "./lib/orchestrator.mjs";
import { listSubAgentRuns, getEvaluations, getEvaluationStats, listExperiments as dbListExperiments } from "./lib/db.mjs";
import { createExperiment, assignVariant, recordFeedback as abRecordFeedback, listExperiments, cancelExperiment, decideWinner } from "./lib/ab-testing.mjs";
import { listSelfCodedTools, getToolDetail, validateTool, installTool, disableTool, enableTool } from "./lib/self-coder.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".py": "text/x-python; charset=utf-8",
  ".sh": "text/x-shellscript; charset=utf-8",
};

// ── Version check ──
const PKG_VERSION = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8")).version;
let _versionCache = { latest: null, checkedAt: 0 };
const VERSION_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function checkLatestVersion() {
  const now = Date.now();
  if (_versionCache.latest && (now - _versionCache.checkedAt) < VERSION_CACHE_TTL) {
    return _versionCache.latest;
  }
  try {
    const resp = await fetch(
      "https://raw.githubusercontent.com/setonlin007/opendaemon/main/package.json",
      { headers: { "User-Agent": "OpenDaemon" }, signal: AbortSignal.timeout(5000) }
    );
    if (!resp.ok) return _versionCache.latest || null;
    const remote = await resp.json();
    _versionCache = { latest: remote.version, checkedAt: now };
    return remote.version;
  } catch {
    return _versionCache.latest || null;
  }
}

// ── Initialize ──
const SERVER_BOOT = Date.now();
const config = loadConfig();
const PORT = process.env.PORT || config.server?.port || 3456;
const HOST = process.env.HOST || config.server?.host || "127.0.0.1";
initDb();
initUploads();
initKnowledge();
syncWorkspaceKnowledge();
rebuildFtsIndex();  // P1: rebuild FTS5 index on startup
initEvolution(config.evolution || {});
const auth = createAuth(config.auth.password);

// ── MCP Manager (long-running Python subprocess) ──
let mcpManager = null;

async function initMCP() {
  const mcpConfig = config.mcp || {};
  // Find the first MCP server config (typically "opendaemon")
  const serverName = Object.keys(mcpConfig)[0];
  if (!serverName) {
    console.log("[init] no MCP servers configured");
    return;
  }
  const serverConfig = mcpConfig[serverName];
  const channelsConfig = serverConfig.channels || {};
  // Generate internal auth token for MCP → OpenDaemon API calls
  const internalToken = auth.createInternalToken();
  serverConfig.env = {
    ...(serverConfig.env || {}),
    OPENDAEMON_AUTH_TOKEN: internalToken,
    OPENDAEMON_BASE_URL: `http://127.0.0.1:${PORT}`,
  };
  mcpManager = new MCPManager(serverConfig, channelsConfig);
  await mcpManager.start();
}

// Clean up any streaming markers left by interrupted sessions
try {
  const { getDb } = await import("./lib/db.mjs");
  const cleaned = getDb()
    .prepare("UPDATE messages SET content = REPLACE(content, '\n\n<!-- streaming -->', '') WHERE content LIKE '%<!-- streaming -->%'")
    .run();
  if (cleaned.changes > 0) console.log(`[init] cleaned ${cleaned.changes} interrupted streaming message(s)`);
} catch {}

// ── Register built-in openai engine + load plugins ──
registerEngine({
  metadata: { type: "openai", name: "OpenAI-Compatible", description: "Any OpenAI-compatible API", category: "api" },
  handleChat: (...args) => handleOpenAIChat(...args),
  streamSimple: async ({ prompt, engineConfig, onEvent, abortSignal }) => {
    const messages = [{ role: "user", content: prompt }];
    await streamOpenAI({ messages, engineConfig, onEvent, abortSignal });
  },
  test: async (engine) => {
    const { baseUrl, apiKey, model } = engine.provider;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Say hi" }], max_tokens: 10 }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "unknown");
        return { ok: false, error: `HTTP ${resp.status}: ${errText.substring(0, 200)}` };
      }
      return { ok: true };
    } catch (err) {
      clearTimeout(timeout);
      return { ok: false, error: err.name === "AbortError" ? "Connection timeout (15s)" : err.message };
    }
  },
});
await loadPlugins();

// Dependencies injected into plugin handleChat calls
const serverDeps = {
  addMessage,
  updateMessageContent,
  updateConversationSdkSession,
  getMessages,
  getAttachmentsForMessages,
  buildClaudeContent,
  buildOpenAIContent,
  buildMCPTools: () => buildMCPTools(),
  BUILTIN_TOOL_DEFINITIONS,
  BUILTIN_TOOL_NAMES,
  executeBuiltinTool,
  config,
};

console.log(`[init] ${config.engines.length} engines configured, listening on ${HOST}:${PORT}`);

// ── Helpers ──

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  try { return JSON.parse(body); } catch { return null; }
}

function json(res, data, status = 200, req = null) {
  const body = JSON.stringify(data);
  const ae = req?.headers?.["accept-encoding"] || "";
  if (ae.includes("gzip") && body.length > 1024) {
    res.writeHead(status, { "Content-Type": "application/json", "Content-Encoding": "gzip" });
    res.end(gzipSync(Buffer.from(body)));
  } else {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
  }
}

function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function extractPath(url) {
  return url.split("?")[0];
}

function extractParam(url, prefix) {
  // Extract :id from /api/conversations/:id/...
  const path = extractPath(url);
  const after = path.substring(prefix.length);
  const parts = after.split("/").filter(Boolean);
  return parts[0] || null;
}

// ── Server ──

const server = http.createServer(async (req, res) => {
  const path = extractPath(req.url);
  const method = req.method;

  // ── Setup mode: redirect to wizard if not configured ──
  if (needsSetup()) {
    if (path === "/setup.html" || path === "/api/setup") {
      // Allow setup page and API through
    } else if (path.startsWith("/api/")) {
      json(res, { error: "not configured", setup: true }, 503);
      return;
    } else if (path !== "/vendor/highlight.min.css" && path !== "/vendor/highlight.min.js" && path !== "/vendor/marked.min.js") {
      res.writeHead(302, { Location: "/setup.html" });
      res.end();
      return;
    }
  }

  // Setup API (no auth required)
  if (method === "POST" && path === "/api/setup") {
    const body = await readBody(req);
    if (!body?.password || body.password.length < 4) {
      json(res, { error: "Password must be at least 4 characters" }, 400);
      return;
    }
    try {
      const engines = [];
      if (body.engine_type === "claude-sdk") {
        engines.push({ id: "claude", type: "claude-sdk", label: "Claude", icon: "C" });
      }
      if (body.engine_type === "openai" && body.api_key && body.base_url) {
        engines.push({
          id: body.engine_id || "llm",
          type: "openai",
          label: body.engine_label || "LLM",
          icon: body.engine_icon || "A",
          provider: {
            baseUrl: body.base_url,
            apiKey: body.api_key,
            model: body.model || "",
          },
        });
      }
      if (body.engine_type === "both" || (!body.engine_type && body.api_key)) {
        engines.push({ id: "claude", type: "claude-sdk", label: "Claude", icon: "C" });
        if (body.api_key && body.base_url) {
          engines.push({
            id: body.engine_id || "llm",
            type: "openai",
            label: body.engine_label || "LLM",
            icon: body.engine_icon || "A",
            provider: { baseUrl: body.base_url, apiKey: body.api_key, model: body.model || "" },
          });
        }
      }
      if (engines.length === 0) {
        engines.push({ id: "claude", type: "claude-sdk", label: "Claude", icon: "C" });
      }
      createInitialConfig({ password: body.password, engines });
      // Reinitialize auth with new password
      Object.assign(auth, createAuth(body.password));
      // Initialize workspace if not exists
      try {
        const wsDir = join(homedir(), "workspace");
        if (!existsSync(wsDir)) {
          mkdirSync(join(wsDir, "projects"), { recursive: true });
          mkdirSync(join(wsDir, "artifacts"), { recursive: true });
          const projName = basename(__dirname);
          writeFileSync(join(wsDir, ".workspace.json"), JSON.stringify({
            version: 1,
            projects: { [projName]: { path: `projects/${projName}`, type: "node", description: "OpenDaemon agent platform" } },
            artifacts_path: "artifacts"
          }, null, 2));
          console.log("[setup] Workspace initialized at", wsDir);
        }
        syncWorkspaceKnowledge();
      } catch (wsErr) { console.error("[setup] Workspace init error:", wsErr.message); }
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  // ── Access Link (auto-login via temporary token, before auth check) ──

  if (method === "GET" && path === "/access") {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const accessToken = urlObj.searchParams.get("token");
      if (!accessToken) {
        res.writeHead(302, { Location: "/login.html" });
        res.end();
        return;
      }
      const sessionToken = auth.consumeAccessLink(accessToken, req);
      if (!sessionToken) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>链接已失效</title>
          <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0;}
          .box{text-align:center;padding:2rem;border-radius:12px;background:#1a1a1a;border:1px solid #333;}
          h2{margin:0 0 .5rem;color:#ff6b6b;}p{color:#999;margin:0;}a{color:#64b5f6;}</style></head>
          <body><div class="box"><h2>链接已失效</h2><p>该访问链接已过期或已使用。</p><p style="margin-top:1rem"><a href="/login.html">前往登录页</a></p></div></body></html>`);
        return;
      }
      // Set session cookie and redirect to main page
      const isSecure = req.headers["x-forwarded-proto"] === "https" || req.connection?.encrypted;
      const securePart = isSecure ? " Secure;" : "";
      res.writeHead(302, {
        "Set-Cookie": `od_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax;${securePart} Max-Age=${30 * 24 * 60 * 60}`,
        Location: "/",
      });
      res.end();
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  // Auth check (returns false and sends response if not authed)
  if (!needsSetup() && !auth.requireAuth(req, res)) return;

  // ── Auth routes ──

  if (method === "POST" && path === "/api/login") {
    const body = await readBody(req);
    auth.handleLogin(req, res, body);
    return;
  }

  if (method === "GET" && path === "/api/logout") {
    auth.handleLogout(req, res);
    return;
  }

  // ── Engine routes ──
  // ── Ping (lightweight health check, ~50 bytes) ──

  if (method === "GET" && path === "/api/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, boot: SERVER_BOOT }));
    return;
  }

  // ── Version check ──
  if (method === "GET" && path === "/api/version") {
    try {
      const latest = await checkLatestVersion();
      json(res, { current: PKG_VERSION, latest, updateAvailable: latest ? latest !== PKG_VERSION : false }, 200, req);
    } catch (err) {
      json(res, { current: PKG_VERSION, latest: null, updateAvailable: false }, 200, req);
    }
    return;
  }

  // ── One-click update ──
  if (method === "POST" && path === "/api/update") {
    try {
      const prevCommit = execSync("git rev-parse --short HEAD", { cwd: __dirname, encoding: "utf-8" }).trim();
      const pullResult = execSync("git pull origin main 2>&1", { cwd: __dirname, encoding: "utf-8", timeout: 30000 });
      const newCommit = execSync("git rev-parse --short HEAD", { cwd: __dirname, encoding: "utf-8" }).trim();
      // Syntax check before restart
      execSync("node --check server.mjs", { cwd: __dirname, encoding: "utf-8" });
      // Send response before restart
      json(res, { ok: true, prevCommit, newCommit, pullResult: pullResult.trim(), message: "Update pulled. Restarting in 5 seconds..." });
      // Delayed restart in background
      const updateCmd = `sleep 5 && cd ${__dirname} && npm install --omit=dev 2>&1 && (cd mcp && [ -d .venv ] && .venv/bin/pip install -r requirements.txt 2>&1 || true) && pm2 restart opendaemon --update-env 2>&1`;
      const child = exec(updateCmd, { cwd: __dirname, detached: true, stdio: "ignore" });
      child.unref();
      _versionCache = { latest: null, checkedAt: 0 };
    } catch (err) {
      json(res, { ok: false, error: err.message }, 500);
    }
    return;
  }

  // ── Tunnel URL ──

  if (method === "GET" && path === "/api/tunnel") {
    try {
      const { getTunnelUrl } = await import("./lib/tunnel.mjs");
      json(res, { url: getTunnelUrl() });
    } catch {
      json(res, { url: null });
    }
    return;
  }

  if (method === "POST" && path === "/api/tunnel") {
    try {
      const tunnel = await import("./lib/tunnel.mjs");
      let url = tunnel.getTunnelUrl();
      if (!url) {
        url = await tunnel.startTunnel(PORT);
      }
      json(res, { ok: true, url });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  if (method === "DELETE" && path === "/api/tunnel") {
    try {
      const tunnel = await import("./lib/tunnel.mjs");
      tunnel.stopTunnel();
      // Also revoke all access links since they depend on tunnel
      const links = auth.listAccessLinks();
      for (const link of links) {
        auth.revokeAccessLink(link.tokenFull);
      }
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  // ── Access Link Management ──

  if (method === "POST" && path === "/api/access-link") {
    try {
      const body = await readBody(req);
      const expiresIn = Math.min(Math.max(body?.expiresIn || 24, 0.5), 720); // 0.5h ~ 30 days
      const maxUses = Math.min(Math.max(body?.maxUses ?? 1, 0), 100); // 0=unlimited, max 100
      const label = (body?.label || "").slice(0, 100);

      const { token, expires } = auth.createAccessLink({ expiresIn, maxUses, label });

      // Auto-start tunnel if not already running
      let tunnelUrl = null;
      try {
        const tunnel = await import("./lib/tunnel.mjs");
        tunnelUrl = tunnel.getTunnelUrl();
        if (!tunnelUrl) {
          tunnelUrl = await tunnel.startTunnel(PORT);
        }
      } catch (err) {
        console.error("[access-link] tunnel error:", err.message);
      }

      // Build the access URL
      const baseUrl = tunnelUrl || `http://${req.headers.host}`;
      const accessUrl = `${baseUrl}/access?token=${token}`;

      json(res, {
        ok: true,
        accessUrl,
        tunnelUrl,
        token,
        expires,
        expiresIn,
        maxUses,
      });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  if (method === "GET" && path === "/api/access-links") {
    try {
      json(res, { links: auth.listAccessLinks() });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  if (method === "DELETE" && path.startsWith("/api/access-links/")) {
    try {
      const token = extractParam(req.url, "/api/access-links/");
      if (!token) {
        json(res, { error: "token required" }, 400);
        return;
      }
      const deleted = auth.revokeAccessLink(token);
      json(res, { ok: true, deleted });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  // ── Init (combined endpoint to reduce round-trips) ──

  if (method === "GET" && path === "/api/init") {
    const convs = listConversations();
    const latestConvId = convs[0]?.id;
    const latestMessages = latestConvId ? getMessages(latestConvId) : [];
    json(res, {
      engines: getEngines(),
      conversations: convs,
      latestMessages,
      server_boot: SERVER_BOOT,
    }, 200, req);
    return;
  }


  if (method === "GET" && path === "/api/engines") {
    json(res, { engines: getEngines(), server_boot: SERVER_BOOT });
    return;
  }

  // GET /api/engine-types — registered engine types (from plugins + built-in)
  if (method === "GET" && path === "/api/engine-types") {
    json(res, { types: getRegisteredEngines() });
    return;
  }

  // GET /api/engines/:id — single engine detail (masked)
  if (method === "GET" && path.match(/^\/api\/engines\/[^/]+$/) && !path.endsWith("/test")) {
    const engineId = decodeURIComponent(path.split("/api/engines/")[1]);
    const engineConfig = getEngineFullConfig(engineId);
    if (!engineConfig) { json(res, { error: "Engine not found" }, 404); return; }
    json(res, engineConfig);
    return;
  }

  // POST /api/engines — add new engine
  if (method === "POST" && path === "/api/engines") {
    try {
      const body = await readBody(req);
      if (!body?.id || !body?.type || !body?.label) {
        json(res, { error: "id, type, and label are required" }, 400); return;
      }
      const current = loadConfig().engines;
      if (current.find((e) => e.id === body.id)) {
        json(res, { error: `Engine "${body.id}" already exists` }, 409); return;
      }
      const newEngine = { id: body.id, type: body.type, label: body.label };
      if (body.icon) newEngine.icon = body.icon;
      if (body.model) newEngine.model = body.model;
      if (body.provider) newEngine.provider = body.provider;
      if (body.options) newEngine.options = body.options;
      saveEngines([...current, newEngine]);
      json(res, { ok: true, engines: getEngines() });
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
    return;
  }

  // PUT /api/engines/:id — update engine
  if (method === "PUT" && path.match(/^\/api\/engines\/[^/]+$/) && !path.endsWith("/test")) {
    try {
      const engineId = decodeURIComponent(path.split("/api/engines/")[1]);
      const current = loadConfig().engines;
      const existing = current.find((e) => e.id === engineId);
      if (!existing) { json(res, { error: "Engine not found" }, 404); return; }
      const body = await readBody(req);
      const merged = mergeEngineUpdate(existing, body);
      const updated = current.map((e) => e.id === engineId ? merged : e);
      saveEngines(updated);
      json(res, { ok: true, engines: getEngines() });
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
    return;
  }

  // DELETE /api/engines/:id — delete engine
  if (method === "DELETE" && path.match(/^\/api\/engines\/[^/]+$/)) {
    try {
      const engineId = decodeURIComponent(path.split("/api/engines/")[1]);
      const current = loadConfig().engines;
      if (!current.find((e) => e.id === engineId)) {
        json(res, { error: "Engine not found" }, 404); return;
      }
      const filtered = current.filter((e) => e.id !== engineId);
      if (filtered.length === 0) {
        json(res, { error: "Cannot delete the last engine" }, 400); return;
      }
      saveEngines(filtered);
      json(res, { ok: true, engines: getEngines() });
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
    return;
  }

  // POST /api/engines/:id/test — connection test
  if (method === "POST" && path.match(/^\/api\/engines\/[^/]+\/test$/)) {
    const engineId = decodeURIComponent(path.split("/api/engines/")[1].replace("/test", ""));
    const engine = getEngineById(engineId);
    if (!engine) { json(res, { error: "Engine not found" }, 404); return; }

    const start = Date.now();
    try {
      const testHandler = getEngineHandler(engine.type);
      if (testHandler?.test) {
        const result = await testHandler.test(engine);
        json(res, { ...result, latency_ms: result.latency_ms ?? (Date.now() - start) });
      } else {
        json(res, { ok: false, error: `No test available for engine type: ${engine.type}` });
      }
    } catch (err) {
      json(res, { ok: false, error: err.name === "AbortError" ? "Connection timeout (15s)" : err.message, latency_ms: Date.now() - start });
    }
    return;
  }

  if (method === "GET" && path === "/api/commands") {
    try {
      // Get commands from any plugin that provides them (e.g. Claude SDK)
      const claudeHandler = getEngineHandler("claude-sdk");
      const data = claudeHandler?.getCommands ? await claudeHandler.getCommands() : { commands: [] };
      json(res, data);
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  // ── Conversation routes ──

  if (method === "GET" && path === "/api/conversations") {
    json(res, listConversations(), 200, req);
    return;
  }

  if (method === "POST" && path === "/api/conversations") {
    const body = await readBody(req);
    if (!body?.engine_id) { json(res, { error: "engine_id required" }, 400); return; }
    const engine = getEngineById(body.engine_id);
    if (!engine) { json(res, { error: "unknown engine" }, 400); return; }
    json(res, createConversation(body.engine_id));
    return;
  }

  if (method === "PATCH" && path.startsWith("/api/conversations/")) {
    try {
      const id = extractParam(req.url, "/api/conversations/");
      if (!id) { json(res, { error: "id required" }, 400); return; }
      const body = await readBody(req);
      if (body.title) {
        db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(body.title, id);
      }
      if (body.engine_id) {
        const engine = getEngineById(body.engine_id);
        if (!engine) { json(res, { error: "unknown engine" }, 400); return; }
        db.prepare("UPDATE conversations SET engine_id = ? WHERE id = ?").run(body.engine_id, id);
      }
      json(res, { ok: true });
    } catch (err) { json(res, { error: err.message }, 500); }
    return;
  }

  if (method === "DELETE" && path.startsWith("/api/conversations/")) {
    const id = extractParam(req.url, "/api/conversations/");
    if (!id) { json(res, { error: "id required" }, 400); return; }
    // Clean up attachment files before DB cascade delete
    try { deleteAttachmentFiles(id); } catch {}
    deleteConversation(id);
    json(res, { ok: true });
    return;
  }

  if (method === "GET" && path.match(/^\/api\/conversations\/[^/]+\/messages$/)) {
    const id = extractParam(req.url, "/api/conversations/");
    if (!id) { json(res, { error: "id required" }, 400); return; }
    const msgs = getMessages(id);
    // Enrich messages with attachment metadata
    const msgIds = msgs.map((m) => m.id);
    const attMap = getAttachmentsForMessages(msgIds);
    const enriched = msgs.map((m) => {
      const atts = attMap.get(m.id);
      return atts ? { ...m, attachments: atts } : m;
    });
    json(res, enriched);
    return;
  }

  // ── Feedback & Traces ──

  if (method === "POST" && path.match(/^\/api\/messages\/\d+\/feedback$/)) {
    const msgId = parseInt(path.split("/")[3]);
    const body = await readBody(req);
    if (!body?.feedback || !["up", "down"].includes(body.feedback)) {
      json(res, { error: "feedback must be 'up' or 'down'" }, 400);
      return;
    }
    const result = updateTraceFeedback(msgId, body.feedback, body.note || null);
    if (!result) { json(res, { error: "trace not found for this message" }, 404); return; }
    onFeedback(msgId, body.feedback);
    // A/B testing feedback tracking
    try { if (body.conv_id) abRecordFeedback(body.conv_id, body.feedback); } catch {}
    json(res, { ok: true });
    return;
  }

  if (method === "GET" && path === "/api/traces") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const since = url.searchParams.get("since") ? parseInt(url.searchParams.get("since")) : undefined;
    const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")) : 50;
    json(res, getTraces({ since, limit }));
    return;
  }

  if (method === "GET" && path === "/api/traces/stats") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const since = url.searchParams.get("since") ? parseInt(url.searchParams.get("since")) : null;
    json(res, getTraceStats(since));
    return;
  }

  // ── File Upload routes ──

  if (method === "POST" && path === "/api/upload") {
    try {
      const { fields, files } = await parseMultipart(req);
      console.log(`[upload] fields=${JSON.stringify(Object.keys(fields))} files=${files.length} filenames=${files.map(f => f.filename).join(',')}`);
      const convId = fields.conv_id;
      if (!convId) { json(res, { error: "conv_id required" }, 400); return; }
      const conv = getConversation(convId);
      if (!conv) { json(res, { error: "conversation not found" }, 404); return; }
      if (files.length === 0) { json(res, { error: "no files provided" }, 400); return; }
      if (files.length > MAX_FILES_PER_REQUEST) { json(res, { error: `max ${MAX_FILES_PER_REQUEST} files per request` }, 400); return; }

      const results = [];
      for (const file of files) {
        try {
          const att = saveAttachment(convId, file.filename, file.contentType, file.data);
          results.push(att);
        } catch (err) {
          results.push({ error: err.message, filename: file.filename });
        }
      }
      json(res, results);
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
    return;
  }

  if (method === "GET" && path.match(/^\/api\/uploads\/[^/]+$/)) {
    const id = path.split("/")[3];
    const att = getAttachment(id);
    if (!att) { res.writeHead(404); res.end("Not Found"); return; }
    const buffer = getAttachmentBuffer(id);
    if (!buffer) { res.writeHead(404); res.end("File not found on disk"); return; }
    const disposition = att.category === "image" ? "inline" : `attachment; filename="${att.filename}"`;
    res.writeHead(200, {
      "Content-Type": att.mime_type,
      "Content-Length": buffer.length,
      "Content-Disposition": disposition,
      "Cache-Control": "private, max-age=86400",
    });
    res.end(buffer);
    return;
  }

  // ── Serve files from data/ directory (for daemon-generated files) ──

  if (method === "GET" && path.startsWith("/api/files/")) {
    const relativePath = decodeURIComponent(path.substring("/api/files/".length));
    // Security: block path traversal
    if (relativePath.includes("..") || relativePath.startsWith("/")) {
      res.writeHead(403); res.end("Forbidden"); return;
    }
    const filePath = join(__dirname, "data", relativePath);
    if (!filePath.startsWith(join(__dirname, "data"))) {
      res.writeHead(403); res.end("Forbidden"); return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404); res.end("Not Found"); return;
    }
    const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase();
    const contentType = MIME[ext] || "application/octet-stream";
    const fileName = relativePath.split("/").pop();
    const previewable = [".png",".jpg",".jpeg",".gif",".webp",".svg",".txt",".md",".csv",".json",".pdf",".xml",".html",".htm"].includes(ext);
    const disposition = previewable ? `inline; filename="${fileName}"` : `attachment; filename="${fileName}"`;
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Disposition": disposition,
      "Content-Length": statSync(filePath).size,
    });
    res.end(readFileSync(filePath));
    return;
  }

  // ── Workspace: artifacts directory tree ──

  const WORKSPACE_ARTIFACTS = join(homedir(), "workspace", "artifacts");

  if (method === "GET" && path === "/api/workspace/tree") {
    try {
      const qIdx = req.url.indexOf("?");
      const params = qIdx >= 0 ? new URLSearchParams(req.url.substring(qIdx)) : new URLSearchParams();
      const relPath = params.get("path") || "";
      if (relPath.includes("..") || relPath.startsWith("/")) {
        res.writeHead(403); res.end("Forbidden"); return;
      }
      const absDir = join(WORKSPACE_ARTIFACTS, relPath);
      if (!absDir.startsWith(WORKSPACE_ARTIFACTS)) {
        res.writeHead(403); res.end("Forbidden"); return;
      }
      if (!existsSync(absDir) || !statSync(absDir).isDirectory()) {
        json(res, { path: relPath, items: [] });
        return;
      }
      const entries = readdirSync(absDir);
      const items = [];
      for (const name of entries) {
        if (name.startsWith(".")) continue;
        try {
          const full = join(absDir, name);
          const st = statSync(full);
          if (st.isDirectory()) {
            let childrenCount = 0;
            try { childrenCount = readdirSync(full).filter(n => !n.startsWith(".")).length; } catch {}
            items.push({ name, type: "dir", children_count: childrenCount, mtime: st.mtimeMs });
          } else {
            const ext = name.substring(name.lastIndexOf(".")).toLowerCase();
            items.push({ name, type: "file", size: st.size, mtime: st.mtimeMs, mime: MIME[ext] || "application/octet-stream" });
          }
        } catch {}
      }
      items.sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      json(res, { path: relPath, items });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  if (method === "GET" && path.startsWith("/api/workspace/files/")) {
    try {
      const relativePath = decodeURIComponent(path.substring("/api/workspace/files/".length));
      if (relativePath.includes("..") || relativePath.startsWith("/")) {
        res.writeHead(403); res.end("Forbidden"); return;
      }
      const filePath = join(WORKSPACE_ARTIFACTS, relativePath);
      if (!filePath.startsWith(WORKSPACE_ARTIFACTS)) {
        res.writeHead(403); res.end("Forbidden"); return;
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        res.writeHead(404); res.end("Not Found"); return;
      }
      const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase();
      const contentType = MIME[ext] || "application/octet-stream";
      const fileName = relativePath.split("/").pop();
      // Images and previewable types: serve inline; others: download
      const previewable = [".png",".jpg",".jpeg",".gif",".webp",".svg",".txt",".md",".csv",".json",".pdf",".xml",".html",".htm"].includes(ext);
      const disposition = previewable ? `inline; filename="${fileName}"` : `attachment; filename="${fileName}"`;
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Disposition": disposition,
        "Content-Length": statSync(filePath).size,
      });
      res.end(readFileSync(filePath));
    } catch (err) {
      res.writeHead(500); res.end(err.message);
    }
    return;
  }

  // ── Chat (SSE streaming) ──

  if (method === "POST" && path === "/api/chat") {
    const body = await readBody(req);
    const hasAttachments = body?.attachment_ids?.length > 0;
    if (!body?.conversation_id || (!body?.prompt?.trim() && !hasAttachments)) {
      json(res, { error: "conversation_id and prompt (or attachments) required" }, 400);
      return;
    }

    const conv = getConversation(body.conversation_id);
    if (!conv) { json(res, { error: "conversation not found" }, 404); return; }

    const engine = getEngineById(conv.engine_id);
    if (!engine) { json(res, { error: "engine not configured" }, 500); return; }

    // Load attachments if present
    const attachments = [];
    if (hasAttachments) {
      for (const attId of body.attachment_ids) {
        const att = getAttachment(attId);
        if (att && att.conv_id === conv.id) attachments.push(att);
      }
    }

    // Save user message with attachment metadata
    const msgMeta = attachments.length > 0 ? { attachments: attachments.map((a) => a.id) } : null;
    const userMsg = addMessage(conv.id, "user", body.prompt || "", msgMeta);

    // Link attachments to this message
    if (attachments.length > 0) {
      linkAttachmentsToMessage(attachments.map((a) => a.id), userMsg.id);
    }

    // Build injected context from knowledge base
    const injectDisabled = body.inject_knowledge === false;
    const injection = injectDisabled
      ? { context: "", knowledgeIds: [] }
      : buildInjectedContext(body.prompt, { maxTokens: config.evolution?.inject_max_tokens || 2000, convId: conv.id });

    // Start SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const abortController = new AbortController();
    let closed = false;
    req.on("close", () => {
      closed = true;
      abortController.abort();
    });

    // Trace capture state
    const traceData = {
      toolsCalled: [],
      usage: null,
      startTime: Date.now(),
      assistantMsgId: null,
      resultText: "",
    };

    const onEvent = (event, data) => {
      if (closed) return;
      // Capture trace data from events
      if (event === "tool_use") {
        traceData.toolsCalled.push({ name: data.name, start: Date.now() });
      }
      if (event === "result" && data.usage) {
        traceData.usage = data.usage;
      }
      if (event === "result" && data.result) {
        traceData.resultText = data.result;
      }
      sendSSE(res, event, data);
    };

    // Heartbeat to prevent mobile browsers from dropping the SSE connection
    const heartbeat = setInterval(() => {
      if (closed) return;
      res.write(": heartbeat\n\n");
    }, 15000);

    const promptText = body.prompt || "";
    console.log(`[chat] ${conv.id} engine=${conv.engine_id} attachments=${attachments.length} prompt="${promptText.substring(0, 50)}"`);

    try {
      const handler = getEngineHandler(engine.type);
      if (handler) {
        const result = await handler.handleChat(conv, engine, promptText, onEvent, abortController.signal, injection.context, attachments, serverDeps);
        traceData.assistantMsgId = result?.msgId;
      } else {
        onEvent("error", { message: `Unknown engine type: ${engine.type}. Is the plugin installed?` });
      }
    } catch (err) {
      if (!closed) {
        console.error(`[chat] ${conv.id} error:`, err.message);
        onEvent("error", { message: err.message });
      }
    } finally {
      clearInterval(heartbeat);

      // Record trace
      try {
        const duration = Date.now() - traceData.startTime;
        const usage = traceData.usage || {};
        const inputTokens = usage.input_tokens || usage.prompt_tokens || null;
        const outputTokens = usage.output_tokens || usage.completion_tokens || null;

        // Estimate cost based on engine pricing config (if available)
        const pricing = engine.provider?.pricing;
        let estimatedCost = null;
        if (pricing && inputTokens != null && outputTokens != null) {
          estimatedCost = (inputTokens / 1e6) * (pricing.input || 0) + (outputTokens / 1e6) * (pricing.output || 0);
        }

        addTrace({
          conv_id: conv.id,
          msg_id: traceData.assistantMsgId || null,
          engine_id: conv.engine_id,
          prompt_summary: promptText.substring(0, 200),
          tools_used: traceData.toolsCalled,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          estimated_cost: estimatedCost,
          response_len: (traceData.resultText || "").length,
          duration_ms: duration,
          injected_knowledge: injection.knowledgeIds.length > 0 ? injection.knowledgeIds : null,
        });
        // Notify evolution manager
        onChatComplete(conv.id);
      } catch (traceErr) {
        console.error("[trace] failed to record:", traceErr.message);
      }

      onEvent("done", { msg_id: traceData.assistantMsgId || null });
      if (!closed) res.end();
    }
    return;
  }

  // ── Knowledge routes ──

  if (method === "GET" && path === "/api/knowledge") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const category = url.searchParams.get("category") || null;
    json(res, listKnowledge(category));
    return;
  }

  if (method === "GET" && path.match(/^\/api\/knowledge\/\d+$/)) {
    const id = parseInt(path.split("/")[3]);
    const entry = getKnowledgeContent(id);
    if (!entry) { json(res, { error: "not found" }, 404); return; }
    json(res, entry);
    return;
  }

  if (method === "PUT" && path.match(/^\/api\/knowledge\/\d+$/)) {
    const id = parseInt(path.split("/")[3]);
    const body = await readBody(req);
    const result = updateKnowledge(id, body);
    if (!result) { json(res, { error: "not found" }, 404); return; }
    json(res, result);
    return;
  }

  if (method === "DELETE" && path.match(/^\/api\/knowledge\/\d+$/)) {
    const id = parseInt(path.split("/")[3]);
    const result = deleteKnowledge(id);
    if (!result) { json(res, { error: "not found" }, 404); return; }
    json(res, result);
    return;
  }

  // ── Goals routes ──

  if (method === "GET" && path === "/api/goals") {
    json(res, { content: loadGoals() });
    return;
  }

  if (method === "PUT" && path === "/api/goals") {
    const body = await readBody(req);
    if (!body?.content) { json(res, { error: "content required" }, 400); return; }
    saveGoals(body.content);
    json(res, { ok: true });
    return;
  }

  // ── Reflection routes ──

  if (method === "POST" && path === "/api/reflect/preview") {
    const body = await readBody(req);
    const since = body?.since || null;
    const limit = body?.limit || 100;
    const prep = prepareReflection(limit, since);
    json(res, { trace_count: prep.traceCount, summary: prep.summary, trace_start: prep.traceStart, trace_end: prep.traceEnd });
    return;
  }

  if (method === "GET" && path === "/api/reflect/history") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")) : 20;
    json(res, getReflectionHistory(limit));
    return;
  }

  if (method === "POST" && path === "/api/reflect") {
    const body = await readBody(req);
    const engineId = body?.engine_id || config.evolution?.reflection_engine || config.engines[0]?.id;
    const engine = getEngineById(engineId);
    if (!engine) { json(res, { error: "engine not found" }, 400); return; }

    const since = body?.since || null;
    const prep = prepareReflection(body?.limit || 100, since);
    if (prep.traceCount === 0) {
      json(res, { error: "no traces to reflect on" }, 400);
      return;
    }

    // Stream reflection via SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    const abortController = new AbortController();
    req.on("close", () => abortController.abort());

    let fullText = "";
    let usage = null;

    const reflectOnEvent = (event, data) => {
      if (event === "delta" && data.text) {
        fullText += data.text;
        sendSSE(res, "delta", data);
      }
      if (event === "result") {
        if (data.result) fullText = data.result;
        usage = data.usage;
      }
    };

    try {
      const reflectHandler = getEngineHandler(engine.type);
      if (reflectHandler?.streamSimple) {
        await reflectHandler.streamSimple({ prompt: prep.prompt, engineConfig: engine, onEvent: reflectOnEvent, abortSignal: abortController.signal });
      }

      const inputTokens = usage?.input_tokens || usage?.prompt_tokens || null;
      const outputTokens = usage?.output_tokens || usage?.completion_tokens || null;
      const pricing = engine.provider?.pricing;
      let cost = null;
      if (pricing && inputTokens && outputTokens) {
        cost = (inputTokens / 1e6) * (pricing.input || 0) + (outputTokens / 1e6) * (pricing.output || 0);
      }

      const result = processReflectionResult(fullText, {
        engineId,
        traceStart: prep.traceStart,
        traceEnd: prep.traceEnd,
        traceCount: prep.traceCount,
        triggerReason: body?.trigger_reason || "manual",
        tokens: (inputTokens || 0) + (outputTokens || 0),
        cost,
      });

      sendSSE(res, "done", {
        reflection_id: result.reflectionId,
        insight_count: result.insights.length,
        auto_accepted: result.autoAccepted,
        pending: result.pending,
      });
    } catch (err) {
      sendSSE(res, "error", { message: err.message });
    }

    res.end();
    return;
  }

  // ── Evolution routes ──

  if (method === "GET" && path === "/api/evolution/status") {
    json(res, getEvolutionState());
    return;
  }

  if (method === "GET" && path === "/api/evolution/pending") {
    json(res, getPendingInsights());
    return;
  }

  if (method === "POST" && path.match(/^\/api\/evolution\/pending\/\d+\/accept$/)) {
    const id = parseInt(path.split("/")[4]);
    const result = acceptPendingInsight(id);
    if (!result) { json(res, { error: "not found or already processed" }, 404); return; }
    json(res, result);
    return;
  }

  if (method === "POST" && path.match(/^\/api\/evolution\/pending\/\d+\/reject$/)) {
    const id = parseInt(path.split("/")[4]);
    const result = rejectPendingInsight(id);
    if (!result) { json(res, { error: "not found or already processed" }, 404); return; }
    json(res, result);
    return;
  }

  if (method === "GET" && path === "/api/evolution/log") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const type = url.searchParams.get("type") || undefined;
    const since = url.searchParams.get("since") ? parseInt(url.searchParams.get("since")) : undefined;
    const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")) : 50;
    json(res, getEvolutionLog({ type, since, limit }));
    return;
  }

  if (method === "GET" && path === "/api/evolution/stats") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const since = url.searchParams.get("since") ? parseInt(url.searchParams.get("since")) : null;
    json(res, getEvolutionStats(since));
    return;
  }

  // ── Sub-Agent routes (Phase 4) ──

  if (method === "GET" && path.match(/^\/api\/sub-agents$/)) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const convId = url.searchParams.get("conv_id");
    if (!convId) { json(res, { error: "conv_id required" }, 400); return; }
    try {
      json(res, listSubAgentRuns(convId));
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  if (method === "GET" && path === "/api/orchestrator/config") {
    try {
      json(res, { ...getOrchestratorConfig(), agent_types: Object.keys(AGENT_TYPES) });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  if (method === "PUT" && path === "/api/orchestrator/config") {
    const body = await readBody(req);
    if (!body) { json(res, { error: "body required" }, 400); return; }
    // Update orchestrator config in runtime (writes to config file would need config.mjs extension)
    // For now, return current config as acknowledgement
    json(res, { ok: true, note: "dispatch_mode changes require config.json update and restart" });
    return;
  }

  // ── Evaluation routes (Phase 4) ──

  if (method === "GET" && path === "/api/evaluations") {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const status = url.searchParams.get("status") || undefined;
      const knowledgeId = url.searchParams.get("knowledge_id") ? parseInt(url.searchParams.get("knowledge_id")) : undefined;
      const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")) : 50;
      json(res, getEvaluations({ status, knowledge_id: knowledgeId, limit }));
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  if (method === "GET" && path === "/api/evaluations/stats") {
    try {
      json(res, getEvaluationStats());
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  if (method === "POST" && path === "/api/evaluations/run") {
    const body = await readBody(req);
    if (!body?.knowledge_id) { json(res, { error: "knowledge_id required" }, 400); return; }
    try {
      // Lazy-load evaluator to avoid circular deps
      const { queueEvaluation } = await import("./lib/evaluator.mjs");
      const result = queueEvaluation(body.knowledge_id);
      json(res, result);
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  // ── A/B Testing routes (Phase 4) ──

  if (method === "GET" && path === "/api/experiments") {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const status = url.searchParams.get("status") || undefined;
      json(res, listExperiments(status));
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  if (method === "POST" && path === "/api/experiments") {
    const body = await readBody(req);
    if (!body?.name || !body?.surface) { json(res, { error: "name and surface required" }, 400); return; }
    try {
      const result = createExperiment(body);
      json(res, result);
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
    return;
  }

  if (method === "POST" && path.match(/^\/api\/experiments\/\d+\/decide$/)) {
    const id = parseInt(path.split("/")[3]);
    const body = await readBody(req);
    if (!body?.winner) { json(res, { error: "winner (A or B) required" }, 400); return; }
    try {
      decideWinner(id, body.winner);
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
    return;
  }

  if (method === "DELETE" && path.match(/^\/api\/experiments\/\d+$/)) {
    const id = parseInt(path.split("/")[3]);
    try {
      cancelExperiment(id);
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
    return;
  }

  // ── Self-Coded Tools routes (Phase 4) ──

  if (method === "GET" && path === "/api/self-coded-tools") {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const status = url.searchParams.get("status") || undefined;
      json(res, listSelfCodedTools(status));
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  if (method === "GET" && path.match(/^\/api\/self-coded-tools\/\d+$/)) {
    const id = parseInt(path.split("/")[3]);
    try {
      const tool = getToolDetail(id);
      if (!tool) { json(res, { error: "not found" }, 404); return; }
      json(res, tool);
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  if (method === "POST" && path.match(/^\/api\/self-coded-tools\/\d+\/approve$/)) {
    const id = parseInt(path.split("/")[3]);
    try {
      const validation = validateTool(id);
      if (!validation.valid) {
        json(res, { error: "Validation failed", errors: validation.errors }, 400);
        return;
      }
      const result = installTool(id);
      // Hot-reload MCP if available
      try { if (mcpManager) await mcpManager.reload?.(); } catch {}
      json(res, result);
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  if (method === "POST" && path.match(/^\/api\/self-coded-tools\/\d+\/reject$/)) {
    const id = parseInt(path.split("/")[3]);
    try {
      const { updateSelfCodedTool } = await import("./lib/db.mjs");
      updateSelfCodedTool(id, { status: "rejected" });
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  if (method === "POST" && path.match(/^\/api\/self-coded-tools\/\d+\/disable$/)) {
    const id = parseInt(path.split("/")[3]);
    try {
      disableTool(id);
      try { if (mcpManager) await mcpManager.reload?.(); } catch {}
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  if (method === "POST" && path.match(/^\/api\/self-coded-tools\/\d+\/enable$/)) {
    const id = parseInt(path.split("/")[3]);
    try {
      enableTool(id);
      try { if (mcpManager) await mcpManager.reload?.(); } catch {}
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  // ── Static files ──

  let filePath = path === "/" ? "/index.html" : path;
  filePath = join(__dirname, "public", filePath);

  // Security: prevent path traversal
  if (!filePath.startsWith(join(__dirname, "public"))) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  const ext = filePath.substring(filePath.lastIndexOf("."));
  const body = readFileSync(filePath);
  const ae = req.headers["accept-encoding"] || "";
  if (ae.includes("gzip") && [".html",".js",".css",".json"].includes(ext)) {
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Encoding": "gzip",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
    res.end(gzipSync(body));
  } else {
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
    res.end(body);
  }
});

// ── Engine handlers ──
// handleClaudeChat → migrated to plugins/engine-claude-sdk/index.mjs

async function handleOpenAIChat(conv, engine, prompt, onEvent, abortSignal, injectedContext = "", attachments = []) {
  // Build messages array from history (exclude placeholder "..." messages)
  const history = getMessages(conv.id);
  // Enrich with attachment data for multimodal history reconstruction
  const msgIds = history.map((m) => m.id);
  const attMap = getAttachmentsForMessages(msgIds);

  const messages = history.filter((m) => m.content !== "...").map((m) => {
    const msgAtts = attMap.get(m.id);
    if (msgAtts && msgAtts.length > 0 && m.role === "user") {
      // Rebuild multimodal content for historical messages with attachments
      return { role: m.role, content: buildOpenAIContent(m.content, msgAtts) };
    }
    return { role: m.role, content: m.content };
  });

  // Build base system prompt + inject learned context
  const systemParts = [];
  systemParts.push(`You are the user's personal Daemon — an AI assistant with tool-calling capabilities. When the user asks you to perform actions (search the web, send messages, create reminders, generate files, etc.), you MUST use the available tools to fulfill the request. Do not claim you cannot do something if a relevant tool is available. Always prefer taking action over explaining limitations.`);
  if (injectedContext) systemParts.push(injectedContext);
  messages.unshift({ role: "system", content: systemParts.join("\n\n") });

  // Build tools: built-in + MCP
  const { tools: mcpTools, onToolCall: mcpOnToolCall } = await buildMCPTools();
  const allTools = [...BUILTIN_TOOL_DEFINITIONS, ...mcpTools];

  // Unified tool dispatcher: built-in tools handled locally, others via MCP
  const onToolCall = async (name, args) => {
    if (BUILTIN_TOOL_NAMES.has(name)) {
      return await executeBuiltinTool(name, args);
    }
    if (mcpOnToolCall) {
      return await mcpOnToolCall(name, args);
    }
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  };

  // Insert placeholder message, update progressively
  const msg = addMessage(conv.id, "assistant", "...");
  let streamedText = "";
  let lastFlush = Date.now();
  const FLUSH_INTERVAL = 3000;

  let resultText = "";
  const wrappedOnEvent = (event, data) => {
    if (event === "result" && data.result) resultText = data.result;
    if (event === "delta" && data.text) {
      streamedText += data.text;
      const now = Date.now();
      if (now - lastFlush >= FLUSH_INTERVAL) {
        updateMessageContent(msg.id, streamedText + "\n\n<!-- streaming -->");
        lastFlush = now;
      }
    }
    onEvent(event, data);
  };

  await streamOpenAI({
    messages,
    engineConfig: engine,
    tools: allTools.length > 0 ? allTools : undefined,
    onToolCall: allTools.length > 0 ? onToolCall : undefined,
    onEvent: wrappedOnEvent,
    abortSignal,
  });

  // Final update with complete text
  const finalText = resultText || streamedText || "...";
  updateMessageContent(msg.id, finalText);
  return { msgId: msg.id };
}

/**
 * Build OpenAI-format tools from the long-running MCP Server.
 * Queries the MCP Server for its tool list via JSON-RPC,
 * then converts to OpenAI function-calling format.
 */
async function buildMCPTools() {
  if (!mcpManager) return { tools: [], onToolCall: null };

  let mcpTools;
  try {
    mcpTools = await mcpManager.listTools();
  } catch (err) {
    console.error("[mcp] failed to list tools:", err.message);
    return { tools: [], onToolCall: null };
  }

  const tools = mcpTools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.inputSchema || { type: "object", properties: {} },
    },
  }));

  const onToolCall = async (name, args) => {
    try {
      return await mcpManager.callTool(name, args);
    } catch (err) {
      return `Tool execution error: ${err.message}`;
    }
  };

  return { tools, onToolCall };
}

// ── Start ──

async function startup() {
  try {
    await initMCP();
  } catch (err) {
    console.error("[init] MCP server failed to start:", err.message);
    console.log("[init] continuing without MCP tools");
  }

  // Start evaluator background loop (Phase 4)
  try {
    const { startEvaluationLoop } = await import("./lib/evaluator.mjs");
    const evalInterval = config.evaluator?.interval_ms || 60000;
    startEvaluationLoop(evalInterval);
  } catch (err) {
    console.log("[init] evaluator not started:", err.message);
  }

  // HTTPS server (self-signed cert)
  const HTTPS_PORT = config.server?.httpsPort || 443;
  try {
    const { ensureCert } = await import("./lib/self-cert.mjs");
    const tlsOpts = ensureCert();
    const httpsServer = https.createServer(tlsOpts, server._events.request);
    httpsServer.listen(HTTPS_PORT, HOST, () => {
      console.log(`OpenDaemon HTTPS at https://${HOST}:${HTTPS_PORT}`);
    });
    httpsServer.on("error", (err) => {
      if (err.code === "EACCES") console.log(`[tls] HTTPS port ${HTTPS_PORT} requires elevated privileges, skipping`);
      else if (err.code === "EADDRINUSE") console.log(`[tls] HTTPS port ${HTTPS_PORT} already in use, skipping`);
      else console.log(`[tls] HTTPS not started: ${err.message}`);
    });
  } catch (err) {
    console.log(`[tls] HTTPS not available: ${err.message}`);
  }

  server.listen(PORT, HOST, async () => {
    console.log(`OpenDaemon running at http://${HOST}:${PORT}`);
  });
}

// Graceful shutdown
async function shutdown() {
  console.log("[shutdown] stopping...");
  try { const { stopTunnel } = await import("./lib/tunnel.mjs"); stopTunnel(); } catch {}
  if (mcpManager) mcpManager.stop().catch(() => {});
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startup();
