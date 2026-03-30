/**
 * OpenAI Agents SDK Plugin — Agentic engine with multi-agent handoffs, guardrails, and tracing.
 *
 * Supports OpenAI models natively, plus any OpenAI-compatible endpoint (DeepSeek, Ollama, etc.)
 * via configurable baseURL. MCP support is built-in.
 */

import { Agent, run as agentRun, Runner, OpenAIProvider, MCPServerStdio } from "@openai/agents";
import { loadConfig } from "../../lib/config.mjs";

export const metadata = {
  type: "openai-agents",
  name: "OpenAI Agents SDK",
  description: "Multi-agent framework with handoffs, guardrails, MCP support. Works with 100+ models.",
  category: "agentic",
};

// ── Reusable state ──
let cachedRunner = null;
let cachedMcpServers = [];

/**
 * Build or reuse a Runner with the given engine config.
 */
function getRunner(engine) {
  const provider = engine.provider || {};
  const apiKey = provider.apiKey || process.env.OPENAI_API_KEY || "";
  const baseURL = provider.baseUrl || "https://api.openai.com/v1";

  // Non-OpenAI providers need Chat Completions API (not Responses API)
  const useResponses = !provider.baseUrl || baseURL.includes("api.openai.com");

  const openaiProvider = new OpenAIProvider({
    apiKey,
    baseURL,
    useResponses,
  });

  return new Runner({
    modelProvider: openaiProvider,
    tracingDisabled: true, // Disable OpenAI tracing (we have our own)
  });
}

/**
 * Build MCP servers from config.
 */
async function buildMcpServers() {
  const config = loadConfig();
  const mcpConfig = config.mcp || {};
  const servers = [];

  for (const [name, serverConfig] of Object.entries(mcpConfig)) {
    if (!serverConfig.command) continue;
    try {
      const server = new MCPServerStdio({
        name,
        command: serverConfig.command,
        args: serverConfig.args || [],
        cacheToolsList: true,
      });
      await server.connect();
      servers.push(server);
    } catch (err) {
      console.error(`[openai-agents] MCP server ${name} failed to connect:`, err.message);
    }
  }

  return servers;
}

/**
 * Handle a chat turn using OpenAI Agents SDK.
 */
