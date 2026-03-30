/**
 * Anthropic Local Proxy — translates between Anthropic Messages API and OpenAI Chat Completions API.
 *
 * Allows Claude Agent SDK to connect to any OpenAI-compatible endpoint (OpenRouter, DeepSeek, etc.)
 * by intercepting SDK requests, translating the protocol, and forwarding to the real backend.
 *
 * Usage:
 *   const { port } = await ensureProxy();
 *   env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
 *   env.ANTHROPIC_API_KEY = encodeBackendConfig({ url, key, format, model });
 */

import http from "http";
import { convertAnthropicToOpenAI, convertOpenAIStreamToAnthropic } from "./anthropic-openai-converter.mjs";

let proxyInstance = null;

// ── Backend Config Encoding ──

export function encodeBackendConfig({ url, key, format = "openai", model = "" }) {
  return Buffer.from(JSON.stringify({ url, key, format, model })).toString("base64");
}

export function decodeBackendConfig(encoded) {
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

// ── Proxy Server ──

/**
 * Start or return existing proxy. Process-level singleton.
 * @returns {{ port: number, stop: () => void }}
 */
export async function ensureProxy() {
  if (proxyInstance) return proxyInstance;

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      // Only handle POST /v1/messages
      if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found", message: "Only POST /v1/messages is supported" } }));
        return;
      }

      try {
        await handleProxyRequest(req, res);
      } catch (err) {
        console.error("[proxy] unhandled error:", err.message);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: err.message } }));
        }
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      console.log(`[proxy] Anthropic translation proxy started on 127.0.0.1:${port}`);
      proxyInstance = {
        port,
        stop: () => {
          server.close();
          proxyInstance = null;
          console.log("[proxy] stopped");
        },
      };
      resolve(proxyInstance);
    });

    server.on("error", reject);
  });
}

/**
 * Handle a proxied request from Claude Agent SDK.
 */
async function handleProxyRequest(req, res) {
  // Read request body
  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  const rawBody = Buffer.concat(bodyChunks).toString("utf-8");

  // Decode backend config from API key header
  const apiKey = req.headers["x-api-key"] || "";
  const config = decodeBackendConfig(apiKey);
  if (!config?.url || !config?.key) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request", message: "Invalid encoded backend config in x-api-key" } }));
    return;
  }

  let anthropicReq;
  try {
    anthropicReq = JSON.parse(rawBody);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request", message: "Invalid JSON body" } }));
    return;
  }

  const isStream = anthropicReq.stream === true;

  if (config.format === "anthropic") {
    // ── Anthropic passthrough: just forward with real auth ──
    await forwardAnthropic(config, rawBody, isStream, req, res);
  } else {
    // ── OpenAI translation ──
    await translateAndForward(config, anthropicReq, isStream, res);
  }
}

/**
 * Anthropic-format passthrough: forward request directly to an Anthropic-compatible endpoint.
 */
async function forwardAnthropic(config, rawBody, isStream, originalReq, res) {
  try {
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": config.key,
      "anthropic-version": originalReq.headers["anthropic-version"] || "2023-06-01",
    };

    const resp = await fetch(config.url, {
      method: "POST",
      headers,
      body: rawBody,
    });

    // Forward status and headers
    const fwdHeaders = { "Content-Type": resp.headers.get("content-type") || "application/json" };
    res.writeHead(resp.status, fwdHeaders);

    if (isStream && resp.body) {
      // Pipe stream through
      const reader = resp.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch (err) {
        if (!res.destroyed) res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: err.message } })}\n\n`);
      }
    } else {
      const text = await resp.text();
      res.write(text);
    }
    res.end();
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `Upstream error: ${err.message}` } }));
  }
}

/**
 * Translate Anthropic request to OpenAI format, forward, translate response back.
 */
async function translateAndForward(config, anthropicReq, isStream, res) {
  try {
    // Convert Anthropic → OpenAI request
    const openaiReq = convertAnthropicToOpenAI(anthropicReq, config.model);

    // Forward to OpenAI-compatible endpoint
    const resp = await fetch(`${config.url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.key}`,
      },
      body: JSON.stringify(openaiReq),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "unknown");
      res.writeHead(resp.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        type: "error",
        error: { type: "api_error", message: `Upstream ${resp.status}: ${errText.substring(0, 500)}` },
      }));
      return;
    }

    if (isStream && resp.body) {
      // Stream: translate OpenAI SSE → Anthropic SSE
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      await convertOpenAIStreamToAnthropic(resp.body, res, anthropicReq.model || config.model || "claude-sonnet-4-20250514");
      res.end();
    } else {
      // Non-stream: translate full response
      const openaiResp = await resp.json();
      const anthropicResp = convertOpenAINonStreamToAnthropic(openaiResp, anthropicReq.model || config.model);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(anthropicResp));
    }
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({
      type: "error",
      error: { type: "api_error", message: `Translation error: ${err.message}` },
    }));
  }
}

/**
 * Convert a non-streaming OpenAI response to Anthropic format.
 */
function convertOpenAINonStreamToAnthropic(openaiResp, model) {
  const choice = openaiResp.choices?.[0];
  if (!choice) {
    return { type: "error", error: { type: "api_error", message: "No choices in response" } };
  }

  const content = [];
  if (choice.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: safeParseJSON(tc.function.arguments),
      });
    }
  }

  const stopReason = choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn";

  return {
    id: openaiResp.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: model || openaiResp.model,
    content,
    stop_reason: stopReason,
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0,
    },
  };
}

function safeParseJSON(str) {
  try { return JSON.parse(str); } catch { return {}; }
}
