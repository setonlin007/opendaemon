import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const SECRET = randomBytes(32).toString("hex");
const tokens = new Set();
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

const EXEMPT_PATHS = new Set(["/login.html", "/api/login"]);

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

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": `od_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`,
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

  return { handleLogin, handleLogout, requireAuth };
}
