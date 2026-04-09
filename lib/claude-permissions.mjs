/**
 * Claude Code tool permissions — read/write ~/.claude/settings.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

export const KNOWN_TOOLS = [
  { name: "Bash",         description: "Execute Shell commands",    descZh: "执行 Shell 命令" },
  { name: "Edit",         description: "Edit existing files",       descZh: "编辑已有文件" },
  { name: "Write",        description: "Create new files",          descZh: "创建新文件" },
  { name: "Read",         description: "Read file contents",        descZh: "读取文件内容" },
  { name: "Glob",         description: "Search files by pattern",   descZh: "按模式搜索文件" },
  { name: "Grep",         description: "Search file contents",      descZh: "搜索文件内容" },
  { name: "WebFetch",     description: "Fetch web content",         descZh: "获取网页内容" },
  { name: "WebSearch",    description: "Search the internet",       descZh: "搜索互联网" },
  { name: "NotebookEdit", description: "Edit Jupyter notebooks",    descZh: "编辑 Jupyter 笔记本" },
];

export const PRESETS = {
  all:      KNOWN_TOOLS.map(t => t.name),
  readonly: ["Read", "Glob", "Grep", "WebSearch"],
};

function readSettings() {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  const dir = join(homedir(), ".claude");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf-8");
}

/**
 * Get current permissions from ~/.claude/settings.json
 * Returns { tools: [{ name, description, descZh, allowed }], customRules: string[] }
 */
export function getPermissions() {
  const settings = readSettings();
  const allowList = settings.permissions?.allow || [];

  // Separate known tool rules from custom/unknown rules
  const knownPatterns = new Set(KNOWN_TOOLS.map(t => `${t.name}(*)`));
  const customRules = allowList.filter(r => !knownPatterns.has(r) && !KNOWN_TOOLS.some(t => r === t.name));

  const tools = KNOWN_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    descZh: t.descZh,
    allowed: allowList.some(r => r === `${t.name}(*)` || r === t.name),
  }));

  return { tools, customRules };
}

/**
 * Set permissions — writes tool allow list to ~/.claude/settings.json
 * Preserves custom rules and other settings fields.
 * @param {string[]} toolNames — names of tools to allow (e.g. ["Bash", "Read"])
 */
export function setPermissions(toolNames) {
  const settings = readSettings();
  const existingAllow = settings.permissions?.allow || [];

  // Keep custom rules (rules not matching any known tool pattern)
  const knownNames = new Set(KNOWN_TOOLS.map(t => t.name));
  const customRules = existingAllow.filter(r => {
    const match = r.match(/^(\w+)\(\*\)$/);
    if (match) return !knownNames.has(match[1]);
    return !knownNames.has(r);
  });

  // Build new allow list: selected tools + preserved custom rules
  const newAllow = [
    ...toolNames.map(n => `${n}(*)`),
    ...customRules,
  ];

  settings.permissions = { ...settings.permissions, allow: newAllow };
  writeSettings(settings);
}

/**
 * Ensure settings.json has default permissions (all tools allowed).
 * Called on server startup. Does NOT overwrite existing permissions.
 */
export function ensureDefaultPermissions() {
  const settings = readSettings();
  if (settings.permissions?.allow?.length > 0) return; // already configured
  settings.permissions = { ...settings.permissions, allow: PRESETS.all.map(n => `${n}(*)`) };
  writeSettings(settings);
  console.log("[permissions] wrote default permissions (all tools allowed)");
}
