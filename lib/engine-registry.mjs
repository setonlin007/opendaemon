/**
 * Engine Type Registry — maps engine type strings to handler objects.
 *
 * Built-in 'openai' is registered by server.mjs at startup.
 * Plugins register themselves via plugin-loader.mjs.
 */

const registry = new Map();

/**
 * Register an engine handler.
 * @param {object} plugin
 * @param {object} plugin.metadata - { type, name, description, category }
 * @param {Function} plugin.handleChat - (conv, engine, prompt, onEvent, abortSignal, injectedContext, attachments, deps) => Promise
 * @param {Function} [plugin.streamSimple] - ({ prompt, engineConfig, onEvent, abortSignal }) => Promise
 * @param {Function} [plugin.test] - (engine) => Promise<{ ok, error?, latency_ms?, note? }>
 * @param {Function} [plugin.getCommands] - () => Promise<object>
 * @param {Function} [plugin.init] - () => Promise<void>
 * @param {Function} [plugin.destroy] - () => Promise<void>
 */
export function registerEngine(plugin) {
  if (!plugin?.metadata?.type) {
    throw new Error("Plugin must have metadata.type");
  }
  if (typeof plugin.handleChat !== "function") {
    throw new Error(`Plugin "${plugin.metadata.type}" must export handleChat function`);
  }
  const { type } = plugin.metadata;
  if (registry.has(type)) {
    console.warn(`[registry] overwriting engine type: ${type}`);
  }
  registry.set(type, plugin);
  console.log(`[registry] registered engine type: ${type} (${plugin.metadata.category || "unknown"})`);
}

/**
 * Get the handler object for an engine type.
 */
export function getEngineHandler(type) {
  return registry.get(type) || null;
}

/**
 * Get all registered type strings.
 */
export function getRegisteredTypes() {
  return [...registry.keys()];
}

/**
 * Get the category for an engine type from the registry.
 * Falls back to 'api' for unregistered types.
 */
export function getCategoryForType(type) {
  const handler = registry.get(type);
  return handler?.metadata?.category || "api";
}

/**
 * Get all registered plugins metadata.
 */
export function getRegisteredEngines() {
  return [...registry.values()].map((p) => p.metadata);
}
