import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadSystemPrompt } from "./prompts.mjs";
// Cache slash commands
let cachedCommands = null;
let commandsFetching = false;

export async function streamClaude({
  prompt,
  convId,
  sdkSessionId,
  mcpServers,
  injectedContext = "",
  onEvent,
  abortSignal,
}) {
  // Agent SDK's query() when prompt is not a string uses streamInput(),
  // which expects an async iterable of message objects.
  // Wrap content blocks array into the correct format.
  if (Array.isArray(prompt)) {
    console.log(`[claude] multimodal prompt: ${prompt.length} content blocks, types=${prompt.map(b => b.type).join(',')}`);
    prompt = wrapContentAsMessageStream(prompt);
  }

  const options = {
    permissionMode: "bypassPermissions",
    maxTurns: 30,
    includePartialMessages: true,
    abortController: wrapSignal(abortSignal),
    systemPrompt: [
      loadSystemPrompt("platform", { conv_id: convId || "UNKNOWN" }),
      ...(injectedContext ? ["", injectedContext] : []),
    ].join("\n"),
  };

  if (mcpServers && Object.keys(mcpServers).length > 0) {
    options.mcpServers = mcpServers;
    // Allow all MCP tools
    options.allowedTools = Object.keys(mcpServers).map(
      (name) => `mcp__${name}__*`
    );
  }

  // Try with session resume first, fallback to new session if it fails
  const attempts = sdkSessionId ? [sdkSessionId, null] : [null];

  for (const resumeId of attempts) {
    const opts = { ...options };
    if (resumeId) opts.resume = resumeId;

    try {
      const result = await runQuery(prompt, opts, onEvent, abortSignal);
      return result;
    } catch (err) {
      if (resumeId && attempts.length > 1) {
        console.log(`[claude] session resume failed (${err.message}), retrying without session`);
        onEvent("error", { message: "Session expired, starting fresh..." });
        continue;
      }
      throw err;
    }
  }
}

async function runQuery(prompt, options, onEvent, abortSignal) {
  let sessionId = null;
  let resultText = "";

  const q = query({ prompt, options });

  for await (const msg of q) {
    if (abortSignal?.aborted) break;

    switch (msg.type) {
      case "system":
        sessionId = msg.session_id;
        onEvent("system", { subtype: msg.subtype, session_id: msg.session_id });
        break;

      case "assistant":
        if (!msg.message?.content) break;
        for (const block of msg.message.content) {
          if (block.type === "text") {
            resultText = block.text;
            onEvent("text", { text: block.text });
          } else if (block.type === "tool_use") {
            onEvent("tool_use", {
              name: block.name,
              id: block.id,
              input: block.input,
            });
          } else if (block.type === "thinking") {
            onEvent("thinking", { thinking: block.thinking });
          }
        }
        break;

      case "stream_event": {
        const event = msg.event;
        if (event?.type === "content_block_delta") {
          if (event.delta?.type === "text_delta") {
            onEvent("delta", { text: event.delta.text });
          } else if (event.delta?.type === "thinking_delta") {
            onEvent("thinking_delta", { text: event.delta.thinking });
          }
        }
        break;
      }

      case "tool_progress":
        onEvent("tool_progress", {
          tool_name: msg.tool_name,
          data: msg.data,
        });
        break;

      case "result":
        if (!resultText && msg.result) resultText = msg.result;
        onEvent("result", {
          subtype: msg.subtype,
          session_id: msg.session_id,
          usage: msg.usage,
          result: msg.result,
        });
        sessionId = msg.session_id || sessionId;
        break;

      case "rate_limit_event":
        onEvent("rate_limit", {
          status: msg.rate_limit_info?.status,
          resets_at: msg.rate_limit_info?.resetsAt,
          utilization: msg.rate_limit_info?.utilization,
        });
        break;

      default:
        break;
    }
  }

  return { sessionId, resultText };
}

export async function fetchCommands() {
  if (cachedCommands) return cachedCommands;
  if (commandsFetching) {
    while (commandsFetching) await new Promise((r) => setTimeout(r, 100));
    return cachedCommands;
  }
  commandsFetching = true;
  try {
    const q = query({
      prompt: "hi",
      options: { maxTurns: 1, permissionMode: "bypassPermissions" },
    });
    const [commands, agents] = await Promise.all([
      q.supportedCommands(),
      q.supportedAgents(),
    ]);
    for await (const _ of q) {} // drain
    cachedCommands = { commands, agents };
    return cachedCommands;
  } catch (err) {
    console.error("[claude] fetchCommands error:", err.message);
    return { commands: [], agents: [] };
  } finally {
    commandsFetching = false;
  }
}

/**
 * Wrap content blocks array into an async iterable of SDK message objects.
 * streamInput() expects: for await (const msg of input) { msg.type === "user", ... }
 * Each message is serialized via the SDK's internal q$() formatter.
 */
function wrapContentAsMessageStream(contentBlocks) {
  const message = {
    type: "user",
    session_id: "",
    message: { role: "user", content: contentBlocks },
    parent_tool_use_id: null,
  };
  // Return an async iterable that yields one message
  return {
    [Symbol.asyncIterator]() {
      let done = false;
      return {
        async next() {
          if (done) return { done: true, value: undefined };
          done = true;
          return { done: false, value: message };
        },
      };
    },
  };
}

function wrapSignal(signal) {
  const ac = new AbortController();
  if (signal) {
    signal.addEventListener("abort", () => ac.abort(), { once: true });
  }
  return ac;
}
