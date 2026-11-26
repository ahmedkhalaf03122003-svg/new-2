import { ProviderError } from "./providers/types";

/**
 * عميل Video Merger API v2 — بلا مفاتيح أو توثيق.
 * العنوان من MERGER_API_BASE. لا توجد معاملات resolution/fps — الناتج ثابت.
 * المخرجات MP4 (H.264 + AAC)، وكل الملفات تُحذف تلقائيًا بعد 24 ساعة.
 */

const BASE = (process.env.MERGER_API_BASE || "").replace(/\/+$/, "");

export function mergerConfigured(): boolean {
  return BASE.length > 0;
}

export function mergerBase(): string {
  return BASE;
}

const DONE_SET = new Set(["done", "completed", "complete", "success", "succeeded", "finished"]);
const FAILED_SET = new Set(["error", "failed", "failure", "cancelled", "canceled"]);

function baseHeaders(): HeadersInit {
  return { "Content-Type": "application/json" };
}

async function mergerFetch(
  path: string,
  init?: RequestInit,
  timeoutMs = 320_000, // نقطة process تتطلب حتى 300 ثانية
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!BASE) throw new ProviderError(null, "MERGER_API_BASE غير مضبوط");
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...baseHeaders(), ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ProviderError(null, `network error: ${(e as Error).message}`);
  }
  let body: Record<string, unknown> = {};
  const text = await res.text();
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

export interface MergeJobCreated {
  jobId: string;
  status: string;
  expiresAt?: string;
}

/** POST /api/jobs — إنشاء مهمة دمج */
export async function createMergeJob(urls: string[]): Promise<MergeJobCreated> {
  const { status, body } = await mergerFetch("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ videos: urls }),
  }, 20_000);
  if (status !== 200 && status !== 201) {
    throw new ProviderError(status, String(body.error ?? `فشل إنشاء مهمة الدمج (HTTP ${status})`));
  }
  const jobId = String(body.jobId ?? "");
  if (!jobId) throw new ProviderError(status, "استجابة إنشاء مهمة الدمج بلا jobId");
  return {
    jobId,
    status: String(body.status ?? "queued"),
    expiresAt: body.expiresAt ? String(body.expiresAt) : undefined,
  };
}

/**
 * POST /api/jobs/{id}/process — يُطلق مرة واحدة خلفيًا (محكي بقفل في الذاكرة عند المتصل).
 * يرجع 200 done بنتيجة كاملة، أو 202 لو قيد المعالجة، أو خطأ نهائي عند فشل معلن.
 */
export async function startMergeProcess(
  jobId: string,
): Promise<{ kind: "done"; data: MergeDoneData } | { kind: "processing" }> {
  const { status, body } = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}/process`, {
    method: "POST",
  });
  if (status === 202) return { kind: "processing" };
  if (status >= 200 && status < 300) {
    return { kind: "done", data: parseMergeDone(body, jobId) };
  }
  // أي خطأ HTTP معلن من الخدمة = فشل حتمي فوري — لا إعادة محاولة (قاعدة 6)
  throw new ProviderError(status, String(body.error ?? `فشل الدمج (HTTP ${status})`));
}

export interface MergeDoneData {
  videoUrl?: string;
  downloadUrl?: string;
  size?: number;
  duration?: number;
  resolution?: string;
  expiresAt?: string;
}

export interface MergeStatus {
  status: "queued" | "processing" | "done" | "failed";
  progress: number;
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
  size?: number;
  duration?: number;
  resolution?: string;
  expiresAt?: string;
}

function parseMergeDone(body: Record<string, unknown>, jobId: string): MergeDoneData {
  const reportedVideo = body.videoUrl ? String(body.videoUrl) : undefined;
  const downloadUrl = body.downloadUrl ? String(body.downloadUrl) : undefined;
  // رابط النتيجة: فضّل videoUrl ثم downloadUrl، وإن غابا فاضبط رابط الفيديو المباشر
  const videoUrl = reportedVideo ?? downloadUrl ?? `${BASE}/api/jobs/${encodeURIComponent(jobId)}/video`;
  return {
    videoUrl,
    downloadUrl,
    size: typeof body.size === "number" ? body.size : undefined,
    duration: typeof body.duration === "number" ? body.duration : undefined,
    resolution: body.resolution ? String(body.resolution) : undefined,
    expiresAt: body.expiresAt ? String(body.expiresAt) : undefined,
  };
}

/** GET /api/jobs/{id} — قراءة حالة دفاعية (قد يرد error بلا status → عاملها failed فورًا) */
export async function getMergeJob(jobId: string): Promise<MergeStatus> {
  const { status, body } = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, undefined, 15_000);
  if (status === 404) {
    // فشل نهائي: المهمة حُذفت أو انتهت صلاحيتها بعد 24 ساعة
    throw new ProviderError(404, "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
  }
  const rawStatus = body.status ? String(body.status).toLowerCase() : undefined;
  const err = body.error ? String(body.error) : undefined;
  const hasError = Boolean(err) && !rawStatus;

  let state: MergeStatus["status"];
  if (hasError || (rawStatus && FAILED_SET.has(rawStatus))) state = "failed";
  else if (rawStatus && DONE_SET.has(rawStatus)) state = "done";
  else if (rawStatus && ["queued", "uploading"].includes(rawStatus)) state = "queued";
  else state = "processing";

  // progress يأتي أحيانًا كسرًا 0..1 → اضربه في 100
  let progress = typeof body.progress === "number" ? body.progress : 0;
  if (progress > 0 && progress <= 1) progress *= 100;
  if (state === "done") progress = 100;

  return {
    status: state,
    progress,
    videoUrl: body.videoUrl ? String(body.videoUrl) : undefined,
    downloadUrl: body.downloadUrl ? String(body.downloadUrl) : undefined,
    error: err,
    size: typeof body.size === "number" ? body.size : undefined,
    duration: typeof body.duration === "number" ? body.duration : undefined,
    resolution: body.resolution ? String(body.resolution) : undefined,
    expiresAt: body.expiresAt ? String(body.expiresAt) : undefined,
  };
}

/** DELETE /api/jobs/{id} — تنظيف اختياري */
export async function deleteMergeJob(jobId: string): Promise<void> {
  try {
    await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }, 10_000);
  } catch {
    // التنظيف اختياري — تجاهل الأخطاء
  }
}

/** GET /api/config — حدود الخدمة الحالية (تُستخدم لفحص الجهوزية) */
export async function mergerHealthy(): Promise<boolean> {
  if (!BASE) return false;
  try {
    const res = await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(4_000) });
    return res.ok;
  } catch {
    return false;
  }
}
