// Social Hub — STUB implementation.
//
// 完整实现（Telegram/Feishu/WeCom/X 集成）在 ef76ab8 提交时漏 commit 了，
// 这个 stub 让 server.mjs 能正常启动，所有 API 返回"未实现"，无任何副作用。
// 等原作者补上真实 lib/social-hub.mjs 后替换。

// ── Platform catalog ──
// server.mjs 里: json(res, { platforms: PLATFORMS })
export const PLATFORMS = {
  telegram: { name: "Telegram", icon: "✈️", enabled: false, docsUrl: null },
  feishu:   { name: "Feishu",   icon: "📙", enabled: false, docsUrl: null },
  wecom:    { name: "WeCom",    icon: "💼", enabled: false, docsUrl: null },
  twitter:  { name: "X/Twitter", icon: "🐦", enabled: false, docsUrl: null },
};

// ── In-memory state ──
const _adapters = new Map();
const _logs = [];

// ── Configuration CRUD (all no-ops) ──
export function getSocialConfigMasked() {
  return {};
}

export function saveSocialConfig(platform, body) {
  const err = new Error(`Social hub stub: saveSocialConfig('${platform}') not implemented`);
  err.code = "NOT_IMPLEMENTED";
  throw err;
}

export function deleteSocialConfig(platform) {
  // no-op
}

// ── Webhook handler ──
export async function handleWebhook(platform, req, body) {
  return { ok: false, error: "social hub stub: webhook not implemented", platform };
}

// ── Log management ──
export function getLogs(limit = 100) {
  return _logs.slice(-limit);
}

export function clearLogs() {
  _logs.length = 0;
}

// ── Adapter registry ──
export function registerAdapter(platform, adapter) {
  _adapters.set(platform, adapter);
}

export function getAdapter(platform) {
  return _adapters.get(platform) || null;
}

export function getAllAdapters() {
  const out = {};
  for (const [k, v] of _adapters) {
    out[k] = { enabled: false, status: "stub", platform: k };
  }
  return out;
}

export async function startAdapter(platform) {
  const err = new Error(`Social hub stub: startAdapter('${platform}') not implemented`);
  err.code = "NOT_IMPLEMENTED";
  throw err;
}

export async function stopAdapter(platform) {
  // no-op
}

// ── Chat dispatch ──
let _chatHandler = null;
export function setChatHandler(fn) {
  _chatHandler = fn;
}

// ── Init (called on server boot) ──
export async function initSocialHub() {
  // stub: do nothing, return adapter count 0
  return 0;
}
