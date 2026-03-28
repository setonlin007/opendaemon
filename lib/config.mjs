import { readFileSync, existsSync } from "fs";
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

  cached = config;
  return config;
}

export function reloadConfig() {
  cached = null;
  return loadConfig();
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
