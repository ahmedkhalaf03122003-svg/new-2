"use strict";

/**
 * GET /api/jobs/{id}/video — بث الناتج بدعم Range (استجابة 206 + Content-Range)
 * ليعمل التقديم/الترجيع في المشغل، و?download=1 للتحميل المباشر.
 * صفوف الـ Blobs تُحوَّل لتدفق مع تقليم أول/آخر جزء حسب المدى المطلوب.
 */

const store = require("../../../lib/db");
const { sendJson, sendError } = require("../../../lib/util");

function parseRange(header, total) {
  // bytes=start-end | bytes=-suffix | bytes=start-
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!m) return null;
  let start, end;
  if (m[1] === "" && m[2] === "") return null;
  if (m[1] === "") {
    // لاحقة: آخر N بايت
    const suffix = Number(m[2]);
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
  }
  if (start > end || start >= total) return null;
  return { start, end };
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendError(res, 405, "الطريقة غير مسموحة — استخدم GET");
    return;
  }

  const id = String(req.query.id ?? "");
  const download = req.query.download === "1" || req.query.download === "true";

  try {
    const job = await store.getJob(id);
    if (!job || job.status !== "done") {
      sendError(res, 404, "الناتج غير متاح — المهمة غير موجودة أو لم تكتمل بعد");
      return;
    }

    // الحجم الإجمالي: من سجل المهمة (يُضبط بعد الترميز)
    let total = job.size ?? 0;
    if (!total) {
      // احتياطي: اجمع أطوال الأجزاء
      total = 0;
      for await (const buf of store.readOutputChunks(id)) total += buf.length;
    }
    if (total === 0) {
      sendError(res, 404, "الناتج فارغ");
      return;
    }

    const range = parseRange(req.headers.range, total);
    const start = range ? range.start : 0;
    const end = range ? range.end : total - 1;
    const length = end - start + 1;

    const headers = {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Length": String(length),
    };
    if (range) {
      headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
    }
    if (download) {
      headers["Content-Disposition"] = `attachment; filename="merged-${id}.mp4"`;
    }
    if (req.method === "HEAD") {
      res.writeHead(range ? 206 : 200, headers);
      res.end();
      return;
    }

    res.writeHead(range ? 206 : 200, headers);

    // اقرأ الصفحات بصفوف 8 ثم اكتب الجزء المرئي للمدى فقط
    let pos = 0;
    for await (const buf of store.readOutputChunks(id)) {
      const bufStart = pos;
      const bufEnd = pos + buf.length - 1;
      pos = bufEnd + 1;
      if (bufEnd < start) continue;
      if (bufStart > end) break;
      const sliceStart = Math.max(0, start - bufStart);
      const sliceEnd = Math.min(buf.length - 1, end - bufStart);
      const piece = buf.subarray(sliceStart, sliceEnd + 1);
      if (!res.write(piece)) {
        await new Promise((r) => res.once("drain", r));
      }
    }
    res.end();
  } catch (e) {
    sendError(res, 500, `خطأ داخلي: ${e.message}`);
  }
};
