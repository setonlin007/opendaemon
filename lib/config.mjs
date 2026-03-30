import { readFileSync, existsSync, watch } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

let cached = null;

export function loadConfig() {
  if (cached) return cached;

  const configPath = join(ROOT, "config.json");
  if (!existsSync(configPath)) {
    throw new Error(
      "config.json not found. Copy config.example.json to config.json and edit it."
    );
  }

  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw);

  // Validate required fields
  if (!config.auth?.password) {
    throw new Error("config.json: auth.password is required");
  }
  if (!Array.isArray(config.engines) || config.engines.length === 0) {
    throw new Error("config.json: at least one engine must be configured");
  }
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

  cached = config;
  return config;
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
    label,
    icon,
  }));
}

export function getProjectRoot() {
  return ROOT;
}
