/**
 * p0rn — single backend file
 * Run:  node server.js
 * Open: http://localhost:3000
 *
 * Serves index.html from the same folder and proxies API (upstream hidden).
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 3000;
const UPSTREAM = process.env.UPSTREAM || "https://xvidapi.com/api.php/provide/vod";
const ROOT = __dirname;
const PAGE_SIZE = 24;

const cache = new Map();
const hits = new Map();
const CACHE_TTL = 45_000;
const RATE_MAX = 180;
const RATE_WIN = 60_000;

function ip(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "0";
}
function limited(addr) {
  const now = Date.now();
  let r = hits.get(addr);
  if (!r || now > r.reset) {
    r = { n: 0, reset: now + RATE_WIN };
    hits.set(addr, r);
  }
  r.n++;
  return r.n <= RATE_MAX;
}
function getC(k) {
  const r = cache.get(k);
  if (!r) return null;
  if (Date.now() > r.exp) {
    cache.delete(k);
    return null;
  }
  return r.body;
}
function setC(k, body) {
  cache.set(k, { body, exp: Date.now() + CACHE_TTL });
  if (cache.size > 400) cache.delete(cache.keys().next().value);
}

function upstream(qs) {
  return new Promise((resolve, reject) => {
    const url = UPSTREAM + "?" + qs;
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      { headers: { Accept: "application/json", "User-Agent": "p0rn/2" }, timeout: 15000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode >= 400) return reject(new Error("up " + res.statusCode));
          resolve(body);
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function json(res, code, data) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=20",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function file(res, filePath, type) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": type.includes("html") ? "no-cache" : "public, max-age=3600"
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  if (!limited(ip(req))) return json(res, 429, { code: 0, msg: "Too many requests" });

  const u = new URL(req.url || "/", "http://x");

  if (u.pathname === "/api/health") return json(res, 200, { ok: true });

  if (u.pathname === "/api/vod") {
    if (req.method !== "GET") return json(res, 405, { code: 0, msg: "GET only" });

    const allowed = ["ac", "pg", "t", "wd", "ids", "pagesize"];
    const qs = new URLSearchParams();
    qs.set("at", "json");
    for (const k of allowed) {
      const v = u.searchParams.get(k);
      if (v) qs.set(k, v);
    }
    if (!qs.get("ac")) qs.set("ac", "detail");
    if (!qs.get("pagesize") && qs.get("ac") === "detail" && !qs.get("ids")) {
      qs.set("pagesize", String(PAGE_SIZE));
    }

    const key = qs.toString();
    const hit = getC(key);
    if (hit) {
      res.setHeader("X-Cache", "HIT");
      return json(res, 200, hit);
    }

    try {
      const body = await upstream(key);
      JSON.parse(body);
      setC(key, body);
      res.setHeader("X-Cache", "MISS");
      return json(res, 200, body);
    } catch (e) {
      console.error(e.message);
      return json(res, 502, { code: 0, msg: "Upstream error" });
    }
  }

  if (u.pathname.startsWith("/api/")) return json(res, 404, { code: 0, msg: "Not found" });

  let rel = decodeURIComponent(u.pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const fp = path.join(ROOT, safe);
  if (!fp.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  const ext = path.extname(fp).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript",
    ".css": "text/css",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml"
  };
  file(res, fp, types[ext] || "application/octet-stream");
});

server.listen(PORT, () => {
  console.log("p0rn → http://localhost:" + PORT);
  console.log("Put index.html next to this server.js");
});
