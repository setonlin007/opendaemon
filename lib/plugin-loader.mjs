/**
 * Plugin Loader — discovers and loads engine plugins from plugins/ directory.
 *
 * Convention: plugins/engine-{name}/index.mjs
 * Each plugin must export: metadata, handleChat
 * Optional exports: streamSimple, test, getCommands, init, destroy
 */

import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { registerEngine } from "./engine-registry.mjs";
import { getProjectRoot } from "./config.mjs";

const PLUGINS_DIR = join(getProjectRoot(), "plugins");

/**
 * Scan plugins/ directory and load all engine plugins.
 * Broken plugins log errors but do not crash the server.
 */
export async function loadPlugins() {
  if (!existsSync(PLUGINS_DIR)) {
    console.log("[plugins] no plugins/ directory found, skipping");
    return;
  }

  let dirs;
  try {
    dirs = readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("engine-"))
      .map((d) => d.name);
  } catch (err) {
    console.error("[plugins] failed to scan plugins/:", err.message);
    return;
  }

  if (dirs.length === 0) {
    console.log("[plugins] no engine plugins found");
    return;
  }

  console.log(`[plugins] found ${dirs.length} plugin(s): ${dirs.join(", ")}`);

  for (const dir of dirs) {
    const indexPath = join(PLUGINS_DIR, dir, "index.mjs");
    if (!existsSync(indexPath)) {
      console.warn(`[plugins] ${dir}: missing index.mjs, skipping`);
      continue;
    }

    try {
      // Dynamic import using file URL (required for ES modules)
      const mod = await import(pathToFileURL(indexPath).href);

      // Validate required exports
      if (!mod.metadata?.type) {
        console.error(`[plugins] ${dir}: missing metadata.type, skipping`);
        continue;
      }
      if (typeof mod.handleChat !== "function") {
        console.error(`[plugins] ${dir}: missing handleChat function, skipping`);
        continue;
      }

      // Build plugin object from module exports
      const plugin = {
        metadata: mod.metadata,
        handleChat: mod.handleChat,
        streamSimple: mod.streamSimple || null,
        test: mod.test || null,
        getCommands: mod.getCommands || null,
        init: mod.init || null,
        destroy: mod.destroy || null,
      };

      // Call init if provided
      if (plugin.init) {
        await plugin.init();
      }

      registerEngine(plugin);
    } catch (err) {
      console.error(`[plugins] ${dir}: failed to load:`, err.message);
    }
  }
}
