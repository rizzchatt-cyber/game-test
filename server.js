/**
 * p0rn — Production Server with Dynamic SSR Open Graph Metadata
 * Run:  node server.js
 * Domain: https://p0rn.online
 *
 * Serves index.html with dynamic Open Graph & Twitter preview metadata
 * for WhatsApp, Instagram, Telegram, Twitter, Discord, and search engines.
 * Proxies API (upstream hidden) with local caching.
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 3000;
const BASE_DOMAIN = process.env.BASE_DOMAIN || "https://p0rn.online";
const UPSTREAM = process.env.UPSTREAM || "https://xvidapi.com/api.php/provide/vod";
const ROOT = __dirname;
const PAGE_SIZE = 24;

const cache = new Map();
const hits = new Map();
const CACHE_TTL = 60_000;
const RATE_MAX = 180;
const RATE_WIN = 60_000;

const CATEGORY_NAMES = {
  41: "Indian", 8: "Amateur", 65: "Teen", 49: "MILF", 44: "Latina",
  11: "Asian Woman", 43: "Japanese", 45: "Lesbian", 9: "Anal", 20: "Big Tits",
  23: "Blowjob", 27: "Creampie", 53: "Pornstar", 30: "Exotic", 42: "Interracial",
  37: "Gangbang", 15: "BBW", 10: "Arab", 54: "Real Amateur", 26: "Cam Porn",
  16: "BDSM", 18: "Big Ass", 19: "Big Cock", 22: "Blonde", 24: "Brunette",
  29: "Cumshot", 31: "Facial", 34: "Femdom", 47: "Massage", 48: "Mature",
  51: "Orgy", 62: "Squirting", 63: "Stockings", 64: "Swingers", 68: "Virtual Reality",
  7: "AI", 13: "Ass", 21: "Black Woman", 28: "Cuckold", 38: "Gapes",
  40: "Heels", 46: "Lingerie", 50: "Oiled", 55: "Redhead", 58: "Sexy",
  60: "Shemale", 61: "Solo Masturbation", 66: "Toons", 69: "Workout", 12: "ASMR"
};

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
  if (cache.size > 500) cache.delete(cache.keys().next().value);
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

const ALLOWED_EMBED_HOSTS = new Set([
  "upload18.net",
  "upload18.org",
  "upload18.cc",
  "helvid.com",
  "xvidapi.com"
]);

function isAllowedEmbedHost(hostname) {
  if (!hostname) return false;
  hostname = hostname.toLowerCase();
  for (const h of ALLOWED_EMBED_HOSTS) {
    if (hostname === h || hostname.endsWith("." + h)) return true;
  }
  return false;
}

function fetchUpstreamHtml(targetUrl, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    function get(u, hops) {
      if (hops > maxRedirects) return reject(new Error("Too many redirects"));
      const parsed = new URL(u);
      const lib = parsed.protocol === "https:" ? https : http;
      const options = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Referer": "https://xvidapi.com/",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        },
        timeout: 12000
      };
      const req = lib.request(options, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const next = new URL(res.headers.location, u).toString();
          return get(next, hops + 1);
        }
        if (res.statusCode < 200 || res.statusCode >= 400) {
          return reject(new Error("Upstream status " + res.statusCode));
        }
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          resolve({ body: Buffer.concat(chunks).toString("utf8"), finalUrl: u });
        });
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Upstream timeout"));
      });
      req.end();
    }
    get(targetUrl, 0);
  });
}

function sanitizeEmbedHtml(html, baseOrigin) {
  let out = html;

  // 1. Ensure <base href="..."> points to upstream domain so player assets load seamlessly
  if (/<base\s+href=/i.test(out)) {
    out = out.replace(/<base\s+href=["'][^"']*["']\s*\/?>/i, `<base href="${baseOrigin}/" />`);
  } else {
    out = out.replace(/<head>/i, `<head>\n<base href="${baseOrigin}/" />`);
  }

  // 2. Remove Sandbox Guard script (stops anti-sandbox check & "SANDBOX DETECTED" overlay)
  out = out.replace(/<script[^>]*src=["'][^"']*sandbox-guard[^"']*["'][^>]*><\/script>/gi, "");

  // 3. Remove DevTools blockers so player never crashes or freezes
  out = out.replace(/<script[^>]*src=["'][^"']*(?:devtools|disable-devtool|player-devtool-guard)[^"']*["'][^>]*><\/script>/gi, "");

  // 4. Remove Denied overlay box completely
  out = out.replace(/<div id=["']denied-box["'][\s\S]*?SANDBOX DETECTED![\s\S]*?<\/div>\s*<\/div>/gi, "");

  // 5. Remove obfuscated popunder clickjacker WebAssembly & JS
  out = out.replace(/<script[^>]*>!function\(\)\{"use strict";for\(var t=decodeURI\("wd%60andp[\s\S]*?<\/script>/gi, "");

  // 6. Remove third-party ad network scripts (egotisticexcavateplywood, driverhugoverblown, on.js, etc.)
  out = out.replace(/<script[^>]*src=["'][^"']*(?:egotisticexcavateplywood|driverhugoverblown|on\.js)[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<script[^>]*data-clocid[^>]*>[\s\S]*?<\/script>/gi, "");

  // 7. Inject our Bulletproof Ad & Popup Neutralizer Shield
  const shieldScript = `
<script>
(function() {
  "use strict";
  // Satisfy sandbox guard probe so player runtime behaves smoothly
  var mockGuard = { version: "1.1.0", blocked: false, reason: "", iframeContext: true, probeStatus: "clear", probeReason: "" };
  try {
    Object.defineProperty(window, "__u18SandboxGuard", { value: Object.freeze(mockGuard), writable: false, configurable: false });
  } catch(e) { window.__u18SandboxGuard = mockGuard; }
  window.__u18EnforceSandboxGuard = function() { return false; };

  // Background Ad Blocker: Disarm window.open
  var noop = function() { return null; };
  try {
    window.open = noop;
    Object.defineProperty(window, "open", { value: noop, writable: false, configurable: false });
  } catch(e) { window.open = noop; }

  // Disarm malicious dialog traps & unload hijacking
  window.alert = noop;
  window.confirm = function() { return true; };
  window.prompt = noop;
  window.onbeforeunload = null;

  // Background dynamic script blocker for rogue ad networks
  var _origCreate = document.createElement;
  document.createElement = function(tag, opts) {
    var el = _origCreate.call(document, tag, opts);
    if (tag && typeof tag === "string" && tag.toLowerCase() === "script") {
      var _origSet = el.setAttribute;
      el.setAttribute = function(name, val) {
        if (name === "src" && typeof val === "string" && /(?:egotistic|driverhug|clocid|popunder|on\\.js|adcash|propeller|juicyads)/i.test(val)) {
          return;
        }
        return _origSet.call(this, name, val);
      };
    }
    return el;
  };

  // Click Hijack Neutralizer: Block clicks aimed at foreign ad domains
  document.addEventListener("click", function(e) {
    var a = e.target && e.target.closest ? e.target.closest("a") : null;
    if (a) {
      var href = a.getAttribute("href") || "";
      if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
        var isSafe = href.includes("upload18.net") || href.includes("p0rn.online") || href.startsWith("/");
        if (!isSafe) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          return false;
        }
      }
    }
  }, true);
})();
</script>
`;

  out = out.replace(/<head>/i, "<head>\n" + shieldScript);
  return out;
}

async function handleEmbedProxy(req, res, u) {
  const targetRaw = u.searchParams.get("url");
  if (!targetRaw) {
    return json(res, 400, { code: 0, msg: "Missing url parameter" });
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetRaw, "https://upload18.net");
  } catch (err) {
    return json(res, 400, { code: 0, msg: "Invalid target url" });
  }

  if (!isAllowedEmbedHost(parsedTarget.hostname)) {
    return json(res, 403, { code: 0, msg: "Target host not permitted" });
  }

  const theme = u.searchParams.get("theme") || parsedTarget.searchParams.get("theme") || "minimal";
  const color = u.searchParams.get("color") || parsedTarget.searchParams.get("color") || "F4D59A";
  parsedTarget.searchParams.set("theme", theme);
  parsedTarget.searchParams.set("color", color);

  const targetUrl = parsedTarget.toString();
  const cacheKey = "embed:" + targetUrl;
  const cached = getC(cacheKey);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=180",
      "X-Content-Type-Options": "nosniff"
    });
    return res.end(cached);
  }

  try {
    const { body, finalUrl } = await fetchUpstreamHtml(targetUrl);
    const finalHost = new URL(finalUrl).origin;
    const sanitized = sanitizeEmbedHtml(body, finalHost);

    setC(cacheKey, sanitized);

    res.setHeader("X-Cache", "MISS");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=180",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(sanitized);
  } catch (err) {
    console.error("Embed proxy error:", err.message);
    res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<div style="color:#fff;background:#000;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">Error loading player. Please try again.</div>');
  }
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

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let cachedIndexHtml = null;
let lastIndexMtime = 0;

function getIndexTemplate() {
  const fp = path.join(ROOT, "index.html");
  try {
    const st = fs.statSync(fp);
    if (!cachedIndexHtml || st.mtimeMs !== lastIndexMtime) {
      cachedIndexHtml = fs.readFileSync(fp, "utf8");
      lastIndexMtime = st.mtimeMs;
    }
    return cachedIndexHtml;
  } catch {
    return cachedIndexHtml || "";
  }
}

async function fetchVideoMeta(vId) {
  const cacheKey = "meta:v:" + vId;
  const hit = getC(cacheKey);
  if (hit) {
    try { return JSON.parse(hit); } catch (_) {}
  }

  const qs = new URLSearchParams({ at: "json", ac: "detail", ids: String(vId) }).toString();
  const apiHit = getC(qs);
  if (apiHit) {
    try {
      const parsed = JSON.parse(apiHit);
      const raw = parsed.list && parsed.list[0];
      if (raw) {
        setC(cacheKey, JSON.stringify(raw));
        return raw;
      }
    } catch (_) {}
  }

  try {
    const body = await upstream(qs);
    const parsed = JSON.parse(body);
    const raw = parsed.list && parsed.list[0];
    if (raw) {
      setC(qs, body);
      setC(cacheKey, JSON.stringify(raw));
      return raw;
    }
  } catch (err) {
    console.warn("Video meta fetch failed for id " + vId + ": " + err.message);
  }
  return null;
}

async function serveHtml(req, res, u) {
  let html = getIndexTemplate();
  if (!html) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    return res.end("Server error: index.html missing");
  }

  const vId = u.searchParams.get("v") || u.searchParams.get("video");
  const colId = u.searchParams.get("collection") || u.searchParams.get("cat");

  let pageTitle = "p0rn - Watch Quality Videos";
  let pageDesc = "Watch high quality HD streaming videos on p0rn.";
  let pageImage = `${BASE_DOMAIN}/logo.png`;
  let pageUrl = `${BASE_DOMAIN}/`;
  let ogType = "website";
  let videoObject = null;

  if (vId) {
    pageUrl = `${BASE_DOMAIN}/?v=${encodeURIComponent(vId)}`;
    const v = await fetchVideoMeta(vId);
    if (v) {
      const cleanName = (v.name || v.source_vod_name || "Watch Video").replace(/&amp;/g, "&").replace(/&bull;/g, "•");
      const duration = v.time || "";
      const cat = (Array.isArray(v.category) && v.category[0]) || v.type_name || "Video";
      const thumb = v.thumb_url || v.poster_url || pageImage;

      pageTitle = `${cleanName} - p0rn`;
      pageDesc = `Watch ${cleanName} in HD on p0rn. Duration: ${duration || "Full length"}. Collection: ${cat}.`;
      pageImage = thumb;
      ogType = "video.other";

      let embedUrl = "";
      try {
        const ep = v.episodes && v.episodes.server_data;
        if (ep) {
          const keys = Object.keys(ep);
          if (keys.length) embedUrl = ep[keys[0]].link_embed || "";
        }
      } catch (_) {}

      videoObject = {
        name: cleanName,
        description: pageDesc,
        thumbUrl: thumb,
        embedUrl: embedUrl,
        contentUrl: pageUrl
      };
    } else {
      pageTitle = "Watch Video - p0rn";
      ogType = "video.other";
    }
  } else if (colId) {
    const catName = CATEGORY_NAMES[colId] || "Collection";
    pageTitle = `${catName} Collection - Watch HD Videos on p0rn`;
    pageDesc = `Explore the ${catName} video collection on p0rn. High quality HD video streaming.`;
    pageUrl = `${BASE_DOMAIN}/?collection=${encodeURIComponent(colId)}`;
    pageImage = `${BASE_DOMAIN}/logo.png`;
    ogType = "website";
  }

  // Safe SSR tag replacements for WhatsApp, Instagram, Telegram, Twitter & Googlebot
  html = html
    .replace(/<title id="pageTitle">[\s\S]*?<\/title>/, `<title id="pageTitle">${escapeHtml(pageTitle)}</title>`)
    .replace(/<meta name="description" id="metaDescription" content="[\s\S]*?" \/>/, `<meta name="description" id="metaDescription" content="${escapeHtml(pageDesc)}" />`)
    .replace(/<link rel="canonical" href="[\s\S]*?" id="canonicalUrl" \/>/, `<link rel="canonical" href="${escapeHtml(pageUrl)}" id="canonicalUrl" />`)
    .replace(/<link rel="image_src" href="[\s\S]*?" \/>/, `<link rel="image_src" href="${escapeHtml(pageImage)}" />`)
    .replace(/<meta property="og:type" content="[\s\S]*?" id="ogType" \/>/, `<meta property="og:type" content="${escapeHtml(ogType)}" id="ogType" />`)
    .replace(/<meta property="og:title" content="[\s\S]*?" id="ogTitle" \/>/, `<meta property="og:title" content="${escapeHtml(pageTitle)}" id="ogTitle" />`)
    .replace(/<meta property="og:description" content="[\s\S]*?" id="ogDesc" \/>/, `<meta property="og:description" content="${escapeHtml(pageDesc)}" id="ogDesc" />`)
    .replace(/<meta property="og:image" content="[\s\S]*?" id="ogImage" \/>/, `<meta property="og:image" content="${escapeHtml(pageImage)}" id="ogImage" />`)
    .replace(/<meta property="og:image:secure_url" content="[\s\S]*?" id="ogImageSecure" \/>/, `<meta property="og:image:secure_url" content="${escapeHtml(pageImage)}" id="ogImageSecure" />`)
    .replace(/<meta property="og:url" content="[\s\S]*?" id="ogUrl" \/>/, `<meta property="og:url" content="${escapeHtml(pageUrl)}" id="ogUrl" />`)
    .replace(/<meta name="twitter:title" content="[\s\S]*?" id="twTitle" \/>/, `<meta name="twitter:title" content="${escapeHtml(pageTitle)}" id="twTitle" />`)
    .replace(/<meta name="twitter:description" content="[\s\S]*?" id="twDesc" \/>/, `<meta name="twitter:description" content="${escapeHtml(pageDesc)}" id="twDesc" />`)
    .replace(/<meta name="twitter:image" content="[\s\S]*?" id="twImage" \/>/, `<meta name="twitter:image" content="${escapeHtml(pageImage)}" id="twImage" />`);

  if (videoObject) {
    const videoSchema = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Organization",
          "@id": `${BASE_DOMAIN}/#organization`,
          "name": "p0rn",
          "url": `${BASE_DOMAIN}/`,
          "logo": {
            "@type": "ImageObject",
            "url": `${BASE_DOMAIN}/logo.png`,
            "width": 1671,
            "height": 941,
            "caption": "p0rn Logo"
          },
          "image": `${BASE_DOMAIN}/logo.png`
        },
        {
          "@type": "VideoObject",
          "name": videoObject.name,
          "description": videoObject.description,
          "thumbnailUrl": [videoObject.thumbUrl],
          "uploadDate": new Date().toISOString(),
          "embedUrl": videoObject.embedUrl || "",
          "contentUrl": videoObject.contentUrl,
          "publisher": {
            "@id": `${BASE_DOMAIN}/#organization`
          }
        }
      ]
    };
    html = html.replace(
      /<script type="application\/ld\+json" id="schemaStructuredData">[\s\S]*?<\/script>/,
      `<script type="application/ld+json" id="schemaStructuredData">\n  ${JSON.stringify(videoSchema, null, 2)}\n  </script>`
    );
  }

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=60",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(html);
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

  if (u.pathname === "/api/embed") {
    if (req.method !== "GET") return json(res, 405, { code: 0, msg: "GET only" });
    return handleEmbedProxy(req, res, u);
  }

  if (u.pathname.startsWith("/api/")) return json(res, 404, { code: 0, msg: "Not found" });

  let rel = decodeURIComponent(u.pathname);
  if (rel === "/" || rel === "" || rel === "/index.html") {
    return serveHtml(req, res, u);
  }

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
    ".svg": "image/svg+xml",
    ".xml": "application/xml; charset=utf-8",
    ".txt": "text/plain; charset=utf-8"
  };
  file(res, fp, types[ext] || "application/octet-stream");
});

server.listen(PORT, () => {
  console.log("p0rn running on port " + PORT + " (" + BASE_DOMAIN + ")");
});
