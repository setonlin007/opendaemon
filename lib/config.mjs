import { readFileSync, writeFileSync, existsSync, watch } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { getCategoryForType } from "./engine-registry.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

let cached = null;

export function needsSetup() {
  const configPath = join(ROOT, "config.json");
  if (!existsSync(configPath)) return true;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return !config.auth?.password || config.auth.password === "change-me";
  } catch { return true; }
}

export function createInitialConfig({ password, engines }) {
  const configPath = join(ROOT, "config.json");
  const config = {
    server: { host: "0.0.0.0", port: 3456 },
    auth: { password },
    engines: engines || [],
    mcp: {},
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  cached = null;
  return loadConfig();
}

export function loadConfig() {
  if (cached) return cached;

  const configPath = join(ROOT, "config.json");
  if (!existsSync(configPath)) {
    // Return minimal config for setup mode
    return { auth: {}, engines: [], server: { host: "0.0.0.0", port: 3456 }, mcp: {} };
  }

  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw);

  // Validate required fields
  if (!config.auth?.password) {
    throw new Error("config.json: auth.password is required");
  }
  if (!Array.isArray(config.engines)) config.engines = [];
  for (const engine of config.engines) {
    if (!engine.id || !engine.type || !engine.label) {
      throw new Error(
        `config.json: engine missing required fields (id, type, label): ${JSON.stringify(engine)}`
      );
    }
    if (engine.type === "openai" && !engine.provider?.baseUrl) {
      throw new Error(
        `config.json: openai engine "${engine.id}" requires provider.baseUrl`
      );
    }
  }

  // ── P5: Validate & apply defaults for advanced harness sections ──

  // sub_agents
  if (config.sub_agents !== undefined) {
    const sa = config.sub_agents;
    const validModes = ["auto", "explicit", "disabled"];
    if (sa.dispatch_mode && !validModes.includes(sa.dispatch_mode)) {
      throw new Error(`config.json: sub_agents.dispatch_mode must be one of: ${validModes.join(", ")}`);
    }
    if (sa.max_parallel !== undefined && (typeof sa.max_parallel !== "number" || sa.max_parallel < 1)) {
      throw new Error("config.json: sub_agents.max_parallel must be a positive number");
    }
    if (sa.max_tokens_per_agent !== undefined && (typeof sa.max_tokens_per_agent !== "number" || sa.max_tokens_per_agent < 1)) {
      throw new Error("config.json: sub_agents.max_tokens_per_agent must be a positive number");
    }
  }
  config.sub_agents = {
    dispatch_mode: "disabled",
    max_parallel: 3,
    max_tokens_per_agent: 4096,
    ...config.sub_agents,
  };

  // evaluator
  if (config.evaluator !== undefined) {
    const ev = config.evaluator;
    if (ev.enabled !== undefined && typeof ev.enabled !== "boolean") {
      throw new Error("config.json: evaluator.enabled must be a boolean");
    }
    if (ev.interval_ms !== undefined && (typeof ev.interval_ms !== "number" || ev.interval_ms < 10000)) {
      throw new Error("config.json: evaluator.interval_ms must be a number >= 10000");
    }
  }
  config.evaluator = {
    enabled: false,
    engine_id: null,
    interval_ms: 300000,
    ...config.evaluator,
  };

  // ab_testing
  if (config.ab_testing !== undefined) {
    const ab = config.ab_testing;
    if (ab.enabled !== undefined && typeof ab.enabled !== "boolean") {
      throw new Error("config.json: ab_testing.enabled must be a boolean");
    }
  }
  config.ab_testing = {
    enabled: false,
    ...config.ab_testing,
  };

  // self_coding
  if (config.self_coding !== undefined) {
    const sc = config.self_coding;
    if (sc.enabled !== undefined && typeof sc.enabled !== "boolean") {
      throw new Error("config.json: self_coding.enabled must be a boolean");
    }
    if (sc.auto_propose !== undefined && typeof sc.auto_propose !== "boolean") {
      throw new Error("config.json: self_coding.auto_propose must be a boolean");
    }
  }
  config.self_coding = {
    enabled: false,
    auto_propose: true,
    require_approval: true,
    ...config.self_coding,
  };

  // imagegen — 老格式 { comfyUrl, maxConcurrent, ... } 自动升级为
  // { default, providers[], limits } 的多 provider 格式
  migrateImagegen(config);

  cached = config;
  return config;
}

