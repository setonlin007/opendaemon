import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const SECRET = randomBytes(32).toString("hex");
const tokens = new Set();
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

const EXEMPT_PATHS = new Set(["/login.html", "/api/login", "/access"]);

// Temporary access links: token → { expires, maxUses, used, label, createdAt }
const accessLinks = new Map();

function signToken(token) {
  return createHmac("sha256", SECRET).update(token).digest("hex");
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (key) cookies[key.trim()] = rest.join("=").trim();
  }
  return cookies;
}

export function createAuth(password) {
  function handleLogin(req, res, body) {
    const pw = body?.password || "";
    const pwBuf = Buffer.from(pw);
    const expectedBuf = Buffer.from(password);

    const match =
      pwBuf.length === expectedBuf.length &&
      timingSafeEqual(pwBuf, expectedBuf);

    if (!match) {
      // Delay to prevent brute force
      setTimeout(() => {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "wrong password" }));
      }, 1000);
      return;
    }

    const token = randomBytes(32).toString("hex");
    const signed = signToken(token);
    tokens.add(signed);

    const isSecure = req.headers["x-forwarded-proto"] === "https" || req.connection?.encrypted;
    const securePart = isSecure ? " Secure;" : "";
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": `od_session=${token}; Path=/; HttpOnly; SameSite=Lax;${securePart} Max-Age=${COOKIE_MAX_AGE}`,
    });
    res.end(JSON.stringify({ ok: true }));
  }

  function handleLogout(req, res) {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.od_session) {
      tokens.delete(signToken(cookies.od_session));
    }
    res.writeHead(302, {
      "Set-Cookie": "od_session=; Path=/; HttpOnly; Max-Age=0",
      Location: "/login.html",
    });
    res.end();
  }

  function requireAuth(req, res) {
    // Exempt paths
    const path = req.url.split("?")[0];
    if (EXEMPT_PATHS.has(path)) return true;

    // Check cookie
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.od_session) {
      const signed = signToken(cookies.od_session);
      if (tokens.has(signed)) return true;
    }

    // Not authenticated
    if (path.startsWith("/api/")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    } else {
      res.writeHead(302, { Location: "/login.html" });
      res.end();
    }
    return false;
  }

  function createInternalToken() {
    const token = randomBytes(32).toString("hex");
    const signed = signToken(token);
    tokens.add(signed);
    return token;
  }

  /**
   * Create a temporary access link token
   * @param {Object} opts
   * @param {number} opts.expiresIn - Expiry in hours (default 24)
   * @param {number} opts.maxUses - Max uses (default 1, 0 = unlimited)
   * @param {string} opts.label - Optional label
   * @returns {{ token: string, expires: number }}
   */
  function createAccessLink({ expiresIn = 24, maxUses = 1, label = "" } = {}) {
    // Clean up expired links
    const now = Date.now();
    for (const [t, link] of accessLinks) {
      if (link.expires < now) accessLinks.delete(t);
    }

    const token = randomBytes(32).toString("hex");
    const expires = now + expiresIn * 3600 * 1000;
    accessLinks.set(token, {
      expires,
      maxUses,
      used: 0,
      label: label || `Link created at ${new Date().toISOString()}`,
      createdAt: now,
    });
    return { token, expires };
  }

  /**
   * Validate and consume an access link, returns session token if valid
   */
  function consumeAccessLink(accessToken, req) {
    const link = accessLinks.get(accessToken);
    if (!link) return null;

    const now = Date.now();
    if (link.expires < now) {
      accessLinks.delete(accessToken);
      return null;
    }

    if (link.maxUses > 0 && link.used >= link.maxUses) {
      accessLinks.delete(accessToken);
      return null;
    }

    // Consume
    link.used++;
    if (link.maxUses > 0 && link.used >= link.maxUses) {
      accessLinks.delete(accessToken);
    }

    // Create a real session token
    const sessionToken = randomBytes(32).toString("hex");
    const signed = signToken(sessionToken);
    tokens.add(signed);
    return sessionToken;
  }

  /**
   * List active (non-expired) access links
   */
  function listAccessLinks() {
    const now = Date.now();
    const result = [];
    for (const [token, link] of accessLinks) {
      if (link.expires < now) {
        accessLinks.delete(token);
        continue;
      }
      result.push({
        token: token.slice(0, 8) + "..." + token.slice(-4), // masked
        tokenFull: token,
        expires: link.expires,
        maxUses: link.maxUses,
        used: link.used,
        label: link.label,
        createdAt: link.createdAt,
      });
    }
    return result;
  }

  /**
   * Revoke an access link
   */
  function revokeAccessLink(token) {
    return accessLinks.delete(token);
  }

  return { handleLogin, handleLogout, requireAuth, createInternalToken, createAccessLink, consumeAccessLink, listAccessLinks, revokeAccessLink };
}