export async function handleChat(conv, engine, prompt, onEvent, abortSignal, injectedContext = "", attachments = [], deps = {}) {
  const { addMessage, updateMessageContent, getMessages, getAttachmentsForMessages, buildOpenAIContent } = deps;

  const runner = getRunner(engine);
  const model = engine.provider?.model || engine.model || "gpt-4.1";

  // Build system instructions
  const instructions = [
    "You are the user's personal Daemon — an AI assistant with tool-calling capabilities.",
    "When the user asks you to perform actions, you MUST use the available tools.",
    "Always prefer taking action over explaining limitations.",
  ];
  if (injectedContext) instructions.push("", injectedContext);

  // Build MCP servers (reuse if available)
  if (cachedMcpServers.length === 0) {
    try {
      cachedMcpServers = await buildMcpServers();
    } catch (err) {
      console.error("[openai-agents] MCP init failed:", err.message);
    }
  }

  // Create agent
  const agent = new Agent({
    name: "Daemon",
    instructions: instructions.join("\n"),
    model,
    mcpServers: cachedMcpServers,
    modelSettings: {
      maxTokens: engine.options?.maxTokens || 4096,
      temperature: engine.options?.temperature,
    },
  });

  // Build conversation history from DB
  const history = getMessages(conv.id);
  const msgIds = history.map((m) => m.id);
  const attMap = deps.getAttachmentsForMessages ? getAttachmentsForMessages(msgIds) : new Map();

  const inputItems = history
    .filter((m) => m.content !== "...")
    .map((m) => {
      const msgAtts = attMap.get(m.id);
      if (msgAtts?.length > 0 && m.role === "user" && buildOpenAIContent) {
        return { role: m.role, content: buildOpenAIContent(m.content, msgAtts) };
      }
      return { role: m.role, content: m.content };
    });

  // Insert placeholder message
  const msg = addMessage(conv.id, "assistant", "...");
  let streamedText = "";
  let lastFlush = Date.now();
  const FLUSH_INTERVAL = 3000;

  try {
    // Run agent with streaming
    const result = await runner.run(agent, inputItems, {
      stream: true,
      maxTurns: engine.options?.maxTurns || 30,
      signal: abortSignal,
    });

    // Process stream events
    for await (const event of result) {
      if (abortSignal?.aborted) break;

      if (event.type === "raw_model_stream_event") {
        // Extract text deltas from raw events
        const delta = event.data?.choices?.[0]?.delta;
        if (delta?.content) {
          streamedText += delta.content;
          onEvent("delta", { text: delta.content });

          const now = Date.now();
          if (now - lastFlush >= FLUSH_INTERVAL) {
            updateMessageContent(msg.id, streamedText + "\n\n<!-- streaming -->");
            lastFlush = now;
          }
        }
        // Reasoning / thinking
        if (delta?.reasoning_content) {
          onEvent("thinking_delta", { text: delta.reasoning_content });
        }
      } else if (event.type === "run_item_stream_event") {
        if (event.name === "tool_called") {
          const item = event.item?.rawItem;
          const toolName = item?.name || item?.function?.name || "unknown";
          onEvent("tool_use", { name: toolName, id: item?.id || "", input: item?.arguments || item?.input || {} });
          streamedText += `\n\n> Tool: ${toolName}\n`;
        } else if (event.name === "tool_output") {
          onEvent("tool_progress", { tool_name: "tool", data: "completed" });
        }
      }
    }

    // Get final output
    const finalText = result.finalOutput || streamedText || "...";
    updateMessageContent(msg.id, finalText);
    streamedText = finalText;

    // Extract usage
    const usage = { input_tokens: 0, output_tokens: 0 };
    for (const resp of result.rawResponses || []) {
      if (resp.usage) {
        usage.input_tokens += resp.usage.prompt_tokens || resp.usage.input_tokens || 0;
        usage.output_tokens += resp.usage.completion_tokens || resp.usage.output_tokens || 0;
      }
    }

    onEvent("result", { subtype: "success", usage, result: finalText });
  } catch (err) {
    if (abortSignal?.aborted) return { msgId: msg.id };
    const finalText = streamedText || `Error: ${err.message}`;
    updateMessageContent(msg.id, finalText);
    onEvent("error", { message: err.message });
  }

  return { msgId: msg.id };
}

/**
 * Simple stream for reflection/evaluation.
 */
export async function streamSimple({ prompt, engineConfig, onEvent, abortSignal }) {
  const runner = getRunner(engineConfig);
  const model = engineConfig.provider?.model || engineConfig.model || "gpt-4.1";

  const agent = new Agent({
    name: "Reflector",
    instructions: "You are a reflection engine. Analyze the provided data and extract insights.",
    model,
  });

  try {
    const result = await runner.run(agent, prompt, {
      stream: true,
      signal: abortSignal,
    });

    let text = "";
    for await (const event of result) {
      if (event.type === "raw_model_stream_event") {
        const delta = event.data?.choices?.[0]?.delta;
        if (delta?.content) {
          text += delta.content;
          onEvent("delta", { text: delta.content });
        }
      }
    }

    const finalText = result.finalOutput || text;
    onEvent("result", { subtype: "success", result: finalText });
  } catch (err) {
    if (!abortSignal?.aborted) {
      onEvent("error", { message: err.message });
    }
  }
}

/**
 * Connection test.
 */
export async function test(engine) {
  const provider = engine.provider || {};
  const apiKey = provider.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "No API key configured (set provider.apiKey or OPENAI_API_KEY env)" };
  }

  const baseURL = provider.baseUrl || "https://api.openai.com/v1";
  const model = provider.model || engine.model || "gpt-4.1-mini";

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Hi" }], max_tokens: 10 }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "unknown");
      return { ok: false, error: `HTTP ${resp.status}: ${errText.substring(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.name === "AbortError" ? "Connection timeout (15s)" : err.message };
  }
}

/**
 * Cleanup MCP servers on shutdown.
 */
export async function destroy() {
  for (const server of cachedMcpServers) {
    try { await server.close(); } catch {}
  }
  cachedMcpServers = [];
}