function migrateImagegen(config) {
  const ig = config.imagegen || {};
  if (Array.isArray(ig.providers)) {
    // 已是新格式
    config.imagegen = {
      default: ig.default || ig.providers[0]?.id || null,
      providers: ig.providers,
      limits: {
        maxConcurrent: ig.limits?.maxConcurrent ?? 1,
        maxPerHour:    ig.limits?.maxPerHour    ?? 10,
        maxPerDay:     ig.limits?.maxPerDay     ?? 50,
      },
    };
    return;
  }
  if (ig.comfyUrl) {
    // 旧格式：升级
    config.imagegen = {
      default: "default-comfyui",
      providers: [{
        id: "default-comfyui",
        type: "comfyui",
        url: ig.comfyUrl,
      }],
      limits: {
        maxConcurrent: ig.maxConcurrent ?? 1,
        maxPerHour:    ig.maxPerHour    ?? 10,
        maxPerDay:     ig.maxPerDay     ?? 50,
      },
    };
    return;
  }
  // 无 imagegen 配置：留空 providers（生图调用会明确报错）
  config.imagegen = {
    default: null,
    providers: [],
    limits: { maxConcurrent: 1, maxPerHour: 10, maxPerDay: 50 },
  };
}

export function reloadConfig() {
  cached = null;
  return loadConfig();
}

// ── Hot-reload: watch config.json for changes ──
let watchDebounce = null;
const configPath = join(ROOT, "config.json");
try {
  watch(configPath, () => {
    if (watchDebounce) return;
    watchDebounce = setTimeout(() => {
      watchDebounce = null;
      try {
        reloadConfig();
        console.log("[config] hot-reloaded config.json");
      } catch (err) {
        console.error("[config] hot-reload failed, keeping previous config:", err.message);
      }
    }, 500);
  });
} catch (err) {
  console.warn("[config] could not watch config.json:", err.message);
}

export function getEngineById(id) {
  const config = loadConfig();
  return config.engines.find((e) => e.id === id) || null;
}

export function getEngines() {
  const config = loadConfig();
  return config.engines.map(({ id, type, label, icon }) => ({
    id,
    type,
    category: getCategoryForType(type),
    label,
    icon,
  }));
}

// ── Engine full config with masked API key (for settings UI) ──

export function maskApiKey(key) {
  if (!key || typeof key !== "string") return "";
  if (key.length <= 8) return "***";
  return key.slice(0, 3) + "***" + key.slice(-4);
}

export function getEngineFullConfig(id) {
  const engine = getEngineById(id);
  if (!engine) return null;
  const result = JSON.parse(JSON.stringify(engine));
  result.category = getCategoryForType(result.type);
  // Mask API keys
  if (result.provider?.apiKey) {
    result.provider._hasApiKey = true;
    result.provider.apiKey = maskApiKey(result.provider.apiKey);
  }
  return result;
}

// ── Save engines to config.json ──

function validateEngine(engine) {
  if (!engine.id || !engine.type || !engine.label) {
    throw new Error(`Engine missing required fields (id, type, label): ${JSON.stringify(engine)}`);
  }
  if (engine.type === "openai" && !engine.provider?.baseUrl) {
    throw new Error(`OpenAI engine "${engine.id}" requires provider.baseUrl`);
  }
  // Auto-assign category
  if (!engine.category) {
    engine.category = getCategoryForType(engine.type);
  }
}

let writeLock = false;

export function saveEngines(engines) {
  if (writeLock) throw new Error("Config write already in progress");
  if (!Array.isArray(engines) || engines.length === 0) {
    throw new Error("At least one engine must be configured");
  }

  // Validate all engines before writing
  for (const engine of engines) {
    validateEngine(engine);
  }

  // Strip transient fields before persisting
  const cleanEngines = engines.map((e) => {
    const copy = JSON.parse(JSON.stringify(e));
    delete copy.category; // derived at runtime
    return copy;
  });

  try {
    writeLock = true;
    // Read fresh config from disk (not cache) to preserve other sections
    const raw = readFileSync(configPath, "utf-8");
    const diskConfig = JSON.parse(raw);
    diskConfig.engines = cleanEngines;
    writeFileSync(configPath, JSON.stringify(diskConfig, null, 2) + "\n", "utf-8");
    // fs.watch will trigger hot-reload automatically
    console.log(`[config] saved ${cleanEngines.length} engines to config.json`);
  } finally {
    writeLock = false;
  }

  // Force immediate reload (don't wait for fs.watch debounce)
  return reloadConfig();
}

/**
 * Merge updated fields into an existing engine, preserving unmasked API keys.
 * If apiKey field contains masked value (has ***), keep the original key.
 */
export function mergeEngineUpdate(existingEngine, updates) {
  const merged = { ...existingEngine, ...updates };
  // Preserve original API key if update contains masked value
  if (updates.provider && existingEngine.provider) {
    merged.provider = { ...existingEngine.provider, ...updates.provider };
    if (updates.provider.apiKey && updates.provider.apiKey.includes("***")) {
      merged.provider.apiKey = existingEngine.provider.apiKey;
    }
  }
  // ID is immutable
  merged.id = existingEngine.id;
  return merged;
}

export function getProjectRoot() {
  return ROOT;
}
