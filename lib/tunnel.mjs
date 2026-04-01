/**
 * Cloudflare Tunnel — zero-config HTTPS access via trycloudflare.com
 *
 * Spawns cloudflared as a subprocess to create a quick tunnel.
 * No Cloudflare account needed. Free HTTPS domain auto-assigned.
 *
 * Usage:
 *   import { startTunnel, stopTunnel, getTunnelUrl } from "./lib/tunnel.mjs";
 *   await startTunnel(3456);
 *   console.log(getTunnelUrl()); // https://xxx.trycloudflare.com
 */

import { spawn, execFileSync } from "child_process";
import { existsSync, createWriteStream, chmodSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { get } from "https";
import { pipeline } from "stream/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BIN_DIR = join(ROOT, "bin");
const PLATFORM = process.platform; // linux, darwin, win32
const ARCH = process.arch; // x64, arm64

let tunnelProcess = null;
let tunnelUrl = null;

function getBinaryName() {
  if (PLATFORM === "linux" && ARCH === "x64") return "cloudflared-linux-amd64";
  if (PLATFORM === "linux" && ARCH === "arm64") return "cloudflared-linux-arm64";
  if (PLATFORM === "darwin" && ARCH === "x64") return "cloudflared-darwin-amd64";
  if (PLATFORM === "darwin" && ARCH === "arm64") return "cloudflared-darwin-arm64";
  if (PLATFORM === "win32") return "cloudflared-windows-amd64.exe";
  return null;
}

function getDownloadUrl() {
  const name = getBinaryName();
  if (!name) return null;
  return `https://github.com/cloudflare/cloudflared/releases/latest/download/${name}`;
}

function getBinaryPath() {
  // Check project bin/ first, then system PATH
  const localBin = join(BIN_DIR, PLATFORM === "win32" ? "cloudflared.exe" : "cloudflared");
  if (existsSync(localBin)) return localBin;

  // Check system-wide
  try {
    const path = execFileSync("which", ["cloudflared"], { encoding: "utf-8" }).trim();
    if (path) return path;
  } catch {}

  return localBin; // Will need to download
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        const ws = createWriteStream(dest);
        pipeline(res, ws).then(resolve).catch(reject);
      }).on("error", reject);
    };
    follow(url);
  });
}

async function ensureBinary() {
  const binPath = getBinaryPath();
  if (existsSync(binPath)) return binPath;

  const url = getDownloadUrl();
  if (!url) throw new Error(`Unsupported platform: ${PLATFORM}-${ARCH}`);

  console.log(`[tunnel] downloading cloudflared for ${PLATFORM}-${ARCH}...`);
  mkdirSync(BIN_DIR, { recursive: true });
  await download(url, binPath);
  if (PLATFORM !== "win32") chmodSync(binPath, 0o755);
  console.log(`[tunnel] cloudflared installed at ${binPath}`);
  return binPath;
}

export async function startTunnel(port) {
  if (tunnelProcess) return tunnelUrl;

  const bin = await ensureBinary();

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate", "--config", "/dev/null"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    tunnelProcess = proc;
    let output = "";
    const timeout = setTimeout(() => {
      reject(new Error("[tunnel] timed out waiting for URL"));
    }, 30000);

    let resolved = false;
    const onData = (data) => {
      output += data.toString();
      const match = output.match(/https:\/\/[^\s]+\.trycloudflare\.com/);
      if (match) {
        clearTimeout(timeout);
        tunnelUrl = match[0];
        if (!resolved) {
          resolved = true;
          console.log(`[tunnel] ${tunnelUrl}`);
          resolve(tunnelUrl);
          // Stop accumulating output after URL found
          proc.stdout.removeListener("data", onData);
          proc.stderr.removeListener("data", onData);
        }
      }
    };

    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);

    proc.on("exit", (code) => {
      clearTimeout(timeout);
      tunnelProcess = null;
      tunnelUrl = null;
      if (code !== 0 && code !== null) {
        console.error(`[tunnel] cloudflared exited with code ${code}`);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export function stopTunnel() {
  if (tunnelProcess) {
    tunnelProcess.kill("SIGTERM");
    tunnelProcess = null;
    tunnelUrl = null;
    console.log("[tunnel] stopped");
  }
}

export function getTunnelUrl() {
  return tunnelUrl;
}
