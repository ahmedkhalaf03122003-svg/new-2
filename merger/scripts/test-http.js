"use strict";

/**
 * اختبار HTTP كامل ضد خادم التطوير المحلي (شغّله بعد تشغيل: npm run dev):
 *  - إنشاء مهمة من روابط → دمج → بث مع Range 206
 *  - مهمة مختلطة (رابط + ملف مرفوع بأجزاء)
 *  - حذف → 404 → JSON تالف → قائمة فارغة → تجاوز عدد المصادر → رابط خاص مرفوض
 * تشغيل: node scripts/test-http.js [baseUrl]
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const engine = require("../lib/engine");

const BASE = process.argv[2] || process.env.BASE || "http://localhost:3001";

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

async function api(method, path, body, headers) {
  const res = await fetch(BASE + path, {
    method,
    headers: headers ?? (body ? { "Content-Type": "application/json" } : undefined),
    body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json, headers: res.headers };
}

async function makeTestClip(dir, name, w, h, secs, withAudio) {
  const file = path.join(dir, name);
  const ffmpeg = (await engine.ensureExecutable()).ffmpeg;
  const r = spawnSync(ffmpeg, [
    "-y",
    "-f", "lavfi", "-i", `testsrc=size=${w}x${h}:rate=25:duration=${secs}`,
    ...(withAudio ? ["-f", "lavfi", "-i", `sine=frequency=330:duration=${secs}`] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    ...(withAudio ? ["-c:a", "aac", "-shortest"] : []),
    file,
  ], { stdio: "pipe" });
  if (r.status !== 0) throw new Error(`فشل توليد ${name}`);
  return file;
}

async function main() {
  console.log(`=== اختبار HTTP ضد ${BASE} ===`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merger-http-"));
  const testDir = path.join(__dirname, "..", "public", "test");
  fs.mkdirSync(testDir, { recursive: true }); // يُخدم من dev-server ويُحذف بعد الاختبار

  const createdJobs = [];
  try {
    // 0) جهوزية
    const cfg = await api("GET", "/api/config");
    check("GET /api/config يعمل", cfg.status === 200 && cfg.json.ok === true && cfg.json.limits.maxSources === 10);

    // 1) مهمة من روابط عامة مباشرة (نفس نمط معيار القبول 8 — دقتان مختلفتان)
    const PUBLIC_A = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4";
    const PUBLIC_B = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_2MB.mp4";

    const j1 = await api("POST", "/api/jobs", {
      videos: [PUBLIC_A, PUBLIC_B],
    });
    check("إنشاء مهمة من روابط → 201", j1.status === 201 && j1.json.jobId, JSON.stringify(j1.json).slice(0, 200));
    const job1 = j1.json.jobId;
    createdJobs.push(job1);
    check("statusUrl و processUrl موجودان", Boolean(j1.json.statusUrl && j1.json.processUrl));

    // 2) تنفيذ الدمج → done
    const p1 = await api("POST", `/api/jobs/${job1}/process`);
    check("process → done", p1.status === 200 && p1.json.status === "done", JSON.stringify(p1.json).slice(0, 300));
    check("روابط النتيجة على نطاق الخدمة", String(p1.json.videoUrl).startsWith(BASE));

    // 3) بث الفيديو: 200 كامل + Range 206
    const vidRes = await fetch(`${BASE}/api/jobs/${job1}/video`, { method: "GET" });
    const fullBuf = Buffer.from(await vidRes.arrayBuffer());
    check("بث كامل 200 بطول مطابق", vidRes.status === 200 && fullBuf.length === p1.json.size, `${fullBuf.length} مقابل ${p1.json.size}`);
    check("Content-Type: video/mp4", vidRes.headers.get("content-type") === "video/mp4");

    const r1 = await fetch(`${BASE}/api/jobs/${job1}/video`, { headers: { Range: "bytes=0-99" } });
    const b1 = Buffer.from(await r1.arrayBuffer());
    check("Range 0-99 → 206", r1.status === 206 && b1.length === 100, `status=${r1.status} len=${b1.length}`);
    check("Content-Range صحيح", r1.headers.get("content-range") === `bytes 0-99/${fullBuf.length}`);
    check("Accept-Ranges: bytes", r1.headers.get("accept-ranges") === "bytes");

    const r2 = await fetch(`${BASE}/api/jobs/${job1}/video`, { headers: { Range: `bytes=${fullBuf.length - 50}-` } });
    const b2 = Buffer.from(await r2.arrayBuffer());
    check("Range لاحقة (آخر 50 بايت) → 206", r2.status === 206 && b2.length === 50);
    check("تطابق المحتوى مع البث الكامل", b2.equals(fullBuf.subarray(fullBuf.length - 50)));

    const r3 = await fetch(`${BASE}/api/jobs/${job1}/video?download=1`);
    check("download=1 يعطي Content-Disposition", String(r3.headers.get("content-disposition") || "").includes("attachment"));

    // 4) مهمة مختلطة (رابط + ملف مرفوع بأجزاء 4MB)
    const bigClip = await makeTestClip(tmp, "big.mp4", 480, 270, 5, true);
    const bigBuf = fs.readFileSync(bigClip);
    const j2 = await api("POST", "/api/jobs", {
      sources: [
        { kind: "url", url: PUBLIC_A },
        { kind: "file", name: "big.mp4", size: bigBuf.length, mime: "video/mp4" },
      ],
    });
    check("إنشاء مهمة مختلطة → 201", j2.status === 201 && Array.isArray(j2.json.uploads), JSON.stringify(j2.json).slice(0, 200));
    const job2 = j2.json.jobId;
    createdJobs.push(job2);

    // رفع الأجزاء 1MB هنا (النص صغير؛ الواجهة ترفع 4MB)
    const chunkSize = 1024 * 1024;
    const nChunks = Math.ceil(bigBuf.length / chunkSize);
    for (let k = 0; k < nChunks; k++) {
      const part = bigBuf.subarray(k * chunkSize, Math.min(bigBuf.length, (k + 1) * chunkSize));
      const up = await fetch(`${BASE}/api/upload?job=${job2}&seq=1&chunk=${k}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: part,
      });
      if (!up.ok) {
        check("رفع جزء", false, `part ${k} status=${up.status}`);
        break;
      }
      if (k === nChunks - 1) check("رفع الأجزاء اكتمل", true);
    }
    const p2 = await api("POST", `/api/jobs/${job2}/process`);
    check("دمج المهمة المختلطة → done", p2.status === 200 && p2.json.status === "done", JSON.stringify(p2.json).slice(0, 300));
    check("دقة المهمة المختلطة = أكبر دقة", p2.json.resolution === "640x360", String(p2.json.resolution));
    // بعد النجاح تُحذف أجزاء المصادر — الناتج فقط يبقى
    const g2 = await api("GET", `/api/jobs/${job2}`);
    check("المصدر المرفوع محذوف الأجزاء بعد النجاح", (g2.json.sources || []).every((s) => s.status === "ready" || s.kind === "url"));

    // 5) process لمهمة مكتملة يعيد النتيجة نفسها (idempotent)
    const pAgain = await api("POST", `/api/jobs/${job1}/process`);
    check("process مكرر يعيد done نفسها", pAgain.status === 200 && pAgain.json.status === "done");

    // 6) أخطاء صحيحة
    const badJson = await api("POST", "/api/jobs", "{not json", { "Content-Type": "application/json" });
    check("JSON تالف → 400", badJson.status === 400, `status=${badJson.status}`);
    const empty = await api("POST", "/api/jobs", { videos: [] });
    check("قائمة فارغة → 400", empty.status === 400);
    const tooMany = await api("POST", "/api/jobs", { videos: Array.from({ length: 11 }, (_, i) => `https://example.com/v${i}.mp4`) });
    check("أكثر من 10 مصادر → 400", tooMany.status === 400, String(tooMany.json.error).slice(0, 100));
    const privateUrl = await api("POST", "/api/jobs", { videos: ["http://localhost:3000/x.mp4", "http://127.0.0.1/y.mp4"] });
    check("روابط خاصة/داخلية مرفوضة", privateUrl.status === 400);
    const notFound = await api("GET", "/api/jobs/nope123");
    check("مهمة غير موجودة → 404", notFound.status === 404);
    const delThenGet = await api("DELETE", `/api/jobs/${job2}`);
    check("حذف فوري شامل", delThenGet.status === 200 && delThenGet.json.ok === true);
    const afterDel = await api("GET", `/api/jobs/${job2}`);
    check("بعد الحذف → 404", afterDel.status === 404);
    createdJobs.length = 0; // job2 حُذف

    const wrongMethod = await api("PUT", `/api/jobs/${job1}`);
    check("طريقة خاطئة → 405", wrongMethod.status === 405);

    console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
    process.exitCode = failed > 0 ? 1 : 0;
  } finally {
    // تنظيف: حذف المهام المتبقية وملفات الاختبار المحلية
    for (const id of createdJobs) {
      try { await api("DELETE", `/api/jobs/${id}`); } catch {}
    }
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    console.log("🧹 تم تنظيف بيانات الاختبار");
  }
}

main().catch((e) => {
  console.error("💥 فشل غير متوقع:", e);
  process.exit(1);
});
