/**
 * OAuth Token Manager for Claude AI
 *
 * Handles Authorization Code + PKCE flow with Anthropic's OAuth endpoints.
 * Tokens are stored in ~/.claude/.credentials.json (same format as Claude Code CLI).
 */

import { randomBytes, createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── OAuth Constants ──
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTH_URL = "https://claude.com/cai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

const CLAUDE_DIR = join(homedir(), ".claude");
const CREDENTIALS_PATH = join(CLAUDE_DIR, ".credentials.json");

// ── In-memory PKCE state (keyed by state param) ──
const pkceStore = new Map();
const PKCE_TTL = 10 * 60 * 1000; // 10 minutes

// ── Token refresh lock ──
let refreshPromise = null;

// ── PKCE Helpers ──

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateCodeVerifier() {
  return base64url(randomBytes(32));
}

function generateCodeChallenge(verifier) {
  return base64url(createHash("sha256").update(verifier).digest());
}

// ── Credentials File ──

function readCredentials() {
  try {
    if (!existsSync(CREDENTIALS_PATH)) return null;
    return JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function writeCredentials(data) {
  mkdirSync(CLAUDE_DIR, { recursive: true });
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// ── Public API ──

/**
 * Generate an OAuth authorization URL with PKCE challenge.
 * Returns { authUrl, state } — the state must be passed back to exchangeCode().
 */
export function generateAuthUrl() {
  const state = base64url(randomBytes(16));
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // Store PKCE verifier with TTL
  pkceStore.set(state, { codeVerifier, createdAt: Date.now() });

  // Cleanup expired entries
  for (const [k, v] of pkceStore) {
    if (Date.now() - v.createdAt > PKCE_TTL) pkceStore.delete(k);
  }

  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });

  return {
    authUrl: `${AUTH_URL}?${params.toString()}`,
    state,
  };
}

/**
 * Exchange an authorization code for access/refresh tokens.
 * @param {string} code — authorization code from callback page
 * @param {string} state — state parameter from generateAuthUrl()
 */
export async function exchangeCode(code, state) {
  const pkce = pkceStore.get(state);
  if (!pkce) throw new Error("Invalid or expired state. Please restart the login flow.");
  if (Date.now() - pkce.createdAt > PKCE_TTL) {
    pkceStore.delete(state);
    throw new Error("Login flow expired. Please try again.");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      code_verifier: pkce.codeVerifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || data.error || "Token exchange failed");
  }

  pkceStore.delete(state);

  const credentials = {
    claudeAiOauth: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in || 28800) * 1000,
      scopes: SCOPES.split(" "),
    },
  };

  // Preserve existing fields (e.g. mcpOauth)
  const existing = readCredentials() || {};
  writeCredentials({ ...existing, claudeAiOauth: credentials.claudeAiOauth });

  console.log("[oauth] tokens saved, expires in", data.expires_in, "seconds");
  return { expiresAt: credentials.claudeAiOauth.expiresAt };
}

/**
 * Refresh the access token using the stored refresh token.
 */
export async function refreshToken() {
  // Prevent concurrent refresh
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const creds = readCredentials();
      const rt = creds?.claudeAiOauth?.refreshToken;
      if (!rt) throw new Error("No refresh token available");

      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: rt,
          client_id: CLIENT_ID,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error_description || data.error || "Token refresh failed");
      }

      const updated = {
        ...creds,
        claudeAiOauth: {
          ...creds.claudeAiOauth,
          accessToken: data.access_token,
          refreshToken: data.refresh_token || rt,
          expiresAt: Date.now() + (data.expires_in || 28800) * 1000,
        },
      };

      writeCredentials(updated);
      console.log("[oauth] token refreshed, expires in", data.expires_in, "seconds");
      return { expiresAt: updated.claudeAiOauth.expiresAt };
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/**
 * Check if valid OAuth credentials exist.
 */
export function getOAuthStatus() {
  const creds = readCredentials();
  const oauth = creds?.claudeAiOauth;
  if (!oauth?.accessToken) {
    return { authenticated: false, expiresAt: null, hasRefresh: false };
  }
  return {
    authenticated: oauth.expiresAt > Date.now(),
    expiresAt: oauth.expiresAt,
    hasRefresh: !!oauth.refreshToken,
    expired: oauth.expiresAt <= Date.now(),
  };
}

/**
 * Ensure a valid token is available. Refresh if expired.
 * Call before each SDK invocation.
 */
export async function ensureValidToken() {
  const status = getOAuthStatus();
  if (status.authenticated) return true;
  if (status.hasRefresh) {
    await refreshToken();
    return true;
  }
  return false;
}

/**
 * Clear all OAuth tokens.
 */
export function revokeTokens() {
  const creds = readCredentials() || {};
  delete creds.claudeAiOauth;
  writeCredentials(creds);
  console.log("[oauth] tokens revoked");
}

// ── Background refresh timer ──
let refreshInterval = null;

export function startTokenRefreshTimer() {
  if (refreshInterval) return;
  // Check every 5 minutes
  refreshInterval = setInterval(async () => {
    const status = getOAuthStatus();
    if (!status.hasRefresh) return;
    // Refresh if token expires within 10 minutes
    const margin = 10 * 60 * 1000;
    if (status.expiresAt && status.expiresAt - Date.now() < margin) {
      try {
        await refreshToken();
      } catch (err) {
        console.error("[oauth] background refresh failed:", err.message);
      }
    }
  }, 5 * 60 * 1000);
  refreshInterval.unref();
}

export function stopTokenRefreshTimer() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}
