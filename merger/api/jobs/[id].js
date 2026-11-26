"use strict";

/**
 * GET /api/jobs/{id}    — الحالة + التقدم (0-100) + الرابط عند الاكتمال
 * DELETE /api/jobs/{id} — حذف فوري شامل (jobs + sources + source_chunks + output_chunks)
 */

const store = require("../../lib/db");
const { sendJson, sendError, originOf, httpError } = require("../../lib/util");

function publicJob(job) {
  return {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    videoUrl: job.videoUrl,
    downloadUrl: job.downloadUrl,
    size: job.size,
    duration: job.duration,
    resolution: job.resolution,
    error: job.error,
    expiresAt: job.expiresAt,
    createdAt: job.createdAt,
    sources: (job.sources ?? []).map((s) => ({
      seq: s.seq,
      kind: s.kind,
      name: s.name,
      size: s.size,
      received: s.received,
      status: s.status,
    })),
  };
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  const id = String(req.query.id ?? "");
  if (!id) {
    sendError(res, 400, "معرّف المهمة مطلوب");
    return;
  }

  try {
    if (req.method === "GET") {
      const job = await store.getJob(id);
      if (!job) {
        sendError(res, 404, "المهمة غير موجودة (قد تكون حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
        return;
      }
      sendJson(res, 200, publicJob(job));
      return;
    }

    if (req.method === "DELETE") {
      const job = await store.getJob(id);
      if (!job) {
        sendError(res, 404, "المهمة غير موجودة");
        return;
      }
      await store.deleteJob(id);
      sendJson(res, 200, { ok: true, deleted: id });
      return;
    }

    sendError(res, 405, "الطريقة غير مسموحة — استخدم GET أو DELETE");
  } catch (e) {
    sendError(res, 500, `خطأ داخلي: ${e.message}`);
  }
};
