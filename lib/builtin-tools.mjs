/**
 * Built-in tools for Type B (API) engines.
 * Provides basic agent capabilities that Agentic engines (Claude SDK) have natively.
 *
 * These tools are merged with MCP tools and passed to the model via OpenAI function calling.
 * The tool-use loop in engine-openai.mjs dispatches calls here based on tool name.
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { execSync } from "child_process";
import { getProjectRoot } from "./config.mjs";

// ── Security: path boundaries ──

const PROJECT_ROOT = getProjectRoot();
const DATA_DIR = join(PROJECT_ROOT, "data");
const WORKSPACE_ROOT = resolve(PROJECT_ROOT, "../..");

/**
 * Resolve and validate a path. Reads are allowed within workspace; writes only within data/.
 */
function resolveSafePath(rawPath, mode = "read") {
  // Expand ~ to workspace root
  let resolved = rawPath.startsWith("~")
    ? join(WORKSPACE_ROOT, rawPath.slice(1).replace(/^\//, ""))
    : resolve(PROJECT_ROOT, rawPath);

  if (mode === "write") {
    // Writes restricted to data/ directory
    if (!resolved.startsWith(DATA_DIR)) {
      throw new Error(`Write access denied: only files in data/ can be written. Got: ${rawPath}`);
    }
  } else {
    // Reads restricted to workspace
    if (!resolved.startsWith(WORKSPACE_ROOT)) {
      throw new Error(`Read access denied: path is outside workspace. Got: ${rawPath}`);
    }
  }
  return resolved;
}

// ── Tool definitions (OpenAI function calling format) ──

export const BUILTIN_TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the content of a file. Returns the text content. Use relative paths from project root, or ~/... for workspace paths.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (relative to project root, or ~/... for workspace)" },
          offset: { type: "number", description: "Start reading from this line number (1-based). Optional." },
          limit: { type: "number", description: "Maximum number of lines to read. Default: 500." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file in the data/ directory. Creates parent directories if needed. Returns the download URL.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to data/ (e.g. 'hello.txt', 'exports/report.csv')" },
          content: { type: "string", description: "The content to write to the file" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List files and directories at the given path. Returns names with type indicators (/ for directories).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path (relative to project root, or ~/... for workspace). Default: project root." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_code",
      description: "Execute JavaScript or Python code and return the stdout output. Code runs in a subprocess with a 30-second timeout.",
      parameters: {
        type: "object",
        properties: {
          language: { type: "string", enum: ["javascript", "python"], description: "Programming language" },
          code: { type: "string", description: "The code to execute" },
        },
        required: ["language", "code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "http_request",
      description: "Make an HTTP request and return the response. Useful for calling APIs, fetching web pages, etc.",
      parameters: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP method. Default: GET" },
          url: { type: "string", description: "The URL to request" },
          headers: { type: "object", description: "Optional request headers as key-value pairs" },
          body: { type: "string", description: "Optional request body (for POST/PUT/PATCH)" },
        },
        required: ["url"],
      },
    },
  },
];

// Set of built-in tool names for quick lookup
export const BUILTIN_TOOL_NAMES = new Set(
  BUILTIN_TOOL_DEFINITIONS.map((t) => t.function.name)
);

// ── Tool execution ──

export async function executeBuiltinTool(name, args) {
  try {
    switch (name) {
      case "read_file":
        return executeReadFile(args);
      case "write_file":
        return executeWriteFile(args);
      case "list_directory":
        return executeListDirectory(args);
      case "run_code":
        return executeRunCode(args);
      case "http_request":
        return await executeHttpRequest(args);
      default:
        return JSON.stringify({ error: `Unknown built-in tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}

// ── Individual tool implementations ──

function executeReadFile({ path: filePath, offset, limit }) {
  const resolved = resolveSafePath(filePath, "read");
  if (!existsSync(resolved)) {
    return JSON.stringify({ error: `File not found: ${filePath}` });
  }
  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    return JSON.stringify({ error: `Path is a directory, use list_directory instead: ${filePath}` });
  }
  if (stat.size > 5 * 1024 * 1024) {
    return JSON.stringify({ error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Use offset and limit parameters.` });
  }

  const content = readFileSync(resolved, "utf-8");
  const lines = content.split("\n");
  const startLine = Math.max(0, (offset || 1) - 1);
  const maxLines = limit || 500;
  const slice = lines.slice(startLine, startLine + maxLines);

  return JSON.stringify({
    path: filePath,
    total_lines: lines.length,
    showing: `${startLine + 1}-${startLine + slice.length}`,
    content: slice.join("\n"),
  });
}

function executeWriteFile({ path: filePath, content }) {
  // Normalize: if path doesn't start with data/, prepend it
  const normalizedPath = filePath.startsWith("data/") ? filePath : `data/${filePath}`;
  const resolved = resolveSafePath(normalizedPath, "write");

  // Create parent directories
  const dir = dirname(resolved);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(resolved, content, "utf-8");

  // Return download URL
  const relativePath = normalizedPath.replace(/^data\//, "");
  return JSON.stringify({
    ok: true,
    path: normalizedPath,
    download_url: `/api/files/${relativePath}`,
    message: `File written successfully. Download: /api/files/${relativePath}`,
  });
}

function executeListDirectory({ path: dirPath } = {}) {
  const resolved = resolveSafePath(dirPath || ".", "read");
  if (!existsSync(resolved)) {
    return JSON.stringify({ error: `Directory not found: ${dirPath || "."}` });
  }
  const stat = statSync(resolved);
  if (!stat.isDirectory()) {
    return JSON.stringify({ error: `Path is not a directory: ${dirPath}` });
  }

  const entries = readdirSync(resolved, { withFileTypes: true });
  const items = entries.slice(0, 200).map((e) => ({
    name: e.name + (e.isDirectory() ? "/" : ""),
    type: e.isDirectory() ? "directory" : "file",
  }));

  return JSON.stringify({
    path: dirPath || ".",
    total: entries.length,
    items,
    ...(entries.length > 200 ? { truncated: true } : {}),
  });
}

function executeRunCode({ language, code }) {
  const TIMEOUT = 30000; // 30 seconds

  try {
    let cmd;
    if (language === "javascript") {
      cmd = `node -e ${JSON.stringify(code)}`;
    } else if (language === "python") {
      cmd = `python3 -c ${JSON.stringify(code)}`;
    } else {
      return JSON.stringify({ error: `Unsupported language: ${language}. Use 'javascript' or 'python'.` });
    }

    const output = execSync(cmd, {
      timeout: TIMEOUT,
      maxBuffer: 1024 * 1024, // 1MB
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    return JSON.stringify({ ok: true, output: output.trim() });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.trim() : "";
    const stdout = err.stdout ? err.stdout.trim() : "";
    if (err.killed) {
      return JSON.stringify({ error: `Code execution timed out after ${TIMEOUT / 1000}s` });
    }
    return JSON.stringify({
      error: "Code execution failed",
      exit_code: err.status,
      stderr: stderr.substring(0, 2000),
      stdout: stdout.substring(0, 2000),
    });
  }
}

async function executeHttpRequest({ method = "GET", url, headers = {}, body }) {
  if (!url) return JSON.stringify({ error: "url is required" });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const options = {
      method,
      headers: { ...headers },
      signal: controller.signal,
    };
    if (body && ["POST", "PUT", "PATCH"].includes(method)) {
      options.body = body;
      if (!options.headers["Content-Type"]) {
        options.headers["Content-Type"] = "application/json";
      }
    }

    const resp = await fetch(url, options);
    clearTimeout(timeout);

    const contentType = resp.headers.get("content-type") || "";
    let responseBody;
    if (contentType.includes("json")) {
      responseBody = await resp.json();
    } else {
      const text = await resp.text();
      responseBody = text.substring(0, 10000); // Limit response size
    }

    return JSON.stringify({
      status: resp.status,
      headers: Object.fromEntries(resp.headers.entries()),
      body: responseBody,
    });
  } catch (err) {
    return JSON.stringify({
      error: err.name === "AbortError" ? "Request timed out (30s)" : err.message,
    });
  }
}
