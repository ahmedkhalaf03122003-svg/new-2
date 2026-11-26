"use strict";

/**
 * اختبار وحدات محرك الدمج والتخزين (يُشغَّل: npm test داخل merger/)
 * 1) توليد فيديوهين مختلفي الدقة بـ ffmpeg (أحداهما بلا صوت)
 * 2) دمجهما مباشرة عبر lib/engine
 * 3) التحقق: اكتمال الدمج، الدقة = أكبر دقة مدخل، المدة ≈ مجموع المدد، وجود الصوت
 * 4) اختبار التخزين في Turso والاسترجاع بتطابق sha256 + مسار رفع الأجزاء + الحذف الشامل
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const engine = require("../lib/engine");
const store = require("../lib/db");
const { LIMITS } = require("../lib/util");

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`✅ ${name}`);
  } else {
    failed++;
    console.log(`❌ ${name}${detail ? " — " + detail : ""}`);
  }
}

// تحميل .env للتجربة المحلية
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

async function makeTestClip(dir, name, w, h, secs, withAudio) {
  const file = path.join(dir, name);
  const args = [
    "-y",
    "-f", "lavfi",
    "-i", `testsrc=size=${w}x${h}:rate=25:duration=${secs}`,
    ...(withAudio ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${secs}`] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    ...(withAudio ? ["-c:a", "aac", "-shortest"] : []),
    file,
  ];
  const ffmpeg = (await engine.ensureExecutable()).ffmpeg;
  const r = spawnSync(ffmpeg, args, { stdio: "pipe" });
  if (r.status !== 0) throw new Error(`فشل توليد ${name}: ${r.stderr.toString().slice(-300)}`);
  return file;
}

async function main() {
  console.log("=== اختبار وحدات خدمة الدمج ===");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merger-unit-"));
  const jobId = "unit" + crypto.randomBytes(4).toString("hex");

  try {
    // 1) توليد فيديوهين مختلفي الدقة (الأول بلا صوت)
    const a = await makeTestClip(tmp, "a.mp4", 320, 240, 4, false);
    const b = await makeTestClip(tmp, "b.mp4", 640, 360, 3, true);
    const pa = await engine.probe(a);
    const pb = await engine.probe(b);
    check("ffprobe: أبعاد المصدر الأول", pa.width === 320 && pa.height === 240, `${pa.width}x${pa.height}`);
    check("ffprobe: المصدر الأول بلا صوت", pa.hasAudio === false);
    check("ffprobe: المصدر الثاني فيه صوت", pb.hasAudio === true);
    check("الحدود من البيئة", LIMITS.maxSources === 10 && LIMITS.sourceMaxMB === 200);

    // 2) الدمج المباشر عبر المحرك
    const output = path.join(tmp, "merged.mp4");
    let progressSeen = 0;
    await engine.mergeVideos({
      inputs: [
        { file: a, probe: pa },
        { file: b, probe: pb },
      ],
      output,
      onProgress: (f) => (progressSeen = Math.max(progressSeen, f)),
    });
    const po = await engine.probe(output);
    check("اكتمل الدمج والملف موجود", fs.existsSync(output) && fs.statSync(output).size > 10_000);
    check("الدقة = أكبر دقة مدخل (640x360)", po.width === 640 && po.height === 360, `${po.width}x${po.height}`);
    check(
      "المدة ≈ مجموع المدد (7 ث ±1.5)",
      Math.abs(po.duration - (pa.duration + pb.duration)) <= 1.5,
      `${po.duration} مقابل ${pa.duration + pb.duration}`,
    );
    check("الناتج فيه صوت (مسار صامت للمصدر الأول)", po.hasAudio === true);
    check("تقدم الترميز يُقرأ من ffmpeg", progressSeen > 0.5, `آخر تقدم ${Math.round(progressSeen * 100)}%`);

    // 3) التخزين في Turso والاسترجاع بتطابق sha256 (ناتج 6MB عشوائي → أجزاء 2MB)
    const blob = crypto.randomBytes(6 * 1024 * 1024);
    await store.writeOutputChunks(jobId, blob);
    const chunks = [];
    for await (const buf of store.readOutputChunks(jobId)) chunks.push(buf);
    const assembled = Buffer.concat(chunks);
    const h1 = crypto.createHash("sha256").update(blob).digest("hex");
    const h2 = crypto.createHash("sha256").update(assembled).digest("hex");
    check("تخزين Turso: استرجاع الناتج بتطابق sha256", h1 === h2, `${h1.slice(0, 12)} مقابل ${h2.slice(0, 12)}`);

    // 4) مسار رفع الأجزاء: 3 أجزاء غير منتظمة → تجميع متطابق
    const part1 = crypto.randomBytes(1024 * 1024);
    const part2 = crypto.randomBytes(3 * 1024 * 1024);
    const part3 = crypto.randomBytes(700 * 1024);
    const upId = "up" + crypto.randomBytes(4).toString("hex");
    await store.createJob(upId, [{ kind: "file", name: "test.mp4", size: part1.length + part2.length + part3.length, mime: "video/mp4" }]);
    await store.appendSourceChunk(upId, 0, 0, part1);
    await store.appendSourceChunk(upId, 0, 1, part2);
    await store.appendSourceChunk(upId, 0, 2, part3);
    const got = [];
    for await (const buf of store.readSourceChunks(upId, 0)) got.push(buf);
    const gotBuf = Buffer.concat(got);
    const hu = crypto.createHash("sha256").update(Buffer.concat([part1, part2, part3])).digest("hex");
    const hg = crypto.createHash("sha256").update(gotBuf).digest("hex");
    check("رفع الأجزاء: التجميع بتطابق sha256", hu === hg);
    const jobAfter = await store.getJob(upId);
    check("عدّاد المستلم واتمام المصدر", jobAfter.sources[0].received === part1.length + part2.length + part3.length && jobAfter.sources[0].status === "ready");

    // 5) الحذف الشامل يزيل كل الصفوف
    await store.deleteJob(upId);
    const gone = await store.getJob(upId);
    check("الحذف الشامل للمهمة", gone === null);

    console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
    process.exitCode = failed > 0 ? 1 : 0;
  } finally {
    // تنظيف بيانات اختبار Turso
    try { await store.deleteJob(jobId); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("💥 فشل غير متوقع:", e);
  process.exit(1);
});
