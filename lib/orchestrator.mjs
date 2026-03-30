/**
 * Phase 4: Sub-Agent Orchestrator
 *
 * Decomposes complex prompts into sub-tasks, dispatches them to
 * specialised sub-agents (researcher, analyst, coder, reviewer),
 * collects results in parallel, and synthesises a final answer.
 */

import { addSubAgentRun, updateSubAgentRun } from "./db.mjs";
import { loadConfig } from "./config.mjs";
import { loadAllAgentPrompts, loadPrompt } from "./prompts.mjs";

// ── Built-in agent type definitions ──
// Loaded from data/prompts/user/agents/*.md, with hardcoded fallback

const FALLBACK_AGENT_TYPES = {
  researcher: {
    label: "Researcher", icon: "🔍",
    systemPrompt: "You are a research assistant. Search the web and gather relevant information. Be thorough and cite sources.",
    allowedTools: ["web_search"], model: null,
  },
  analyst: {
    label: "Analyst", icon: "📊",
    systemPrompt: "You are an analytical assistant. Identify key patterns, trade-offs, and insights. Present structured analysis.",
    allowedTools: [], model: null,
  },
  coder: {
    label: "Coder", icon: "💻",
    systemPrompt: "You are a coding assistant. Write clean, well-documented code. Follow best practices and include error handling.",
    allowedTools: ["read_file", "write_file", "run_command"], model: null,
  },
  reviewer: {
    label: "Reviewer", icon: "🔎",
    systemPrompt: "You are a code/content reviewer. Review for correctness, quality, security issues, and improvements.",
    allowedTools: ["web_search"], model: null,
  },
};

// Load from files, merge with fallbacks
const fileAgents = loadAllAgentPrompts();
export const AGENT_TYPES = { ...FALLBACK_AGENT_TYPES, ...fileAgents };

// ── Dispatch commands for explicit mode ──
const EXPLICIT_COMMANDS = {
  "/research": "researcher",
  "/analyze": "analyst",
  "/analyse": "analyst",
  "/review": "reviewer",
  "/code": "coder",
};

/**
 * Determine whether a prompt should be decomposed into sub-agents.
 *
 * @param {string} prompt - User prompt
 * @param {object} config - Orchestrator config section
 * @returns {{ use: boolean, subtasks: Array<{ type: string, task: string }> }}
 */
export async function shouldDispatch(prompt, config = {}) {
  try {
    const mode = config.dispatch_mode || "disabled";

    if (mode === "disabled") {
      return { use: false, subtasks: [] };
    }

    // Explicit mode: check for slash commands
    if (mode === "explicit") {
      for (const [cmd, agentType] of Object.entries(EXPLICIT_COMMANDS)) {
        if (prompt.trim().startsWith(cmd)) {
          const task = prompt.trim().slice(cmd.length).trim();
          return {
            use: true,
            subtasks: [{ type: agentType, task: task || prompt }],
          };
        }
      }
      return { use: false, subtasks: [] };
    }

    // Auto mode: use LLM to decide (simplified heuristic for now)
    if (mode === "auto") {
      return autoDetectSubtasks(prompt, config);
    }

    return { use: false, subtasks: [] };
  } catch (err) {
    console.error("[orchestrator] shouldDispatch error:", err);
    return { use: false, subtasks: [] };
  }
}

/**
 * Heuristic-based auto detection of sub-tasks.
 * Future: call LLM for decomposition.
 */
