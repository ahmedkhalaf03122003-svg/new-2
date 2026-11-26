"use strict";

/**
 * خادم تطوير محلي يحاكي بيئة Vercel:
 *  - يحلّل المسارات الديناميكية (/api/jobs/{id}/process ...) ويضعها في req.query
 *  - يحمل .env يدويًا (بلا تبعيات خارجية)
 *  - يخدم public/ كملفات ثابتة
 * التشغيل: node dev-server.js  (الافتراضي PORT=3001)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

// تحميل .env يدويًا (KEY=VALUE لكل سطر) — دون الكتابة فوق متغيرات البيئة الموجودة
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const { setCORS, sendError } = require("./lib/util");

// جدول المسارات — نفس بنية دوال Vercel
const routes = [
  { method: "POST", pattern: /^\/api\/jobs\/?$/, file: "api/jobs.js" },
  { method: "GET", pattern: /^\/api\/jobs\/?$/, file: "api/jobs.js" },
  { method: "GET", pattern: /^\/api\/config\/?$/, file: "api/config.js" },
  { method: "GET", pattern: /^\/api\/cron\/?$/, file: "api/cron.js" },
  { method: "POST", pattern: /^\/api\/upload\/?$/, file: "api/upload.js" },
  { method: null, pattern: /^\/api\/jobs\/([^/]+)\/?$/, file: "api/jobs/[id].js", param: "id" },
  { method: "POST", pattern: /^\/api\/jobs\/([^/]+)\/process\/?$/, file: "api/jobs/[id]/process.js", param: "id" },
  { method: "GET", pattern: /^\/api\/jobs\/([^/]+)\/video\/?$/, file: "api/jobs/[id]/video.js", param: "id" },
  { method: null, pattern: /^\/api\/jobs\/([^/]+)\/video\/?$/, file: "api/jobs/[id]/video.js", param: "id" },
];

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url || "/", true);
  const pathname = decodeURIComponent(parsed.pathname || "/");

  setCORS(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // مطابقة مسارات API
    for (const route of routes) {
      if (route.method && req.method !== route.method) continue;
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      req.query = { ...parsed.query };
      if (route.param) req.query[route.param] = m[1];
      const handler = require(path.join(__dirname, route.file));
      await handler(req, res);
      return;
    }

    // ملفات ثابتة من public/
    let filePath = pathname === "/" ? "/index.html" : pathname;
    filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
    const abs = path.join(PUBLIC_DIR, filePath);
    if (abs.startsWith(PUBLIC_DIR) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      res.writeHead(200, { "Content-Type": MIME[path.extname(abs)] ?? "application/octet-stream" });
      fs.createReadStream(abs).pipe(res);
      return;
    }

    sendError(res, 404, "المسار غير موجود");
  } catch (e) {
    console.error("[dev-server]", e);
    if (!res.headersSent) sendError(res, 500, `خطأ داخلي: ${e.message}`);
    else res.end();
  }
});

const PORT = Number(process.env.PORT || 3001);
server.listen(PORT, () => {
  console.log(`✅ خادم تطوير خدمة الدمج يعمل على http://localhost:${PORT}`);
  console.log(`   المحلي:  GET  http://localhost:${PORT}/api/config`);
});
