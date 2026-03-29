import http from "http";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync, existsSync, statSync } from "fs";

import { loadConfig, getEngineById, getEngines } from "./lib/config.mjs";
import { initDb, createConversation, listConversations, getConversation, deleteConversation, addMessage, updateMessageContent, getMessages, updateConversationSdkSession } from "./lib/db.mjs";
import { createAuth } from "./lib/auth.mjs";
import { streamClaude, fetchCommands } from "./lib/engine-claude.mjs";
import { streamOpenAI } from "./lib/engine-openai.mjs";
import { MCPManager } from "./lib/mcp-manager.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ── Initialize ──
const config = loadConfig();
const PORT = process.env.PORT || config.server?.port || 3456;
const HOST = process.env.HOST || config.server?.host || "127.0.0.1";
initDb();
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
  mcpManager = new MCPManager(serverConfig, channelsConfig);
  await mcpManager.start();
}

console.log(`[init] ${config.engines.length} engines configured, listening on ${HOST}:${PORT}`);

// ── Helpers ──

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  try { return JSON.parse(body); } catch { return null; }
}

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
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

  // Auth check (returns false and sends response if not authed)
  if (!auth.requireAuth(req, res)) return;

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

  if (method === "GET" && path === "/api/engines") {
    json(res, getEngines());
    return;
  }

  if (method === "GET" && path === "/api/commands") {
    try {
      const data = await fetchCommands();
      json(res, data);
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
    return;
  }

  // ── Conversation routes ──

  if (method === "GET" && path === "/api/conversations") {
    json(res, listConversations());
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

  if (method === "DELETE" && path.startsWith("/api/conversations/")) {
    const id = extractParam(req.url, "/api/conversations/");
    if (!id) { json(res, { error: "id required" }, 400); return; }
    deleteConversation(id);
    json(res, { ok: true });
    return;
  }

  if (method === "GET" && path.match(/^\/api\/conversations\/[^/]+\/messages$/)) {
    const id = extractParam(req.url, "/api/conversations/");
    if (!id) { json(res, { error: "id required" }, 400); return; }
    json(res, getMessages(id));
    return;
  }

  // ── Chat (SSE streaming) ──

  if (method === "POST" && path === "/api/chat") {
    const body = await readBody(req);
    if (!body?.conversation_id || !body?.prompt?.trim()) {
      json(res, { error: "conversation_id and prompt required" }, 400);
      return;
    }

    const conv = getConversation(body.conversation_id);
    if (!conv) { json(res, { error: "conversation not found" }, 404); return; }

    const engine = getEngineById(conv.engine_id);
    if (!engine) { json(res, { error: "engine not configured" }, 500); return; }

    // Save user message
    addMessage(conv.id, "user", body.prompt);

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

    const onEvent = (event, data) => {
      if (closed) return;
      sendSSE(res, event, data);
    };

    // Heartbeat to prevent mobile browsers from dropping the SSE connection
    const heartbeat = setInterval(() => {
      if (closed) return;
      res.write(": heartbeat\n\n");
    }, 15000);

    console.log(`[chat] ${conv.id} engine=${conv.engine_id} prompt="${body.prompt.substring(0, 50)}"`);

    try {
      if (engine.type === "claude-sdk") {
        await handleClaudeChat(conv, engine, body.prompt, onEvent, abortController.signal);
      } else if (engine.type === "openai") {
        await handleOpenAIChat(conv, engine, body.prompt, onEvent, abortController.signal);
      } else {
        onEvent("error", { message: `Unknown engine type: ${engine.type}` });
      }
    } catch (err) {
      if (!closed) {
        console.error(`[chat] ${conv.id} error:`, err.message);
        onEvent("error", { message: err.message });
      }
    } finally {
      clearInterval(heartbeat);
      onEvent("done", {});
      if (!closed) res.end();
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
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": "no-cache, no-store, must-revalidate",
  });
  res.end(readFileSync(filePath));
});

// ── Engine handlers ──

async function handleClaudeChat(conv, engine, prompt, onEvent, abortSignal) {
  // Build MCP servers from config
  const mcpServers = {};
  const mcpConfig = config.mcp || {};
  for (const [name, serverConfig] of Object.entries(mcpConfig)) {
    mcpServers[name] = serverConfig;
  }

  // Insert placeholder message at start, update progressively
  const msg = addMessage(conv.id, "assistant", "...");
  let streamedText = "";
  let lastFlush = Date.now();
  const FLUSH_INTERVAL = 3000;

  const wrappedOnEvent = (event, data) => {
    let dirty = false;
    if (event === "delta" && data.text) {
      streamedText += data.text;
      dirty = true;
    } else if (event === "text" && data.text) {
      // Complete text block (between tool calls)
      streamedText = data.text;
      dirty = true;
    } else if (event === "tool_use" && data.name) {
      streamedText += `\n\n> Tool: ${data.name}${data.input?.command ? ` — ${data.input.command.substring(0, 60)}` : data.input?.file_path ? ` — ${data.input.file_path}` : ""}\n`;
      dirty = true;
    }
    if (dirty) {
      const now = Date.now();
      if (now - lastFlush >= FLUSH_INTERVAL) {
        updateMessageContent(msg.id, streamedText + "\n\n<!-- streaming -->");
        lastFlush = now;
      }
    }
    onEvent(event, data);
  };

  const { sessionId, resultText } = await streamClaude({
    prompt,
    convId: conv.id,
    sdkSessionId: conv.sdk_session,
    mcpServers,
    onEvent: wrappedOnEvent,
    abortSignal,
  });

  // Final update — remove streaming marker
  const finalText = resultText || streamedText || "...";
  updateMessageContent(msg.id, finalText);

  if (sessionId) updateConversationSdkSession(conv.id, sessionId);
}

async function handleOpenAIChat(conv, engine, prompt, onEvent, abortSignal) {
  // Build messages array from history (exclude placeholder "..." messages)
  const history = getMessages(conv.id);
  const messages = history.filter((m) => m.content !== "...").map((m) => ({ role: m.role, content: m.content }));

  // Build tools from MCP Manager (long-running process)
  const { tools, onToolCall } = await buildMCPTools();

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
    tools: tools.length > 0 ? tools : undefined,
    onToolCall: tools.length > 0 ? onToolCall : undefined,
    onEvent: wrappedOnEvent,
    abortSignal,
  });

  // Final update with complete text
  const finalText = resultText || streamedText || "...";
  updateMessageContent(msg.id, finalText);
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

  server.listen(PORT, HOST, () => {
    console.log(`OpenDaemon running at http://${HOST}:${PORT}`);
  });
}

// Graceful shutdown
function shutdown() {
  console.log("[shutdown] stopping...");
  if (mcpManager) mcpManager.stop().catch(() => {});
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startup();
