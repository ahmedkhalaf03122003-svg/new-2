"use strict";

/**
 * POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء الملفات (ثنائي ≤4MB).
 * الحد الحجمي في Vercel ≈ 4.5MB لكل طلب → الواجهة ترفع أجزاء 4MB ويعاد كل جزء
 * تقسيمه إلى صفوف 2MB في قاعدة البيانات.
 */

const store = require("../lib/db");
const { sendJson, sendError, readBody, LIMITS, httpError } = require("../lib/util");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  if (req.method !== "POST") {
    sendError(res, 405, "الطريقة غير مسموحة — استخدم POST");
    return;
  }

  const jobId = String(req.query.job ?? "");
  const seq = Number(req.query.seq);
  const chunk = Number(req.query.chunk);
  if (!jobId || !Number.isInteger(seq) || seq < 0 || !Number.isInteger(chunk) || chunk < 0) {
    sendError(res, 400, "معطيات الرفع مطلوبة: job و seq و chunk");
    return;
  }

  try {
    const job = await store.getJob(jobId);
    if (!job) {
      sendError(res, 404, "المهمة غير موجودة");
      return;
    }
    if (!["queued", "uploading"].includes(job.status)) {
      sendError(res, 409, `حالة المهمة (${job.status}) لا تسمح بالرفع`);
      return;
    }
    const source = (job.sources ?? []).find((s) => s.seq === seq);
    if (!source) {
      sendError(res, 404, "المصدر غير موجود ضمن المهمة");
      return;
    }
    if (source.kind !== "file") {
      sendError(res, 409, "المصدر رابط — لا يحتاج رفعًا");
      return;
    }

    const buf = await readBody(req, LIMITS.uploadChunkBytes + 512 * 1024);
    if (buf.length === 0) {
      sendError(res, 400, "جسم الطلب فارغ — ارفع البيانات الثنائية بـ application/octet-stream");
      return;
    }
    if (source.received + buf.length > source.size) {
      sendError(res, 413, `الحجم المستلم يتجاوز الحجم المعلن للمصدر (${source.size} بايت)`);
      return;
    }

    // الجزء الواحد (≤4MB) يُقسَّم تلقائيًا إلى صفوف 2MB داخل appendSourceChunk
    await store.appendSourceChunk(jobId, seq, chunk, buf);

    const fresh = await store.getJob(jobId);
    const src = (fresh.sources ?? []).find((s) => s.seq === seq);
    sendJson(res, 200, {
      ok: true,
      job: jobId,
      seq,
      chunk,
      received: src ? src.received : null,
      size: source.size,
      complete: src ? src.status === "ready" : false,
    });
  } catch (e) {
    if (e.code === 413) {
      sendError(res, 413, "حجم الجزء يتجاوز الحد المسموح (4MB تقريبًا)");
      return;
    }
    sendError(res, 500, `خطأ داخلي: ${e.message}`);
  }
};
