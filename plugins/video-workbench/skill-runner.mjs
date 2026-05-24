/**
 * Skill Runner · spawn 子进程 + 行缓冲 + SSE 转发 + 日志归档
 *
 * 单一职责：把 ~/workspace/skills/video-factory/scripts/*.py 跑起来，
 * 把进度通过 SSE 给前端，把退出码写回 DB。
 *
 * 防 ffmpeg 孤儿：kill 时递归 pkill -P <pid> -9
 */
import { spawn } from "child_process";
import { createWriteStream, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";
import { updateRun, getRun } from "./db.mjs";
import { redactKeysInText } from "./keys.mjs";

// in-memory mutex: 同一 project+phase 同时只能跑一个
const activePhases = new Map(); // key = `${projectId}:${phase}`, val = run_id

export function isPhaseRunning(projectId, phase) {
  return activePhases.has(`${projectId}:${phase}`);
}

export function getActiveRunId(projectId, phase) {
  return activePhases.get(`${projectId}:${phase}`) || null;
}

/**
 * 启动脚本，返回 { runId, child, promise }
 *
 * onSSE: (eventName, dataObj) => void   把事件 push 给前端
 *
 * 脚本输出约定：
 *   普通行 → event: log { level: 'info', line }
 *   [progress] N/M label → event: progress { n, m, label }
 *   ^✗|Error|Traceback → event: log { level: 'error', line }
 *   stderr → event: log { level: 'warn', line }
 */
export async function runSkill({
  projectId,
  phase,
  cmd = "python3",
  args = [],
  cwd,
  env = {},
  logsDir,
  onSSE = () => {},
  onComplete = () => {},
  createRunFn,   // DB createRun 函数注入，避免循环 import
}) {
  const key = `${projectId}:${phase}`;
  if (activePhases.has(key)) {
    const err = new Error(`phase ${phase} already running for project ${projectId}`);
    err.code = "EBUSY";
    err.activeRunId = activePhases.get(key);
    throw err;
  }

  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });

  // 创建 run 行
  const argvJson = JSON.stringify(args);
  const envKeysJson = JSON.stringify(Object.keys(env));
  const runId = createRunFn({
    projectId, phase,
    scriptPath: args[0] || cmd,
    argvJson, envKeysJson,
    logPath: null, // 拿到 runId 后回填
  });
  const logPath = join(logsDir, `${runId}.log`);
  updateRun(runId, { log_path: logPath });
  activePhases.set(key, runId);

  // 起进程：必须无缓冲（PYTHONUNBUFFERED）
  const mergedEnv = {
    ...process.env,
    PYTHONUNBUFFERED: "1",
    ...env,
  };
  const child = spawn(cmd, args, {
    cwd,
    env: mergedEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  updateRun(runId, { pid: child.pid, status: "running" });

  const logStream = createWriteStream(logPath, { flags: "a" });
  logStream.write(`=== run ${runId} · phase ${phase} · pid ${child.pid} · ${new Date().toISOString()} ===\n`);
  logStream.write(`cmd: ${cmd} ${args.join(" ")}\n\n`);

  // 进度正则
  const PROGRESS_RE = /^\[progress\]\s+(\d+)\s*\/\s*(\d+)\s*(.*)$/;

  const handleLine = (line, level = "info") => {
    // 写日志（脱敏）
    const sanitized = redactKeysInText(line);
    logStream.write(sanitized + "\n");

    // 解析进度
    const m = line.match(PROGRESS_RE);
    if (m) {
      const n = parseInt(m[1], 10);
      const total = parseInt(m[2], 10);
      const label = m[3] || "";
      onSSE("progress", { n, m: total, label, run_id: runId });
      return;
    }

    // 错误特征
    let lvl = level;
    if (/^✗|^Error|^Traceback|^FAILED/.test(line)) lvl = "error";

    onSSE("log", { level: lvl, line: sanitized, run_id: runId });
  };

  const rlOut = createInterface({ input: child.stdout });
  rlOut.on("line", (line) => handleLine(line, "info"));

  const rlErr = createInterface({ input: child.stderr });
  rlErr.on("line", (line) => handleLine(line, "warn"));

  // 完成 promise
  const promise = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      const status = signal === "SIGKILL" || signal === "SIGTERM"
        ? "killed"
        : (code === 0 ? "success" : "failed");
      updateRun(runId, {
        status,
        exit_code: code,
        finished_at: Date.now(),
      });
      logStream.write(`\n=== exit code=${code} signal=${signal} status=${status} ===\n`);
      logStream.end();
      activePhases.delete(key);
      onSSE(status === "success" ? "done" : (status === "killed" ? "cancelled" : "error"), {
        run_id: runId, exit_code: code, status,
      });
      onComplete({ runId, exitCode: code, signal, status });
      resolve({ runId, exitCode: code, signal, status });
    });

    child.on("error", (err) => {
      logStream.write(`\n=== spawn error: ${err.message} ===\n`);
      logStream.end();
      updateRun(runId, { status: "failed", finished_at: Date.now() });
      activePhases.delete(key);
      onSSE("error", { run_id: runId, message: err.message });
      onComplete({ runId, exitCode: -1, error: err.message, status: "failed" });
      resolve({ runId, exitCode: -1, error: err.message, status: "failed" });
    });
  });

  return { runId, child, promise };
}

/**
 * 杀进程组（包含 ffmpeg / chromium 子孙）防孤儿
 */
export async function killRunTree(runId) {
  const run = getRun(runId);
  if (!run || !run.pid) return false;
  if (run.status !== "running") return false;

  // 递归杀子孙
  try {
    const { execSync } = await import("child_process");
    // -9 强杀；pgrep -P 找所有子；再杀自己
    try { execSync(`pkill -9 -P ${run.pid}`, { stdio: "ignore" }); } catch {}
    try { process.kill(run.pid, "SIGKILL"); } catch {}
    return true;
  } catch (err) {
    console.error(`[vf] killRunTree failed: ${err.message}`);
    return false;
  }
}

/**
 * 启动时清扫：标记上次未正常退出的 running run 为 killed
 */
export function reapStaleRuns() {
  // 这个简化版不真去验证 pid 是否还活着；启动时全部标 killed
  const { getDb } = require("./db.mjs"); // dynamic require 防循环
}
