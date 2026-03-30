// lib/prompts.mjs — Centralized prompt management
//
// All prompts live in data/prompts/ as Markdown files with YAML frontmatter.
// Two tiers:
//   _system/  → immutable, always appended, cannot be overridden
//   user/     → configurable, can be overridden via A/B testing
//
// Usage:
//   import { loadPrompt, loadSystemPrompt, loadAgentPrompt } from "./prompts.mjs";
//   const prompt = loadPrompt("reflection", { goals: "...", traces: "..." });
//   const safety = loadSystemPrompt("safety");

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { getProjectRoot } from "./config.mjs";

const PROMPTS_DIR = () => join(getProjectRoot(), "data", "prompts");
const SYSTEM_DIR = () => join(PROMPTS_DIR(), "_system");
const USER_DIR = () => join(PROMPTS_DIR(), "user");

// Cache parsed prompts (cleared on reload)
const cache = new Map();

/**
 * Parse a prompt Markdown file: extract YAML frontmatter and body content.
 */
function parsePromptFile(filePath) {
  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, "utf-8");
  const result = { meta: {}, body: "" };

  // Parse YAML frontmatter
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (fmMatch) {
    // Simple YAML parsing (key: value per line)
    for (const line of fmMatch[1].split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.substring(0, colonIdx).trim();
        let val = line.substring(colonIdx + 1).trim();
        // Parse arrays: [a, b, c]
        if (val.startsWith("[") && val.endsWith("]")) {
          val = val.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
        }
        result.meta[key] = val;
      }
    }
    result.body = fmMatch[2].trim();
  } else {
    result.body = raw.trim();
  }

  return result;
}

/**
 * Load a user-configurable prompt by name.
 * Supports variable substitution: {variable_name} → value
 *
 * @param {string} name - Prompt name (e.g., "reflection", "judge", "synthesis")
 * @param {object} vars - Variables to substitute (e.g., { goals: "...", traces: "..." })
 * @returns {string} The rendered prompt body, or empty string if not found
 */
export function loadPrompt(name, vars = {}) {
  const filePath = join(USER_DIR(), `${name}.md`);

  // Check for A/B override first
  try {
    const overridePath = join(getProjectRoot(), "data", `${name}_prompt_override.md`);
    if (existsSync(overridePath)) {
      const overrideContent = readFileSync(overridePath, "utf-8").trim();
      if (overrideContent) {
        return substituteVars(overrideContent, vars);
      }
    }
  } catch (_) {}

  const parsed = parsePromptFile(filePath);
  if (!parsed) return "";

  return substituteVars(parsed.body, vars);
}

/**
 * Load a system-level prompt (immutable, cannot be overridden).
 *
 * @param {string} name - System prompt name (e.g., "platform", "safety")
 * @param {object} vars - Variables to substitute
 * @returns {string} The rendered prompt body, or empty string if not found
 */
export function loadSystemPrompt(name, vars = {}) {
  const filePath = join(SYSTEM_DIR(), `${name}.md`);
  const parsed = parsePromptFile(filePath);
  if (!parsed) return "";
  return substituteVars(parsed.body, vars);
}

/**
 * Load an agent prompt by agent type name.
 * Returns both the prompt body and metadata (label, icon, allowed_tools).
 *
 * @param {string} agentType - Agent type (e.g., "researcher", "analyst")
 * @returns {{ body: string, meta: object } | null}
 */
export function loadAgentPrompt(agentType) {
  const filePath = join(USER_DIR(), "agents", `${agentType}.md`);
  const parsed = parsePromptFile(filePath);
  if (!parsed) return null;
  return { body: parsed.body, meta: parsed.meta };
}

/**
 * Load all agent prompts and return as AGENT_TYPES-compatible map.
 * Falls back to inline defaults if files don't exist.
 */
export function loadAllAgentPrompts() {
  const agentsDir = join(USER_DIR(), "agents");
  const result = {};

  try {
    if (!existsSync(agentsDir)) return result;

    const files = readdirSync(agentsDir).filter(f => f.endsWith(".md"));
    for (const file of files) {
      const name = file.replace(".md", "");
      const parsed = parsePromptFile(join(agentsDir, file));
      if (parsed) {
        let allowedTools = parsed.meta.allowed_tools || [];
        if (typeof allowedTools === "string") {
          allowedTools = allowedTools.startsWith("[")
            ? allowedTools.slice(1, -1).split(",").map(s => s.trim())
            : [allowedTools];
        }
        result[name] = {
          label: parsed.meta.label || name,
          icon: parsed.meta.icon || "🤖",
          systemPrompt: parsed.body,
          allowedTools,
          model: null,
        };
      }
    }
  } catch (err) {
    console.warn("[prompts] failed to load agent prompts:", err.message);
  }

  return result;
}

/**
 * Get metadata for a prompt file.
 */
export function getPromptMeta(name, tier = "user") {
  const dir = tier === "_system" ? SYSTEM_DIR() : USER_DIR();
  const filePath = join(dir, `${name}.md`);
  const parsed = parsePromptFile(filePath);
  return parsed?.meta || null;
}

/**
 * List all available prompts with their metadata.
 */
export function listPrompts() {
  const result = { system: [], user: [] };

  try {
    // System prompts
    const sysDir = SYSTEM_DIR();
    if (existsSync(sysDir)) {
      for (const file of readdirSync(sysDir).filter(f => f.endsWith(".md"))) {
        const parsed = parsePromptFile(join(sysDir, file));
        result.system.push({
          name: file.replace(".md", ""),
          ...parsed?.meta,
          tier: "_system",
        });
      }
    }

    // User prompts (top-level)
    const usrDir = USER_DIR();
    if (existsSync(usrDir)) {
      for (const file of readdirSync(usrDir).filter(f => f.endsWith(".md"))) {
        const parsed = parsePromptFile(join(usrDir, file));
        result.user.push({
          name: file.replace(".md", ""),
          ...parsed?.meta,
          tier: "user",
        });
      }
    }

    // User prompts (agents/)
    const agentsDir = join(usrDir, "agents");
    if (existsSync(agentsDir)) {
      for (const file of readdirSync(agentsDir).filter(f => f.endsWith(".md"))) {
        const parsed = parsePromptFile(join(agentsDir, file));
        result.user.push({
          name: `agents/${file.replace(".md", "")}`,
          ...parsed?.meta,
          tier: "user/agents",
        });
      }
    }
  } catch (err) {
    console.warn("[prompts] listPrompts error:", err.message);
  }

  return result;
}

/**
 * Substitute {variable} placeholders in a prompt template.
 */
function substituteVars(template, vars = {}) {
  if (!vars || Object.keys(vars).length === 0) return template;

  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return vars.hasOwnProperty(key) ? vars[key] : match;
  });
}
