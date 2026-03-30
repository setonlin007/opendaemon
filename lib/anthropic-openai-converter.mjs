/**
 * Anthropic ↔ OpenAI Protocol Converter
 *
 * Converts between Anthropic Messages API and OpenAI Chat Completions API.
 * Used by the local proxy to let Claude Agent SDK talk to any OpenAI-compatible endpoint.
 */

// ── Request Conversion: Anthropic → OpenAI ──

/**
 * Convert an Anthropic Messages API request to OpenAI Chat Completions format.
 */
export function convertAnthropicToOpenAI(anthropicReq, overrideModel) {
  const messages = [];

  // System prompt
  if (anthropicReq.system) {
    const systemText = typeof anthropicReq.system === "string"
      ? anthropicReq.system
      : anthropicReq.system.map(b => b.text || "").join("\n");
    if (systemText) {
      messages.push({ role: "system", content: systemText });
    }
  }

  // Convert messages
  for (const msg of anthropicReq.messages || []) {
    const converted = convertMessage(msg);
    if (Array.isArray(converted)) {
      messages.push(...converted);
    } else {
      messages.push(converted);
    }
  }

  const result = {
    model: overrideModel || anthropicReq.model || "gpt-4o",
    messages,
    stream: anthropicReq.stream ?? false,
  };

  if (anthropicReq.max_tokens) result.max_tokens = anthropicReq.max_tokens;
  if (anthropicReq.temperature !== undefined) result.temperature = anthropicReq.temperature;
  if (anthropicReq.top_p !== undefined) result.top_p = anthropicReq.top_p;

  // Convert tools
  if (anthropicReq.tools?.length > 0) {
    result.tools = anthropicReq.tools.map(convertToolDef);
  }

  // Convert tool_choice
  if (anthropicReq.tool_choice) {
    if (anthropicReq.tool_choice.type === "auto") {
      result.tool_choice = "auto";
    } else if (anthropicReq.tool_choice.type === "any") {
      result.tool_choice = "required";
    } else if (anthropicReq.tool_choice.type === "tool") {
      result.tool_choice = { type: "function", function: { name: anthropicReq.tool_choice.name } };
    }
  }

  if (result.stream) {
    result.stream_options = { include_usage: true };
  }

  return result;
}

/**
 * Convert a single Anthropic message to OpenAI format.
 * May return multiple messages (e.g., assistant with tool_use + tool_result → assistant + tool messages).
 */
function convertMessage(msg) {
  const { role, content } = msg;

  // Simple string content
  if (typeof content === "string") {
    return { role, content };
  }

  // Array of content blocks
  if (!Array.isArray(content)) {
    return { role, content: String(content) };
  }

  if (role === "assistant") {
    return convertAssistantMessage(content);
  }

  if (role === "user") {
    return convertUserMessage(content);
  }

  return { role, content: content.map(b => b.text || "").join("") };
}

function convertAssistantMessage(blocks) {
  const textParts = [];
  const toolCalls = [];

  for (const block of blocks) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input || {}),
        },
      });
    }
  }

  const result = { role: "assistant" };
  if (textParts.length > 0) result.content = textParts.join("");
  else result.content = null;
  if (toolCalls.length > 0) result.tool_calls = toolCalls;

  return result;
}

function convertUserMessage(blocks) {
  const messages = [];
  const contentParts = [];
  const toolResults = [];

  for (const block of blocks) {
    if (block.type === "text") {
      contentParts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      // Anthropic image → OpenAI image_url
      if (block.source?.type === "base64") {
        contentParts.push({
          type: "image_url",
          image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
        });
      } else if (block.source?.type === "url") {
        contentParts.push({
          type: "image_url",
          image_url: { url: block.source.url },
        });
      }
    } else if (block.type === "tool_result") {
      toolResults.push(block);
    }
  }

  // Tool results become separate tool messages in OpenAI
  for (const tr of toolResults) {
    const resultContent = Array.isArray(tr.content)
      ? tr.content.map(b => b.text || "").join("")
      : (typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content));
    messages.push({
      role: "tool",
      tool_call_id: tr.tool_use_id,
      content: resultContent,
    });
  }

  // Regular content parts
  if (contentParts.length > 0) {
    if (contentParts.length === 1 && contentParts[0].type === "text") {
      messages.push({ role: "user", content: contentParts[0].text });
    } else {
      messages.push({ role: "user", content: contentParts });
    }
  }

  // If only tool results, no user content
  return messages.length === 1 ? messages[0] : messages;
}

