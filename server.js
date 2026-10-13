/**
 * p0rn API proxy backend
 * - Hides upstream API from the browser
 * - Same-origin only (no public CORS)
 * - Basic rate limit + cache
 * - Serves frontend from ../frontend
 *
 * Run:  node server.js
 * Env:  PORT=3000  UPSTREAM=https://xvidapi.com/api.php/provide/vod
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 3000;
const UPSTREAM = process.env.UPSTREAM || "https://xvidapi.com/api.php/provide/vod";
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
const CACHE_TTL_MS = 60_000; // 1 min
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120; // per IP per minute

const cache = new Map();
const hits = new Map(); // ip -> { count, reset }

function clientIp(req) {
  return (
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

function rateLimit(ip) {
  const now = Date.now();
  let row = hits.get(ip);
  if (!row || now > row.reset) {
    row = { count: 0, reset: now + RATE_WINDOW_MS };
    hits.set(ip, row);
  }
  row.count += 1;
  return row.count <= RATE_MAX;
}

function cacheKey(qs) {
  return qs;
}

function getCache(key) {
  const row = cache.get(key);
  if (!row) return null;
  if (Date.now() > row.exp) {
    cache.delete(key);
    return null;
  }
  return row.body;
}

function setCache(key, body) {
  cache.set(key, { body, exp: Date.now() + CACHE_TTL_MS });
  if (cache.size > 500) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

function upstreamGet(queryString) {
  return new Promise((resolve, reject) => {
    const url = `${UPSTREAM}?${queryString}`;
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "p0rn-proxy/1.0"
        },
        timeout: 20000
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error("Upstream " + res.statusCode));
            return;
          }
          resolve(data);
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Upstream timeout"));
    });
  });
}

function sendJson(res, status, obj) {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=30",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function sendText(res, status, text, type) {
  res.writeHead(status, {
    "Content-Type": type || "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(text);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json"
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  // block path traversal
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(FRONTEND_DIR, safe);
  if (!filePath.startsWith(FRONTEND_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback
      const index = path.join(FRONTEND_DIR, "index.html");
      fs.readFile(index, (e2, html) => {
        if (e2) return sendText(res, 404, "Not found");
        sendText(res, 200, html, "text/html; charset=utf-8");
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    sendText(res, 200, data, MIME[ext] || "application/octet-stream");
  });
}

const server = http.createServer(async (req, res) => {
  // Security headers
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // No open CORS — browser only talks same-origin
  res.setHeader("Access-Control-Allow-Origin", "null");

  const ip = clientIp(req);
  if (!rateLimit(ip)) {
    return sendJson(res, 429, { code: 0, msg: "Too many requests" });
  }

  const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  // Health
  if (u.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true });
  }

  // Proxy: /api/vod?...  mirrors upstream query params
  if (u.pathname === "/api/vod" || u.pathname === "/api/vod/") {
    if (req.method !== "GET") {
      return sendJson(res, 405, { code: 0, msg: "GET only" });
    }

    // Only allow known params
    const allowed = ["ac", "at", "pg", "t", "wd", "ids", "h"];
    const qs = new URLSearchParams();
    qs.set("at", "json");
    for (const key of allowed) {
      if (key === "at") continue;
      const v = u.searchParams.get(key);
      if (v != null && v !== "") qs.set(key, v);
    }
    if (!qs.get("ac")) qs.set("ac", "detail");

    const key = qs.toString();
    const cached = getCache(key);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      return sendJson(res, 200, cached);
    }

    try {
      const body = await upstreamGet(key);
      // validate JSON
      JSON.parse(body);
      setCache(key, body);
      res.setHeader("X-Cache", "MISS");
      return sendJson(res, 200, body);
    } catch (e) {
      console.error("[proxy]", e.message);
      return sendJson(res, 502, { code: 0, msg: "Upstream error" });
    }
  }

  // Block direct probing of other /api paths
  if (u.pathname.startsWith("/api/")) {
    return sendJson(res, 404, { code: 0, msg: "Not found" });
  }

  // Static frontend
  serveStatic(req, res, u.pathname);
});

server.listen(PORT, () => {
  console.log(`p0rn backend on http://localhost:${PORT}`);
  console.log(`frontend: ${FRONTEND_DIR}`);
  console.log(`upstream hidden — clients only hit /api/vod`);
});
