"use strict";

/**
 * محرك الدمج — ffmpeg/ffprobe داخل الدالة نفسها.
 * جودة عالية إلزامية: libx264 CRF 18 + AAC 192k/44100 + +faststart، MP4 يعمل فورًا على الويب.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

let binariesCache = null;

/**
 * الثنائي قد يفقد صلاحية التنفيذ في الاستضافة → انسخه إلى /tmp بصلاحية 755 عند الحاجة.
 * النسخة تُخزَّن في ذاكرة المثيل الواحد (مرة واحدة لكل cold start).
 */
async function ensureExecutable() {
  if (binariesCache) return binariesCache;
  const ffmpegSrc = process.env.FFMPEG_PATH || require("ffmpeg-static");
  const ffprobeMod = require("ffprobe-static");
  const ffprobeSrc = process.env.FFPROBE_PATH || (ffprobeMod && ffprobeMod.path);

  const out = {};
  for (const [name, src] of [
    ["ffmpeg", ffmpegSrc],
    ["ffprobe", ffprobeSrc],
  ]) {
    if (!src) throw new Error(`ثنائي ${name} غير موجود`);
    const dest = path.join(os.tmpdir(), `merger-${name}`);
    let usable = false;
    try {
      await fs.promises.access(dest, fs.constants.X_OK);
      const st = await fs.promises.stat(dest);
      usable = st.isFile() && st.size > 1024 * 1024;
    } catch {
      usable = false;
    }
    if (!usable) {
      await fs.promises.copyFile(src, dest);
      await fs.promises.chmod(dest, 0o755);
    }
    out[name] = dest;
  }
  binariesCache = out;
  return out;
}

function even(v) {
  return Math.max(2, 2 * Math.floor(v / 2)); // أبعاد زوجية إلزامية لـ yuv420p
}

/** ffprobe لكل مصدر: الدقة، معدل الإطارات، المدة، وجود صوت */
async function probe(file) {
  const { ffprobe } = await ensureExecutable();
  const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file];
  const raw = await new Promise((resolve, reject) => {
    const p = spawn(ffprobe, args);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`ffprobe فشل (${code}): ${err.slice(0, 300)}`))));
  });
  const info = JSON.parse(raw);
  const v = (info.streams || []).find((s) => s.codec_type === "video");
  const a = (info.streams || []).find((s) => s.codec_type === "audio");
  if (!v) throw new Error("الملف لا يحتوي مسار فيديو صالح");
  const fpsParts = String(v.r_frame_rate || "30/1").split("/");
  const fps = fpsParts.length === 2 && Number(fpsParts[1]) > 0 ? Number(fpsParts[0]) / Number(fpsParts[1]) : Number(fpsParts[0]) || 30;
  return {
    width: Number(v.width),
    height: Number(v.height),
    fps: Math.round(fps * 100) / 100,
    hasAudio: Boolean(a),
    duration: Number((info.format && info.format.duration) || v.duration || 0),
  };
}

/**
 * الدمج: توحيد كل المصادر عبر filter_complex (scale+pad إلى أكبر دقة، fps=30،
 * setsar=1، format=yuv420p) ثم concat. مصدر بلا صوت؟ مسار صامت anullsrc بنفس مدته.
 */
async function mergeVideos({ inputs, output, onProgress }) {
  const { ffmpeg } = await ensureExecutable();
  const preset = process.env.FFMPEG_PRESET || "medium";

  const totalDuration = inputs.reduce((s, i) => s + (i.probe.duration || 0), 0);
  const maxW = even(Math.min(1920, Math.max(...inputs.map((i) => i.probe.width))));
  const maxH = even(Math.min(1080, Math.max(...inputs.map((i) => i.probe.height))));

  const args = ["-y"];
  const filters = [];
  const concatPairs = [];

  // مدخلات المصادر أُولًا
  for (let i = 0; i < inputs.length; i++) {
    args.push("-i", inputs[i].file);
  }
  // مصدر بلا صوت؟ مدخل anullsrc صامت بنفس مدته بدل أن يفشل الدمج (القسم 4)
  const silentAudioMap = new Map();
  let lavfiIdx = inputs.length;
  for (let i = 0; i < inputs.length; i++) {
    if (!inputs[i].probe.hasAudio) {
      const dur = Math.max(0.1, inputs[i].probe.duration || 0);
      args.push("-f", "lavfi", "-t", String(dur), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
      silentAudioMap.set(i, lavfiIdx);
      lavfiIdx++;
    }
  }

  for (let i = 0; i < inputs.length; i++) {
    filters.push(
      `[${i}:v]scale=${maxW}:${maxH}:force_original_aspect_ratio=decrease,` +
        `pad=${maxW}:${maxH}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`,
    );
    if (inputs[i].probe.hasAudio) {
      filters.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo[a${i}]`);
    } else {
      filters.push(`[${silentAudioMap.get(i)}:a]aresample=44100,aformat=channel_layouts=stereo[a${i}]`);
    }
    concatPairs.push(`[v${i}][a${i}]`);
  }

  const filterComplex = `${filters.join(";")};${concatPairs.join("")}concat=n=${inputs.length}:v=1:a=1[vc][ac]`;
  args.push(
    "-filter_complex",
    filterComplex,
    "-map",
    "[vc]",
    "-map",
    "[ac]",
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "44100",
    "-movflags",
    "+faststart",
    "-progress",
    "pipe:1",
    "-nostats",
    output,
  );

  await new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args);
    let err = "";
    let buf = "";
    p.stdout.on("data", (d) => {
      // قراءة out_time_us من -progress pipe:1 وحساب النسبة من المدة الإجمالية
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line.trim());
        if (m && totalDuration > 0 && onProgress) {
          const frac = Math.min(1, Number(m[1]) / 1e6 / totalDuration);
          onProgress(frac);
        }
      }
    });
    p.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > 16_000) err = err.slice(-8_000);
    });
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`فشل ترميز ffmpeg (رمز ${code}): ${err.split("\n").slice(-6).join(" | ").slice(0, 600)}`));
    });
  });
}

module.exports = { ensureExecutable, probe, mergeVideos, even };
