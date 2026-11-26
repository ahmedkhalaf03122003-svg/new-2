"use strict";

/**
 * أدوات مساعدة مشتركة لدوال الـ API — CommonJS خالص.
 */

const crypto = require("crypto");

// الحدود القابلة للضبط من البيئة (القسم 6 من المواصفة)
const LIMITS = {
  maxSources: Number(process.env.MAX_SOURCES || 10),
  sourceMaxMB: Number(process.env.SOURCE_MAX_MB || 200),
  outputMaxMB: Number(process.env.OUTPUT_MAX_MB || 150),
  maxTotalDurationSec: Number(process.env.MAX_TOTAL_DURATION_SEC || 600),
  uploadChunkBytes: 4 * 1024 * 1024, // أقل من حد 4.5MB في Vercel
};

const VERSION = "1.0.0";

function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
}

function sendJson(res, status, obj) {
  setCORS(res);
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

/** قراءة جسم الطلب كـ Buffer مع حد أقصى (حماية من الطلبات العملاقة) */
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(Object.assign(new Error("BODY_TOO_LARGE"), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** قراءة جسم JSON بحجم محدود */
async function readJsonBody(req, limitBytes = 1024 * 1024) {
  const buf = await readBody(req, limitBytes);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    const e = new Error("جسم الطلب ليس JSON صالحًا");
    e.code = 400;
    throw e;
  }
}

function genId() {
  return crypto.randomBytes(6).toString("hex"); // 12 حرفًا مثل مثال المواصفة
}

/** رابط الأصل من ترويسات الطلب — لبناء روابط النتيجة */
function originOf(req) {
  // Vercel يضبط x-forwarded-proto=https دائمًا؛ محليًا نتبع نوع الاتصال الفعلي
  const fwd = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = fwd || (req.socket && req.socket.encrypted ? "https" : "http");
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3001";
  return `${proto}://${host}`;
}

function expiresAtSql() {
  // datetime('now', '+24 hours') بصيغة SQLite — نحسبها سيرفريًا لنفس النتيجة
  return new Date(Date.now() + 24 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = {
  LIMITS,
  VERSION,
  setCORS,
  sendJson,
  sendError,
  readBody,
  readJsonBody,
  genId,
  originOf,
  expiresAtSql,
  httpError,
};
