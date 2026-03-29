/**
 * Phase 4: Self-Coder Module
 *
 * Detects repeating patterns from reflection insights that could be
 * automated with a new MCP tool, then generates, validates, and
 * installs the tool code.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import {
  addSelfCodedTool,
  updateSelfCodedTool,
  getSelfCodedTool,
  getSelfCodedToolByName,
  listSelfCodedTools as dbListSelfCodedTools,
} from "./db.mjs";
import { getProjectRoot } from "./config.mjs";

/**
 * Analyse reflection insights for patterns suggesting a new tool.
 *
 * @param {Array} traces - Recent traces
 * @param {Array} insights - Reflection insights
 * @returns {{ detected: boolean, pattern: string|null, suggestion: string|null }}
 */
export function detectAutomationOpportunity(traces, insights) {
  try {
    if (!insights || insights.length === 0) {
      return { detected: false, pattern: null, suggestion: null };
    }

    // Look for automation-category insights
    const automationInsights = insights.filter(
      (i) => i.category === "automation" || (i.tags && i.tags.includes("automation"))
    );

    if (automationInsights.length > 0) {
      const insight = automationInsights[0];
      return {
        detected: true,
        pattern: insight.content || insight.title,
        suggestion: `Create tool based on: ${insight.title}`,
      };
    }

    // Heuristic: detect repeated tool usage patterns
    if (traces && traces.length > 0) {
      const toolSequences = {};
      for (const trace of traces) {
        try {
          const tools = trace.tools_used ? JSON.parse(trace.tools_used) : [];
          if (tools.length >= 2) {
            const key = tools.map((t) => t.name).join(" → ");
            toolSequences[key] = (toolSequences[key] || 0) + 1;
          }
        } catch {}
      }

      // Find sequences that repeat 3+ times
      for (const [sequence, count] of Object.entries(toolSequences)) {
        if (count >= 3) {
          return {
            detected: true,
            pattern: `Repeated tool sequence (${count}x): ${sequence}`,
            suggestion: `Create a combined tool for: ${sequence}`,
          };
        }
      }
    }

    return { detected: false, pattern: null, suggestion: null };
  } catch (err) {
    console.error("[self-coder] detectAutomationOpportunity error:", err);
    return { detected: false, pattern: null, suggestion: null };
  }
}

/**
 * Propose a new tool based on a detected pattern.
 *
 * @param {string} pattern - The detected pattern description
 * @param {Array} traces - Related traces for context
 * @param {object} engineConfig - Engine config for LLM call
 * @returns {object} The proposed tool record
 */
export async function proposeTool(pattern, traces = [], engineConfig = null) {
  try {
    // For now, create a proposal stub; full LLM-based design comes in integration
    const toolName = generateToolName(pattern);

    // Check if already proposed
    const existing = getSelfCodedToolByName(toolName);
    if (existing) {
      return existing;
    }

    const record = addSelfCodedTool({
      tool_name: toolName,
      description: `Auto-proposed tool for pattern: ${pattern}`,
      input_schema: { type: "object", properties: { input: { type: "string", description: "Input for the tool" } } },
      code: null, // Will be generated later
      origin_pattern: pattern,
    });

    console.log(`[self-coder] Proposed new tool: ${toolName}`);
    return { ...record, tool_name: toolName };
  } catch (err) {
    console.error("[self-coder] proposeTool error:", err);
    throw err;
  }
}

/**
 * Generate tool code for a proposed tool.
 *
 * @param {number} toolId - ID of the self_coded_tools record
 * @param {object} engineConfig - Engine config for LLM call
 * @returns {string} The generated code
 */
export async function generateToolCode(toolId, engineConfig = null) {
  try {
    const tool = getSelfCodedTool(toolId);
    if (!tool) throw new Error(`Tool ${toolId} not found`);

    // Load example tool as template
    const examplePath = join(getProjectRoot(), "mcp", "tools", "web_search.py");
    let exampleCode = "";
    if (existsSync(examplePath)) {
      exampleCode = readFileSync(examplePath, "utf-8");
    }

    // Generate stub code following the pattern
    const code = generateToolStub(tool.tool_name, tool.description, tool.input_schema, exampleCode);

    updateSelfCodedTool(toolId, { code, status: "generated" });
    return code;
  } catch (err) {
    console.error("[self-coder] generateToolCode error:", err);
    throw err;
  }
}

/**
 * Generate a Python tool stub following MCP tool conventions.
 */
function generateToolStub(name, description, inputSchema, exampleCode) {
  const schemaStr = JSON.stringify(inputSchema || {}, null, 2);
  return `"""
${description || name}

Auto-generated tool by OpenDaemon self-coder.
"""

from mcp.server.fastmcp import FastMCP

Tool = {
    "name": "${name}",
    "description": "${(description || "").replace(/"/g, '\\"')}",
    "inputSchema": ${schemaStr}
}

async def handler(arguments: dict) -> str:
    """Handle tool invocation."""
    try:
        input_val = arguments.get("input", "")
        # TODO: Implement tool logic
        return f"Tool ${name} executed with input: {input_val}"
    except Exception as e:
        return f"Error: {str(e)}"
`;
}

