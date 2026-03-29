/**
 * MCPManager — manages a long-running MCP Server subprocess.
 *
 * Spawns the Python MCP Server, communicates via stdin/stdout JSON-RPC,
 * and provides tool listing + calling APIs for the OpenAI engine.
 *
 * Claude SDK engine uses its own native MCP support and does NOT go through this.
 */

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createInterface } from "readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 30000;

export class MCPManager {
  constructor(serverConfig, channelsConfig) {
    this._serverConfig = serverConfig;
    this._channelsConfig = channelsConfig || {};
    this._process = null;
    this._readline = null;
    this._requestId = 0;
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._tools = null; // cached tool list
    this._restartCount = 0;
    this._stopping = false;
  }

  /** Start the MCP Server subprocess. */
  async start() {
    if (this._process) return;

    const cmd = this._serverConfig.command || "python";
    const args = this._serverConfig.args || ["mcp/server.py"];
    const env = {
      ...process.env,
      ...(this._serverConfig.env || {}),
      OPENDAEMON_CHANNELS: JSON.stringify(this._channelsConfig),
    };

    this._process = spawn(cmd, args, {
      cwd: ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Read stderr for logging
    this._process.stderr?.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) console.log(`[mcp-server] ${msg}`);
    });

    // Line-buffered stdout parsing for JSON-RPC responses
    this._readline = createInterface({ input: this._process.stdout });
    this._readline.on("line", (line) => {
      this._handleLine(line);
    });

    this._process.on("exit", (code) => {
      console.log(`[mcp] process exited with code ${code}`);
      this._cleanup();
      if (!this._stopping && this._restartCount < MAX_RESTARTS) {
        this._restartCount++;
        console.log(`[mcp] restarting (attempt ${this._restartCount}/${MAX_RESTARTS})...`);
        setTimeout(() => this.start().catch(console.error), RESTART_DELAY_MS);
      }
    });

    // Initialize the MCP connection
    await this._initialize();
    console.log("[mcp] server started and initialized");
  }

  /** Send initialize request per MCP spec. */
  async _initialize() {
    await this._request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "opendaemon", version: "0.1.0" },
    });
    // Send initialized notification (no response expected)
    this._send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  /** Get tool list (cached after first call). */
  async listTools() {
    if (this._tools) return this._tools;
    const result = await this._request("tools/list", {});
    this._tools = result.tools || [];
    return this._tools;
  }

  /** Call a tool by name with arguments. Returns content array. */
  async callTool(name, args) {
    const result = await this._request("tools/call", {
      name,
      arguments: args,
    });
    if (result.content) {
      return result.content.map((c) => c.text || JSON.stringify(c)).join("\n");
    }
    return JSON.stringify(result);
  }

  /** Stop the subprocess. */
  async stop() {
    this._stopping = true;
    if (this._process) {
      this._process.kill("SIGTERM");
      // Force kill after 3s
      const timer = setTimeout(() => {
        if (this._process) this._process.kill("SIGKILL");
      }, 3000);
      this._process.on("exit", () => clearTimeout(timer));
    }
    this._cleanup();
  }

  // ── Internal ──

  _send(obj) {
    if (!this._process?.stdin?.writable) return;
    this._process.stdin.write(JSON.stringify(obj) + "\n");
  }

  _request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this._requestId;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this._pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }

  _handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // not JSON, ignore
    }

    // JSON-RPC response
    if (msg.id != null && this._pending.has(msg.id)) {
      const { resolve, reject, timer } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(timer);

      if (msg.error) {
        reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        resolve(msg.result);
      }
    }
  }

  _cleanup() {
    // Reject all pending requests
    for (const [id, { reject, timer }] of this._pending) {
      clearTimeout(timer);
      reject(new Error("MCP server disconnected"));
    }
    this._pending.clear();
    this._tools = null;
    this._readline = null;
    this._process = null;
  }
}
