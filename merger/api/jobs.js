"use strict";

/**
 * POST /api/jobs — إنشاء مهمة دمج.
 * يقبل {"videos":["رابط1","رابط2"]} أو
 *      {"sources":[{"kind":"url","url":...},{"kind":"file","name":...,"size":...,"mime":...}]}
 * يرجع 201: {jobId, status, statusUrl, processUrl, expiresAt, uploads?[]}
 */

const store = require("../lib/db");
const { sendJson, sendError, readJsonBody, genId, originOf, LIMITS } = require("../lib/util");

const URL_RE = /^https?:\/\/\S+$/i;
// منع الروابط الداخلية/الخاصة — المصادر يجب أن تكون روابط عامة مباشرة
const PRIVATE_RE = /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254|\[::1\]|\[fc|\[fd|.*\.local)(:\d+)?(\/|$)/i;

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  if (req.method !== "POST") {
    sendError(res, 405, "الطريقة غير مسموحة — استخدم POST لإنشاء مهمة");
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    sendError(res, e.code || 400, e.message);
    return;
  }

  try {
    await store.cleanupExpired(); // تنظيف كسول عند كل طلب إنشاء
    // جمع المصادر: videos (روابط) ثم sources (بنمط موحد)
    const raw = [];
    if (Array.isArray(body.videos)) {
      for (const v of body.videos) raw.push({ kind: "url", url: v });
    }
    if (Array.isArray(body.sources)) {
      for (const s of body.sources) {
        if (s && s.kind === "url") raw.push({ kind: "url", url: s.url });
        else if (s && s.kind === "file") raw.push({ kind: "file", name: s.name, size: s.size, mime: s.mime });
        else raw.push({ kind: "invalid", raw: s });
      }
    }

    if (raw.length === 0) {
      sendError(res, 400, "لا توجد مصادر — مرّر videos كروابط مباشرة أو sources كمصفوفة");
      return;
    }
    if (raw.length > LIMITS.maxSources) {
      sendError(res, 400, `أقصى عدد مصادر هو ${LIMITS.maxSources} — استلمت ${raw.length}`);
      return;
    }
    for (const s of raw) {
      if (s.kind === "invalid") {
        sendError(res, 400, "مصدر غير صالح — يجب أن يكون {kind:'url'} أو {kind:'file'}");
        return;
      }
      if (s.kind === "url") {
        if (typeof s.url !== "string" || !URL_RE.test(s.url)) {
          sendError(res, 400, "كل الروابط يجب أن تكون http/https مباشرة وعامة");
          return;
        }
        if (PRIVATE_RE.test(s.url)) {
          sendError(res, 400, "الروابط الداخلية أو الخاصة غير مسموحة — استخدم رابطًا عامًا مباشرًا");
          return;
        }
      } else {
        const size = Number(s.size);
        if (!s.name || !Number.isFinite(size) || size <= 0) {
          sendError(res, 400, "المصادر المرفوعة تحتاج name و size صالحين");
          return;
        }
        if (size > LIMITS.sourceMaxMB * 1024 * 1024) {
          sendError(res, 413, `حجم المصدر يتجاوز الحد (${LIMITS.sourceMaxMB}MB لكل مصدر)`);
          return;
        }
      }
    }

    const id = genId();
    const origin = originOf(req);
    const { expiresAt } = await store.createJob(id, raw);
    const job = await store.getJob(id);

    const response = {
      jobId: id,
      status: job.status,
      statusUrl: `${origin}/api/jobs/${id}`,
      processUrl: `${origin}/api/jobs/${id}/process`,
      expiresAt,
    };
    // إن وُجدت ملفات أعد روابط رفع لكل مصدر + حجم الجزء
    const files = job.sources.filter((s) => s.kind === "file");
    if (files.length > 0) {
      response.uploads = files.map((s) => ({
        seq: s.seq,
        url: `${origin}/api/upload?job=${id}&seq=${s.seq}&chunk=0`,
        uploadChunkBytes: LIMITS.uploadChunkBytes,
      }));
    }
    sendJson(res, 201, response);
  } catch (e) {
    sendError(res, 500, `خطأ داخلي: ${e.message}`);
  }
};
