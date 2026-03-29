import { query } from "@anthropic-ai/claude-agent-sdk";

// Cache slash commands
let cachedCommands = null;
let commandsFetching = false;

export async function streamClaude({
  prompt,
  sdkSessionId,
  mcpServers,
  onEvent,
  abortSignal,
}) {
  const options = {
    permissionMode: "bypassPermissions",
    maxTurns: 30,
    includePartialMessages: true,
    abortController: wrapSignal(abortSignal),
    systemPrompt: [
      "You are running inside the OpenDaemon web platform (server.mjs on Node.js, managed by pm2).",
      "CRITICAL: NEVER kill, restart, or stop the server process (server.mjs / pm2 / node). You ARE the server — killing it kills your own connection and the user loses their session.",
      "If you need to restart the server, tell the user to do it manually via: pm2 restart opendaemon",
      "You have full file system access and can run any other bash commands freely.",
    ].join("\n"),
  };

  if (sdkSessionId) options.resume = sdkSessionId;
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    options.mcpServers = mcpServers;
    // Allow all MCP tools
    options.allowedTools = Object.keys(mcpServers).map(
      (name) => `mcp__${name}__*`
    );
  }

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

function wrapSignal(signal) {
  const ac = new AbortController();
  if (signal) {
    signal.addEventListener("abort", () => ac.abort(), { once: true });
  }
  return ac;
}
