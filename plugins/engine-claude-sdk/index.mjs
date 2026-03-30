/**
 * Claude Agent SDK Plugin — Agentic engine with built-in tool use, MCP, thinking.
 *
 * Wraps lib/engine-claude.mjs (low-level SDK) into the plugin interface.
 * Dependencies are injected via the `deps` parameter to avoid importing server internals.
 */

import { streamClaude, fetchCommands } from "../../lib/engine-claude.mjs";
import { loadConfig } from "../../lib/config.mjs";
import { ensureProxy, encodeBackendConfig } from "../../lib/anthropic-proxy.mjs";
import { existsSync } from "fs";
import { join } from "path";

export const metadata = {
  type: "claude-sdk",
  name: "Claude Agent SDK",
  description: "Agentic engine with built-in tools, MCP, extended thinking, and session resume",
  category: "agentic",
};

/**
 * Handle a chat turn using Claude Agent SDK.
 */
export async function handleChat(conv, engine, prompt, onEvent, abortSignal, injectedContext = "", attachments = [], deps = {}) {
  const { addMessage, updateMessageContent, updateConversationSdkSession, buildClaudeContent } = deps;
  const config = loadConfig();

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

  // Build multimodal prompt if attachments present
  const effectivePrompt = attachments.length > 0 ? buildClaudeContent(prompt, attachments) : prompt;

  let sessionId, resultText;
  try {
    ({ sessionId, resultText } = await streamClaude({
      prompt: effectivePrompt,
      convId: conv.id,
      sdkSessionId: conv.sdk_session,
      mcpServers,
      engineConfig: engine,
      injectedContext,
      onEvent: wrappedOnEvent,
      abortSignal,
    }));
  } finally {
    const finalText = resultText || streamedText || "...";
    updateMessageContent(msg.id, finalText);
  }

  if (sessionId) updateConversationSdkSession(conv.id, sessionId);
  return { msgId: msg.id };
}

/**
 * Simple stream for reflection/evaluation — no conversation context needed.
 */
export async function streamSimple({ prompt, engineConfig, onEvent, abortSignal }) {
  await streamClaude({
    prompt,
    convId: null,
    mcpServers: {},
    engineConfig: engineConfig || {},
    onEvent,
    abortSignal,
  });
}

/**
 * Connection test — supports OAuth, API Key, and Custom URL modes.
 */
export async function test(engine) {
  const provider = engine.provider || {};

  if (provider.baseUrl) {
    // Custom URL mode — test via proxy
    const { port } = await ensureProxy();
    const encoded = encodeBackendConfig({
      url: provider.baseUrl,
      key: provider.apiKey || "",
      format: provider.format || "openai",
      model: provider.model || engine.model || "",
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": encoded,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: engine.model || "claude-sonnet-4-20250514",
          max_tokens: 10,
          messages: [{ role: "user", content: "Hi" }],
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "unknown");
        return { ok: false, error: `Proxy test ${resp.status}: ${errText.substring(0, 200)}` };
      }
      return { ok: true, note: `via proxy → ${provider.baseUrl}` };
    } catch (err) {
      clearTimeout(timeout);
      return { ok: false, error: err.name === "AbortError" ? "Connection timeout (15s)" : err.message };
    }
  } else if (provider.apiKey || process.env.ANTHROPIC_API_KEY) {
    // API Key mode — direct Anthropic test
    const apiKey = provider.apiKey || process.env.ANTHROPIC_API_KEY;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: engine.model || "claude-sonnet-4-20250514",
          max_tokens: 10,
          messages: [{ role: "user", content: "Hi" }],
        }),
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
  } else {
    // OAuth mode
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";
    const oauthPath = join(homeDir, ".claude");
    if (existsSync(oauthPath)) {
      return { ok: true, note: "OAuth mode (credentials managed by Claude SDK)" };
    }
    return { ok: false, error: "No API key and no OAuth credentials found. Run 'claude login' or set provider.apiKey." };
  }
}

/**
 * Get slash commands (Claude SDK specific).
 */
export async function getCommands() {
  return await fetchCommands();
}