function autoDetectSubtasks(prompt, _config) {
  try {
    const lower = prompt.toLowerCase();
    const subtasks = [];

    // Detect research needs
    const researchKeywords = ["search", "find", "look up", "what is", "搜索", "查找", "查一下", "了解"];
    if (researchKeywords.some((kw) => lower.includes(kw))) {
      subtasks.push({ type: "researcher", task: prompt });
    }

    // Detect analysis needs
    const analysisKeywords = ["analyze", "analyse", "compare", "evaluate", "分析", "对比", "评估"];
    if (analysisKeywords.some((kw) => lower.includes(kw))) {
      subtasks.push({ type: "analyst", task: prompt });
    }

    // Detect coding needs
    const codeKeywords = ["write code", "implement", "create function", "写代码", "实现", "编写"];
    if (codeKeywords.some((kw) => lower.includes(kw))) {
      subtasks.push({ type: "coder", task: prompt });
    }

    // Only dispatch if we detect multiple concerns (otherwise single agent is fine)
    if (subtasks.length >= 2) {
      return { use: true, subtasks };
    }

    return { use: false, subtasks: [] };
  } catch (err) {
    console.error("[orchestrator] autoDetectSubtasks error:", err);
    return { use: false, subtasks: [] };
  }
}

/**
 * Full orchestration: decompose → spawn sub-agents → synthesise.
 *
 * @param {string} prompt - Original user prompt
 * @param {object} conv - Conversation object { id, engine_id }
 * @param {object} engineCallFn - Async function(subAgentOpts) that calls the engine
 * @param {Function} onEvent - SSE event callback
 * @param {object} opts - Additional options
 * @returns {{ resultText: string, subAgentResults: Array }}
 */
export async function dispatch(prompt, conv, engineCallFn, onEvent, opts = {}) {
  try {
    const config = getOrchestratorConfig();
    const maxParallel = config.max_parallel || 3;

    // Step 1: Determine subtasks
    let subtasks = opts.subtasks;
    if (!subtasks) {
      const decision = await shouldDispatch(prompt, config);
      subtasks = decision.subtasks;
    }

    if (!subtasks || subtasks.length === 0) {
      throw new Error("No subtasks to dispatch");
    }

    onEvent?.({ type: "sub_agent_start", data: { total: subtasks.length, subtasks } });

    // Step 2: Spawn sub-agents (parallel with concurrency limit)
    const subAgentResults = [];
    for (let i = 0; i < subtasks.length; i += maxParallel) {
      const batch = subtasks.slice(i, i + maxParallel);
      const batchResults = await Promise.allSettled(
        batch.map((subtask, idx) =>
          spawnSubAgent(subtask, conv, engineCallFn, onEvent, {
            index: i + idx,
            parentTraceId: opts.parentTraceId,
          })
        )
      );

      for (const result of batchResults) {
        if (result.status === "fulfilled") {
          subAgentResults.push(result.value);
        } else {
          subAgentResults.push({
            type: "unknown",
            task: "failed",
            output: `Error: ${result.reason?.message || "Unknown error"}`,
            success: false,
          });
        }
      }
    }

    onEvent?.({
      type: "sub_agent_done",
      data: {
        total: subAgentResults.length,
        successful: subAgentResults.filter((r) => r.success).length,
      },
    });

    // Step 3: Synthesise results
    const resultText = await synthesizeResults(prompt, subAgentResults, engineCallFn, onEvent);

    return { resultText, subAgentResults };
  } catch (err) {
    console.error("[orchestrator] dispatch error:", err);
    throw err;
  }
}

/**
 * Spawn a single sub-agent.
 */
