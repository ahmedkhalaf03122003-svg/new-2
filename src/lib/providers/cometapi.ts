import { ProviderError, type ProviderAdapter, type ProviderTaskState } from "./types";

/**
 * مزود CometAPI — متوافق مع OpenAI:
 *  - الصور: نقطة /v1/images/generations المتزامنة تعيد الرابط أو b64_json فورًا
 *    (شكل الخطأ مقياس فعليًا: {"error":{"message":"invalid token ..."}} + HTTP 401).
 *  - الفيديو: نقطة مهام غير متزامنة بنمط create/check. التوثيق الرسمي متغير —
 *    الحقول تُقرأ دفاعيًا (task_id|taskId|id) والنقاط قابلة للتجاوز بمتغيرات البيئة.
 */

const COMET_BASE = process.env.COMETAPI_BASE_URL || "https://api.cometapi.com";

interface CometErrorShape {
  error?: { message?: string; code?: string | number };
  message?: string;
  task_id?: string;
  taskId?: string;
  id?: string;
  status?: string;
  state?: string;
  data?: { task_id?: string; taskId?: string; id?: string; status?: string; state?: string; output?: unknown; result?: unknown; video_url?: string; url?: string };
}

function extractErrorMessage(body: CometErrorShape, httpStatus: number): string {
  const m = body.error?.message || body.message || `CometAPI HTTP ${httpStatus}`;
  return m;
}

function pickTaskId(body: CometErrorShape): string | null {
  const d = body.data ?? {};
  return (d.task_id || d.taskId || d.id || body.task_id || body.taskId || body.id || null) as string | null;
}

async function cometFetch(path: string, key: string, init?: RequestInit): Promise<{ status: number; body: CometErrorShape }> {
  let res: Response;
  try {
    res = await fetch(`${COMET_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new ProviderError(null, `network error: ${(e as Error).message}`);
  }
  let body: CometErrorShape = {};
  try {
    body = (await res.json()) as CometErrorShape;
  } catch {
    body = {};
  }
  if (!res.ok || body.error) {
    throw new ProviderError(res.status, extractErrorMessage(body, res.status));
  }
  return { status: res.status, body };
}

function pickUrls(body: CometErrorShape): string[] {
  const d = (body.data ?? body) as Record<string, unknown>;
  const candidates = [d.video_url, d.url, d.result, d.output];
  for (const c of candidates) {
    if (typeof c === "string" && /^https?:\/\//.test(c)) return [c];
    if (Array.isArray(c)) {
      const urls = c
        .map((x) => (typeof x === "string" ? x : (x as Record<string, unknown>)?.url))
        .filter((x): x is string => typeof x === "string" && /^https?:\/\//.test(x));
      if (urls.length > 0) return urls;
    }
  }
  return [];
}

export const cometApiAdapter: ProviderAdapter = {
  async createImageSync(key, model, input) {
    // ملاحظة: إذا أعاد المزود b64_json فقط دون رابط، نعيد Data URI كي يبقى "رابط نتائج"
    // قابلًا للعرض/التخزين — لا ننزّل أي وسائط على سيرفرنا (قاعدة ذهبية 1).
    const { body } = await cometFetch("/v1/images/generations", key, {
      method: "POST",
      body: JSON.stringify({
        model,
        prompt: input.prompt,
        n: 1,
        response_format: "url",
      }),
    });
    const data = (body.data as unknown as { data?: Array<{ url?: string; b64_json?: string }> })?.data ?? [];
    const item = data[0];
    if (!item) throw new ProviderError(200, "استجابة الصور بلا بيانات");
    if (item.url) return { urls: [item.url] };
    if (item.b64_json) return { urls: [`data:image/png;base64,${item.b64_json}`] };
    throw new ProviderError(200, "استجابة الصور بلا رابط ولا b64_json");
  },

  async createTask(key, model, input) {
    const { body } = await cometFetch("/v1/videos/generations", key, {
      method: "POST",
      body: JSON.stringify({ model, input }),
    });
    const taskId = pickTaskId(body);
    if (!taskId) throw new ProviderError(200, "استجابة إنشاء مهمة الفيديو بلا معرّف");
    return { providerTaskId: taskId };
  },

  async checkTask(key, providerTaskId): Promise<ProviderTaskState> {
    const { body } = await cometFetch(
      `/v1/videos/generations/${encodeURIComponent(providerTaskId)}`,
      key,
    );
    const status = String(body.status ?? body.state ?? body.data?.status ?? body.data?.state ?? "").toLowerCase();

    if (["succeeded", "success", "completed", "complete", "done", "finished"].includes(status)) {
      const urls = pickUrls(body);
      if (urls.length === 0) return { status: "failed", error: "اكتملت المهمة لدى المزود دون روابط نتائج" };
      return { status: "completed", urls, progress: 100 };
    }
    if (["failed", "error", "cancelled", "canceled"].includes(status)) {
      return { status: "failed", error: extractErrorMessage(body, 200) };
    }
    const progress = ["queued", "pending", "waiting"].includes(status) ? 10 : 50;
    return { status: "processing", progress };
  },
};
