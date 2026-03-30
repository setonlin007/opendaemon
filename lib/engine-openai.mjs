const MAX_TOOL_ITERATIONS = 10;

/**
 * Stream chat completion from an OpenAI-compatible API.
 * Supports function calling with a tool-use loop.
 *
 * @param {object} params
 * @param {Array} params.messages - [{role, content}, ...]
 * @param {object} params.engineConfig - {provider: {baseUrl, apiKey, model}}
 * @param {Array} [params.tools] - OpenAI function calling tools
 * @param {Function} [params.onToolCall] - async (name, args) => result string
 * @param {Function} params.onEvent - (eventType, data) => void
 * @param {AbortSignal} [params.abortSignal]
 */
export async function streamOpenAI({
  messages,
  engineConfig,
  tools,
  onToolCall,
  onEvent,
  abortSignal,
}) {
  const { baseUrl, apiKey, model } = engineConfig.provider;
  let currentMessages = [...messages];
  let totalUsage = { input_tokens: 0, output_tokens: 0 };
  let iterations = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    const hasTools = tools?.length > 0 && onToolCall;

    const body = {
      model,
      messages: currentMessages,
      stream: true,
    };
    if (hasTools) body.tools = tools;

    // Debug: log request summary
    console.log(`[openai] request: model=${model} messages=${currentMessages.length} tools=${body.tools?.length || 0} system=${currentMessages[0]?.role === 'system' ? 'yes' : 'no'}`);

    let response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: abortSignal,
      });
    } catch (err) {
      if (err.name === "AbortError") return;
      onEvent("error", { message: `API request failed: ${err.message}` });
      return;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      onEvent("error", {
        message: `API error ${response.status}: ${errorText.substring(0, 200)}`,
      });
      return;
    }

    const result = await parseSSEStream(response, onEvent, abortSignal);

    if (abortSignal?.aborted) return;

    // Accumulate usage
    if (result.usage) {
      totalUsage.input_tokens += result.usage.prompt_tokens || 0;
      totalUsage.output_tokens += result.usage.completion_tokens || 0;
    }

    // If model made tool calls, execute them and continue loop
    if (result.toolCalls?.length > 0 && onToolCall) {
      // Add assistant message with tool calls
      currentMessages.push({
        role: "assistant",
        content: result.text || null,
        tool_calls: result.toolCalls,
      });

      // Execute each tool call
      for (const tc of result.toolCalls) {
        onEvent("tool_use", {
          name: tc.function.name,
          id: tc.id,
          input: safeParseJSON(tc.function.arguments),
        });

        let toolResult;
        try {
          toolResult = await onToolCall(
            tc.function.name,
            safeParseJSON(tc.function.arguments)
          );
        } catch (err) {
          toolResult = `Error: ${err.message}`;
        }

        currentMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
        });
      }

      // Continue loop — model will see tool results
      continue;
    }

    // No tool calls — we're done
    onEvent("result", {
      subtype: "success",
      usage: totalUsage,
      result: result.text,
    });
    return { resultText: result.text };
  }

  // Hit max iterations
  onEvent("result", {
    subtype: "success",
    usage: totalUsage,
    result: "[max tool iterations reached]",
  });
}

/**
 * Parse an SSE stream from OpenAI-compatible API.
 * Emits delta events and returns the accumulated result.
 */
async function parseSSEStream(response, onEvent, abortSignal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let toolCalls = [];
  let usage = null;

  try {
    while (true) {
      if (abortSignal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        // Extract usage if present (some providers include it)
        if (parsed.usage) usage = parsed.usage;

        const choice = parsed.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (!delta) continue;

        // Text content
        if (delta.content) {
          text += delta.content;
          onEvent("delta", { text: delta.content });
        }

        // Reasoning/thinking (DeepSeek R1 style)
        if (delta.reasoning_content) {
          onEvent("thinking_delta", { text: delta.reasoning_content });
        }

        // Tool calls (accumulated across deltas)
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: tc.id || "",
                type: "function",
                function: { name: "", arguments: "" },
              };
            }
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name)
              toolCalls[idx].function.name += tc.function.name;
            if (tc.function?.arguments)
              toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      onEvent("error", { message: `Stream error: ${err.message}` });
    }
  }

  // Emit complete text if we have any
  if (text) onEvent("text", { text });

  return { text, toolCalls: toolCalls.filter(Boolean), usage };
}

function safeParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}