async function spawnSubAgent(subtask, conv, engineCallFn, onEvent, opts = {}) {
  const { type, task } = subtask;
  const agentDef = AGENT_TYPES[type];
  if (!agentDef) {
    throw new Error(`Unknown agent type: ${type}`);
  }

  const startTime = Date.now();

  // Record in DB
  const dbRecord = addSubAgentRun({
    parent_conv_id: conv.id,
    parent_trace_id: opts.parentTraceId || null,
    agent_type: type,
    agent_config: { allowedTools: agentDef.allowedTools },
    input_context: task,
    engine_id: conv.engine_id,
  });

  onEvent?.({
    type: "sub_agent_delta",
    data: { index: opts.index, agentType: type, label: agentDef.label, icon: agentDef.icon, status: "running" },
  });

  try {
    const config = getOrchestratorConfig();
    const maxTokens = config.max_tokens_per_agent || 4096;

    // Build sub-agent prompt
    const subPrompt = `${agentDef.systemPrompt}\n\n---\nTask: ${task}`;

    // Call engine
    const result = await engineCallFn({
      prompt: subPrompt,
      agentType: type,
      maxTokens,
      allowedTools: agentDef.allowedTools,
    });

    const duration = Date.now() - startTime;

    // Update DB record
    updateSubAgentRun(dbRecord.id, {
      status: "completed",
      output_result: result.text || "",
      input_tokens: result.inputTokens || null,
      output_tokens: result.outputTokens || null,
      estimated_cost: result.cost || null,
      duration_ms: duration,
      completed_at: Date.now(),
    });

    onEvent?.({
      type: "sub_agent_delta",
      data: { index: opts.index, agentType: type, status: "completed", duration },
    });

    return {
      type,
      task,
      output: result.text || "",
      success: true,
      duration,
      tokens: { input: result.inputTokens, output: result.outputTokens },
    };
  } catch (err) {
    const duration = Date.now() - startTime;

    updateSubAgentRun(dbRecord.id, {
      status: "failed",
      output_result: err.message,
      duration_ms: duration,
      completed_at: Date.now(),
    });

    onEvent?.({
      type: "sub_agent_delta",
      data: { index: opts.index, agentType: type, status: "failed", error: err.message },
    });

    return {
      type,
      task,
      output: `Error: ${err.message}`,
      success: false,
      duration,
    };
  }
}

/**
 * Synthesise sub-agent results into a final coherent response.
 */
async function synthesizeResults(originalPrompt, subAgentResults, engineCallFn, onEvent) {
  try {
    const successful = subAgentResults.filter((r) => r.success);
    const failed = subAgentResults.filter((r) => !r.success);

    if (successful.length === 0) {
      return "All sub-agents failed. Please try again or rephrase your request.";
    }

    // Build synthesis prompt
    let agentResults = "";
    for (const result of successful) {
      const agentDef = AGENT_TYPES[result.type] || { label: result.type };
      agentResults += `### ${agentDef.label} (${result.type})\n${result.output}\n\n`;
    }

    const failedNotes = failed.length > 0
      ? `\nNote: ${failed.length} sub-agent(s) failed: ${failed.map((f) => f.type).join(", ")}\n`
      : "";

    let synthesisPrompt = loadPrompt("synthesis", {
      original_prompt: originalPrompt,
      agent_results: agentResults,
      failed_notes: failedNotes,
    });

    // Fallback if prompt file is missing
    if (!synthesisPrompt) {
      synthesisPrompt = `Synthesise results for: ${originalPrompt}\n\n${agentResults}${failedNotes}\nProvide a comprehensive response.`;
    }

    const result = await engineCallFn({
      prompt: synthesisPrompt,
      agentType: "synthesizer",
      maxTokens: 8192,
      allowedTools: [],
    });

    return result.text || "";
  } catch (err) {
    console.error("[orchestrator] synthesizeResults error:", err);
    // Fallback: concatenate results
    const parts = subAgentResults
      .filter((r) => r.success)
      .map((r) => {
        const agentDef = AGENT_TYPES[r.type] || { label: r.type };
        return `**${agentDef.label}:**\n${r.output}`;
      });
    return parts.join("\n\n---\n\n");
  }
}

/**
 * Record a sub-agent run (convenience re-export).
 */
export function recordSubAgentRun(data) {
  return addSubAgentRun(data);
}

/**
 * Get orchestrator config from the main config.
 */
export function getOrchestratorConfig() {
  try {
    const config = loadConfig();
    return config.sub_agents || {
      dispatch_mode: "disabled",
      max_parallel: 3,
      max_tokens_per_agent: 4096,
    };
  } catch (err) {
    return {
      dispatch_mode: "disabled",
      max_parallel: 3,
      max_tokens_per_agent: 4096,
    };
  }
}
