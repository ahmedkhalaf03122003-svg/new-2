import { ProviderError, type ProviderAdapter, type ProviderTaskState } from "./types";

/**
 * مزود kie.ai — Jobs API الموحد (الأشكال التالية مقياسة فعليًا بنداءات حقيقية):
 *
 * POST /api/v1/jobs/createTask  → {"code":200,"msg":"success","data":{"taskId":"...","recordId":"..."}}
 * GET  /api/v1/jobs/recordInfo?taskId=... → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
 *        "resultJson":"{\"resultUrls\":[...]}","failMsg":...}}
 *
 * ملاحظات مقياسة:
 *  - الأخطاء تصل بـ HTTP 200 لكن code داخل الجسم (401/422/...) — نعتمد code في الجسم.
 *  - resultJson نص JSON داخل JSON ويحتاج JSON.parse ثانيًا.
 */

const KIE_BASE = "https://api.kie.ai";

interface KieEnvelope {
  code?: number;
  msg?: string;
  data?: {
    taskId?: string;
    state?: string;
    resultJson?: string;
    failMsg?: string;
    failCode?: string | number | null;
    response?: { resultUrls?: string[] };
  };
}

async function kieFetch(path: string, key: string, init?: RequestInit): Promise<KieEnvelope> {
  let res: Response;
  try {
    res = await fetch(`${KIE_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    // انقطاع شبكة/timeout → مؤقت (رمي بلا status يعامَل كـ temporary)
    throw new ProviderError(null, `network error: ${(e as Error).message}`);
  }
  let body: KieEnvelope;
  try {
    body = (await res.json()) as KieEnvelope;
  } catch {
    throw new ProviderError(res.status, `غير متوقع: استجابة غير JSON من kie.ai (HTTP ${res.status})`);
  }
  // الوضع الحقيقي: HTTP 200 مع code داخل الجسم — اعتمد code الجسم إن وُجد
  const code = typeof body.code === "number" ? body.code : res.status;
  if (code !== 200) {
    throw new ProviderError(code, body.msg || `kie.ai error code ${code}`);
  }
  return body;
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key, model, input) {
    const body = await kieFetch("/api/v1/jobs/createTask", key, {
      method: "POST",
      body: JSON.stringify({ model, input }),
    });
    const taskId = body.data?.taskId;
    if (!taskId) throw new ProviderError(200, "استجابة createTask بلا taskId");
    return { providerTaskId: taskId };
  },

  async checkTask(key, providerTaskId): Promise<ProviderTaskState> {
    const body = await kieFetch(`/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`, key);
    const data = body.data ?? {};
    const state = data.state ?? "";

    if (state === "success") {
      // resultJson نص JSON داخل JSON — parse ثانٍ؛ وإن اختل الشكل جرّب data.response.resultUrls
      let urls: string[] = [];
      try {
        const inner = JSON.parse(data.resultJson ?? "{}") as { resultUrls?: string[] };
        urls = Array.isArray(inner.resultUrls) ? inner.resultUrls.filter(Boolean) : [];
      } catch {
        urls = [];
      }
      if (urls.length === 0 && Array.isArray(data.response?.resultUrls)) {
        urls = data.response.resultUrls.filter(Boolean);
      }
      if (urls.length === 0) {
        return { status: "failed", error: "اكتملت المهمة لدى المزود دون روابط نتائج قابلة للقراءة" };
      }
      return { status: "completed", urls, progress: 100 };
    }

    if (state === "fail") {
      const msg = data.failMsg || `فشل المزود (failCode: ${data.failCode ?? "غير معروف"})`;
      return { status: "failed", error: msg };
    }

    // تقدير تقدم تقريبي — المزود لا يرسل نسبة حقيقية
    const progress = state === "generating" ? 55 : state === "queuing" ? 15 : 5;
    return { status: "processing", progress };
  },
};