/**
 * Validate a self-coded tool through multi-step checks.
 *
 * @param {number} toolId
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateTool(toolId) {
  try {
    const tool = getSelfCodedTool(toolId);
    if (!tool) throw new Error(`Tool ${toolId} not found`);
    if (!tool.code) throw new Error("Tool has no code to validate");

    const errors = [];

    // Step 1: Python syntax check
    try {
      execSync(`python3 -c "import ast; ast.parse('''${tool.code.replace(/'/g, "\\'")}''')"`, {
        timeout: 10000,
        stdio: "pipe",
      });
    } catch (err) {
      errors.push(`Syntax error: ${err.stderr?.toString() || err.message}`);
    }

    // Step 2: Check for required elements (Tool dict and handler function)
    if (!tool.code.includes("Tool =")) {
      errors.push("Missing 'Tool' definition");
    }
    if (!tool.code.includes("async def handler")) {
      errors.push("Missing 'async def handler' function");
    }

    const valid = errors.length === 0;
    updateSelfCodedTool(toolId, {
      test_result: JSON.stringify({ valid, errors }),
      status: valid ? "validated" : "failed_validation",
    });

    return { valid, errors };
  } catch (err) {
    console.error("[self-coder] validateTool error:", err);
    return { valid: false, errors: [err.message] };
  }
}

/**
 * Install a validated tool into the MCP tools directory.
 *
 * @param {number} toolId
 */
export function installTool(toolId) {
  try {
    const tool = getSelfCodedTool(toolId);
    if (!tool) throw new Error(`Tool ${toolId} not found`);
    if (!tool.code) throw new Error("Tool has no code");

    const toolsDir = join(getProjectRoot(), "mcp", "tools");
    if (!existsSync(toolsDir)) {
      mkdirSync(toolsDir, { recursive: true });
    }

    // Write tool file
    const filePath = join(toolsDir, `${tool.tool_name}.py`);
    writeFileSync(filePath, tool.code, "utf-8");

    // Update __init__.py to register the tool
    const initPath = join(toolsDir, "__init__.py");
    if (existsSync(initPath)) {
      let initContent = readFileSync(initPath, "utf-8");
      const importLine = `from .${tool.tool_name} import Tool as ${tool.tool_name}_tool, handler as ${tool.tool_name}_handler`;
      if (!initContent.includes(importLine)) {
        initContent += `\n${importLine}\n`;
        writeFileSync(initPath, initContent, "utf-8");
      }
    }

    updateSelfCodedTool(toolId, {
      status: "installed",
      installed_at: Date.now(),
    });

    console.log(`[self-coder] Installed tool: ${tool.tool_name} at ${filePath}`);
    return { installed: true, path: filePath };
  } catch (err) {
    console.error("[self-coder] installTool error:", err);
    throw err;
  }
}

/**
 * Disable an installed tool (remove from registry, keep file).
 */
export function disableTool(toolId) {
  try {
    const tool = getSelfCodedTool(toolId);
    if (!tool) throw new Error(`Tool ${toolId} not found`);

    const toolsDir = join(getProjectRoot(), "mcp", "tools");
    const initPath = join(toolsDir, "__init__.py");

    if (existsSync(initPath)) {
      let initContent = readFileSync(initPath, "utf-8");
      const importLine = `from .${tool.tool_name} import Tool as ${tool.tool_name}_tool, handler as ${tool.tool_name}_handler`;
      initContent = initContent.replace(importLine + "\n", "");
      initContent = initContent.replace(importLine, "");
      writeFileSync(initPath, initContent, "utf-8");
    }

    updateSelfCodedTool(toolId, { status: "disabled" });
    console.log(`[self-coder] Disabled tool: ${tool.tool_name}`);
  } catch (err) {
    console.error("[self-coder] disableTool error:", err);
    throw err;
  }
}

/**
 * Re-enable a disabled tool.
 */
export function enableTool(toolId) {
  try {
    const tool = getSelfCodedTool(toolId);
    if (!tool) throw new Error(`Tool ${toolId} not found`);

    // Re-add to __init__.py
    installTool(toolId);
    // installTool already updates status to 'installed'
  } catch (err) {
    console.error("[self-coder] enableTool error:", err);
    throw err;
  }
}

/**
 * List self-coded tools with optional status filter.
 */
export function listSelfCodedTools(status) {
  return dbListSelfCodedTools(status);
}

/**
 * Get full detail of a self-coded tool.
 */
export function getToolDetail(toolId) {
  return getSelfCodedTool(toolId);
}

/**
 * Generate a snake_case tool name from a pattern description.
 */
function generateToolName(pattern) {
  return pattern
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "_")
    .substring(0, 40)
    .replace(/_+$/, "");
}
