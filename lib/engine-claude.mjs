import { query } from "@anthropic-ai/claude-agent-sdk";
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
  // Agent SDK's query() supports content arrays via streamInput()
  // when prompt is not a string. Log for debugging.
  if (Array.isArray(prompt)) {
    console.log(`[claude] multimodal prompt: ${prompt.length} content blocks, types=${prompt.map(b => b.type).join(',')}`);
  }

  const options = {
    permissionMode: "bypassPermissions",
    maxTurns: 30,
    includePartialMessages: true,
    abortController: wrapSignal(abortSignal),
    systemPrompt: [
      "You are running inside the OpenDaemon web platform (server.mjs on Node.js, managed by pm2).",
      "CRITICAL: NEVER directly kill, restart, or stop the server process (server.mjs / pm2 / node). You ARE the server — killing it kills your own connection.",
      "",
      "## Deployment Workflow (MUST follow for any code changes):",
      "1. Make code changes (edit files freely)",
      "2. Run syntax checks: `node --check <file>` for JS, `python3 -c \"import ast; ast.parse(open('<file>').read())\"` for Python",
      "3. Commit and push: `git add <files> && git commit -m '...' && git push origin main`",
      "4. ASK the user: 'Code is committed and pushed. Ready to deploy?'",
      `5. ONLY after user confirms: run \`CONV_ID=${convId || "UNKNOWN"} bash scripts/deploy.sh\``,
      "6. The script validates syntax, then does a DELAYED restart (5s). You MUST reply to the user BEFORE the restart happens.",
      "7. Tell the user: 'Deploying now. The page will auto-reload in a few seconds.'",
      "",
      "NEVER run pm2 restart directly. ALWAYS use scripts/deploy.sh after user confirmation.",
      "",
      "## Sharing Files with the User",
      "When the user asks you to create/generate a file for them to download:",
      "1. Save the file to the `data/` directory (e.g., `data/hello.html`, `data/exports/report.csv`)",
      "2. Provide a download link: `/api/files/<relative-path>` (e.g., `/api/files/hello.html`)",
      "3. The link is served with download headers — the user can click to download.",
      "4. Example: 'File created! Download here: [hello.html](/api/files/hello.html)'",
      "NEVER save files to /tmp for the user — always use the data/ directory.",
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

function wrapSignal(signal) {
  const ac = new AbortController();
  if (signal) {
    signal.addEventListener("abort", () => ac.abort(), { once: true });
  }
  return ac;
}