/**
 * Convert Anthropic tool definition to OpenAI function calling format.
 */
function convertToolDef(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || { type: "object", properties: {} },
    },
  };
}

// ── Stream Conversion: OpenAI SSE → Anthropic SSE ──

/**
 * Read an OpenAI SSE stream, convert to Anthropic SSE format, and write to response.
 */
export async function convertOpenAIStreamToAnthropic(readableStream, res, model) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let contentBlockIndex = 0;
  let currentToolCalls = {}; // track tool_calls by index
  let hasStarted = false;
  let textBlockOpen = false;

  // Send message_start
  const messageId = `msg_${Date.now()}`;
  sendAnthropicEvent(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  hasStarted = true;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          // Close any open blocks
          if (textBlockOpen) {
            sendAnthropicEvent(res, "content_block_stop", { type: "content_block_stop", index: contentBlockIndex - 1 });
            textBlockOpen = false;
          }
          // Close any open tool blocks
          for (const idx of Object.keys(currentToolCalls)) {
            sendAnthropicEvent(res, "content_block_stop", { type: "content_block_stop", index: parseInt(idx) });
          }

          sendAnthropicEvent(res, "message_stop", { type: "message_stop" });
          continue;
        }

        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }

        // Usage info (some providers include in final chunk)
        if (parsed.usage) {
          sendAnthropicEvent(res, "message_delta", {
            type: "message_delta",
            delta: { stop_reason: null },
            usage: {
              input_tokens: parsed.usage.prompt_tokens || 0,
              output_tokens: parsed.usage.completion_tokens || 0,
            },
          });
        }

        const choice = parsed.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (!delta) continue;

        // Text content
        if (delta.content) {
          if (!textBlockOpen) {
            sendAnthropicEvent(res, "content_block_start", {
              type: "content_block_start",
              index: contentBlockIndex,
              content_block: { type: "text", text: "" },
            });
            textBlockOpen = true;
          }
          sendAnthropicEvent(res, "content_block_delta", {
            type: "content_block_delta",
            index: contentBlockIndex,
            delta: { type: "text_delta", text: delta.content },
          });
        }

        // Tool calls
        if (delta.tool_calls) {
          // Close text block if open
          if (textBlockOpen) {
            sendAnthropicEvent(res, "content_block_stop", { type: "content_block_stop", index: contentBlockIndex });
            contentBlockIndex++;
            textBlockOpen = false;
          }

          for (const tc of delta.tool_calls) {
            const tcIdx = tc.index ?? 0;
            const blockIdx = contentBlockIndex + tcIdx;

            if (!currentToolCalls[blockIdx]) {
              // New tool call — start block
              currentToolCalls[blockIdx] = {
                id: tc.id || `toolu_${Date.now()}_${tcIdx}`,
                name: tc.function?.name || "",
                arguments: "",
              };
              if (tc.id && tc.function?.name) {
                sendAnthropicEvent(res, "content_block_start", {
                  type: "content_block_start",
                  index: blockIdx,
                  content_block: {
                    type: "tool_use",
                    id: currentToolCalls[blockIdx].id,
                    name: tc.function.name,
                    input: {},
                  },
                });
              }
            }

            // Accumulate function name (sometimes streamed)
            if (tc.function?.name) {
              currentToolCalls[blockIdx].name += tc.function.name;
              // If we haven't sent start yet (name came in parts)
              if (tc.id) {
                currentToolCalls[blockIdx].id = tc.id;
              }
            }

            // Stream arguments
            if (tc.function?.arguments) {
              currentToolCalls[blockIdx].arguments += tc.function.arguments;
              sendAnthropicEvent(res, "content_block_delta", {
                type: "content_block_delta",
                index: blockIdx,
                delta: {
                  type: "input_json_delta",
                  partial_json: tc.function.arguments,
                },
              });
            }
          }
        }

        // Finish reason
        if (choice.finish_reason) {
          const stopReason = choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn";
          sendAnthropicEvent(res, "message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason },
            usage: { output_tokens: 0 },
          });
        }
      }
    }
  } catch (err) {
    sendAnthropicEvent(res, "error", {
      type: "error",
      error: { type: "api_error", message: `Stream error: ${err.message}` },
    });
  }
}

function sendAnthropicEvent(res, eventType, data) {
  try {
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Response may be closed
  }
}
