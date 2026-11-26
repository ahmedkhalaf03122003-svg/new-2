"use strict";

/**
 * POST /api/jobs/{id}/process — تنفيذ الدمج كاملًا (متزامن): سحب المصادر ← ترميز ← حفظ.
 * يرجع مباشرة {"status":"done","videoUrl":...,...} أو 202 لو قيد المعالجة، أو 500 عند فشل معلن.
 *
 * التقدم: 0-40 سحب المصادر، 40-90 ترميز ffmpeg، 100 اكتمال.
 * لا اعتماد على نظام ملفات دائم — /tmp فقط أثناء المعالجة ونظّفه في finally.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const store = require("../../../lib/db");
const engine = require("../../../lib/engine");
const { sendJson, sendError, originOf, LIMITS } = require("../../../lib/util");

/** تنزيل مصدر رابط إلى /tmp مع عدّ بايتات وفرض الحد */
async function downloadSource(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (HTTP ${res.status})`);
  }
  const contentLength = Number(res.headers.get("content-length") || 0);
  if (contentLength > LIMITS.sourceMaxMB * 1024 * 1024) {
    throw new Error(`حجم المصدر يتجاوز الحد (${LIMITS.sourceMaxMB}MB)`);
  }
  const writer = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let bytes = 0;
  await new Promise((resolve, reject) => {
    writer.on("error", reject);
    (async function pump() {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > LIMITS.sourceMaxMB * 1024 * 1024) {
            writer.destroy();
            reject(new Error(`حجم المصدر يتجاوز الحد (${LIMITS.sourceMaxMB}MB)`));
            return;
          }
          if (!writer.write(Buffer.from(value))) {
            await new Promise((r) => writer.once("drain", r));
          }
        }
        writer.end(resolve);
      } catch (e) {
        writer.destroy();
        reject(e);
      }
    })();
  });
  return bytes;
}

/** تجميع مصدر مرفوع من صفوف قاعدة البيانات إلى ملف /tmp */
async function materializeUploaded(jobId, seq, dest) {
  const out = fs.createWriteStream(dest);
  for await (const buf of store.readSourceChunks(jobId, seq)) {
    if (!out.write(buf)) {
      await new Promise((r) => out.once("drain", r));
    }
  }
  await new Promise((r) => out.end(r));
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  if (req.method !== "POST") {
    sendError(res, 405, "الطريقة غير مسموحة — استخدم POST");
    return;
  }

  const id = String(req.query.id ?? "");
  const origin = originOf(req);

  try {
    const job = await store.getJob(id);
    if (!job) {
      sendError(res, 404, "المهمة غير موجودة");
      return;
    }

    // idempotence: مكتملة → أعِد النتيجة نفسها؛ قيد المعالجة → 202
    if (job.status === "done") {
      sendJson(res, 200, donePayload(job));
      return;
    }
    if (job.status === "processing") {
      sendJson(res, 202, { status: "processing", progress: job.progress });
      return;
    }
    if (job.status === "failed") {
      sendError(res, 500, job.error || "فشلت المهمة سابقًا");
      return;
    }

    // المصادر المرفوعة يجب أن تكون مكتملة
    const incomplete = (job.sources ?? []).filter((s) => s.kind === "file" && s.status !== "ready");
    if (incomplete.length > 0) {
      sendError(res, 409, `الرفع غير مكتمل للمصادر: ${incomplete.map((s) => s.seq).join(", ")}`);
      return;
    }

    await store.updateJob(id, { status: "processing", progress: 2, error: null });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `merge-${id}-`));
    try {
      const total = job.sources.length;
      const inputs = [];
      let fetched = 0;
      for (const s of job.sources) {
        const file = path.join(tmpDir, `src-${s.seq}.bin`);
        if (s.kind === "url") {
          // 0-40: سحب المصادر
          await store.updateJob(id, { progress: Math.round(5 + (fetched / total) * 30) });
          await downloadSource(s.url, file);
          fetched++;
        } else {
          await materializeUploaded(id, s.seq, file);
        }
        const probe = await engine.probe(file);
        inputs.push({ file, probe });
      }

      // فحص الحدود قبل الترميز: المدة الإجمالية
      const totalDuration = inputs.reduce((a, i) => a + i.probe.duration, 0);
      if (totalDuration > LIMITS.maxTotalDurationSec) {
        throw new Error(`مجموع مدد المقاطع يتجاوز ${LIMITS.maxTotalDurationSec} ثانية (${Math.round(totalDuration)} ثانية)`);
      }

      await store.updateJob(id, { progress: 40 });
      const output = path.join(tmpDir, "output.mp4");
      await engine.mergeVideos({
        inputs,
        output,
        onProgress: (frac) => {
          // 40-90: ترميز — اكتب التقدم في القاعدة كل تحديث
          void store.updateJob(id, { progress: Math.round(40 + frac * 50) }).catch(() => {});
        },
      });

      const st = await fs.promises.stat(output);
      if (st.size > LIMITS.outputMaxMB * 1024 * 1024) {
        throw new Error(`حجم الناتج يتجاوز الحد (${LIMITS.outputMaxMB}MB)`);
      }

      const outProbe = await engine.probe(output);
      await store.updateJob(id, { progress: 95 });

      // خزّن الناتج في قاعدة البيانات (صفوف 2MB)
      const data = await fs.promises.readFile(output);
      await store.writeOutputChunks(id, data);

      const videoUrl = `${origin}/api/jobs/${id}/video`;
      const downloadUrl = `${videoUrl}?download=1`;
      await store.updateJob(id, {
        status: "done",
        progress: 100,
        size: st.size,
        duration: Math.round(outProbe.duration * 100) / 100,
        resolution: `${outProbe.width}x${outProbe.height}`,
        video_url: videoUrl,
        download_url: downloadUrl,
        processed_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      });
      await store.deleteSourceChunks(id); // بعد النجاح: الناتج فقط هو المطلوب

      const fresh = await store.getJob(id);
      sendJson(res, 200, donePayload(fresh));
    } finally {
      // نظّف /tmp دائمًا
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch (e) {
    // فشل معلن = فشل نهائي: سجّله وأعد 500 (لا إعادة محاولة تعطي نتيجة مختلفة)
    try {
      await store.updateJob(id, { status: "failed", error: String(e.message || e).slice(0, 500) });
    } catch {
      /* تجاهل */
    }
    sendError(res, 500, String(e.message || e));
  }
};

function donePayload(job) {
  return {
    status: "done",
    videoUrl: job.videoUrl,
    downloadUrl: job.downloadUrl,
    size: job.size,
    duration: job.duration,
    resolution: job.resolution,
    expiresAt: job.expiresAt,
  };
}
