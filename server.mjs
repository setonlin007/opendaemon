import http from "http";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync, existsSync, statSync } from "fs";

import { loadConfig, getEngineById, getEngines } from "./lib/config.mjs";
import { initDb, createConversation, listConversations, getConversation, deleteConversation, addMessage, getMessages, updateConversationSdkSession } from "./lib/db.mjs";
import { createAuth } from "./lib/auth.mjs";
import { streamClaude, fetchCommands } from "./lib/engine-claude.mjs";
import { streamOpenAI } from "./lib/engine-openai.mjs";

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
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
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

  const { sessionId, resultText } = await streamClaude({
    prompt,
    sdkSessionId: conv.sdk_session,
    mcpServers,
    onEvent,
    abortSignal,
  });

  // Persist session and assistant message
  if (sessionId) updateConversationSdkSession(conv.id, sessionId);
  if (resultText) addMessage(conv.id, "assistant", resultText);
}

async function handleOpenAIChat(conv, engine, prompt, onEvent, abortSignal) {
  // Build messages array from history
  const history = getMessages(conv.id);
  const messages = history.map((m) => ({ role: m.role, content: m.content }));

  // Build tools from MCP config for function calling
  const { tools, onToolCall } = buildMCPTools();

  let resultText = "";
  const wrappedOnEvent = (event, data) => {
    if (event === "result" && data.result) resultText = data.result;
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

  // Save assistant message
  if (resultText) addMessage(conv.id, "assistant", resultText);
}

/**
 * Build OpenAI-format tools from MCP config.
 * MCP tools are defined in config.json under "mcp" with their schemas.
 * When a tool is called, we spawn the MCP server subprocess to execute it.
 */
function buildMCPTools() {
  const mcpConfig = config.mcp || {};
  const tools = [];
  const toolMap = new Map(); // toolName -> { serverConfig, originalName }

  for (const [serverName, serverConfig] of Object.entries(mcpConfig)) {
    const mcpTools = serverConfig.tools || [];
    for (const tool of mcpTools) {
      if (typeof tool === "string") {
        // Simple tool name — no schema, skip for now
        continue;
      }
      // Tool with schema: { name, description, input_schema }
      const fullName = `${serverName}__${tool.name}`;
      tools.push({
        type: "function",
        function: {
          name: fullName,
          description: tool.description || "",
          parameters: tool.input_schema || { type: "object", properties: {} },
        },
      });
      toolMap.set(fullName, { serverConfig, originalName: tool.name });
    }
  }

  const onToolCall = async (name, args) => {
    const mapping = toolMap.get(name);
    if (!mapping) return `Error: unknown tool ${name}`;

    // Execute via MCP server subprocess (JSON-RPC over stdio)
    const { serverConfig, originalName } = mapping;
    try {
      const { execFileSync } = await import("child_process");
      const input = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: originalName, arguments: args },
      });
      const result = execFileSync(serverConfig.command, [...(serverConfig.args || []), "--call"], {
        input,
        timeout: 30000,
        encoding: "utf-8",
        env: { ...process.env, ...(serverConfig.env || {}) },
      });
      const parsed = JSON.parse(result);
      if (parsed.result?.content) {
        return parsed.result.content.map((c) => c.text || JSON.stringify(c)).join("\n");
      }
      return result;
    } catch (err) {
      return `Tool execution error: ${err.message}`;
    }
  };

  return { tools, onToolCall };
}

// ── Start ──

server.listen(PORT, HOST, () => {
  console.log(`OpenDaemon running at http://${HOST}:${PORT}`);
});
