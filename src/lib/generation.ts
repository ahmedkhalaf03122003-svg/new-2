import { randomUUID } from "crypto";
import {
  getTurso,
  ensureSchema,
  insertTask,
  getTask,
  updateTask,
  type Task,
  type TaskAttempt,
  type MediaType,
} from "./turso";
import {
  getKeyPool,
  bumpKeyCounters,
  classifyProviderError,
  isKeyOrBalanceFailure,
  type RawKey,
} from "./keys";
import { findModel, MERGE_MODEL, type ModelDef } from "./models";
import { kieAdapter } from "./providers/kie";
import { cometApiAdapter } from "./providers/cometapi";
import { ParamsError, ProviderError, NoKeysError, type ProviderAdapter } from "./providers/types";
import * as merger from "./merger";

/**
 * منسق التوليد — التبديل التسلسلي الصارم «لا توقف أبدًا»:
 * 1. المفاتيح تُجرَّب بترتيب الإضافة حتى نجاح الإنشاء.
 * 2. فشل مفتاح/رصيد في منتصف المهمة → إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي.
 * 3. فشل على كل المفاتيح → تبقى processing وتُعاد مع كل get_task (بتهدئة 45 ثانية).
 * 4. نموذج الذكاء الاصطناعي لا يرى أخطاء مفاتيح/رصيد أبدًا (قاعدة ذهبية 4).
 */

const ADAPTERS: Record<string, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometApiAdapter,
};

const INTERNAL_WAITING = "بانتظار توفر مفتاح صالح…";
const RETRY_COOLDOWN_MS = 45_000; // تهدئة بين محاولات إعادة الإنشاء حتى لا نضغط المزودين
const POLL_INTERVAL_MS = 3_000; // استعلام كل 3 ثوانٍ أثناء نافذة الانتظار
const DEFAULT_WAIT: Record<MediaType, number> = { image: 90, video: 25, merge: 60 };

export type NotifyFn = (progress: number, message: string) => Promise<void> | void;

/** قفل في الذاكرة لطلب process مرة واحدة فقط لكل مهمة دمج (قسم 7.3.3) */
const processInFlight = new Set<string>();

// ---------------------------------------------------------------
// أدوات مساعدة
// ---------------------------------------------------------------

async function getRawKeyById(id: string): Promise<RawKey | null> {
  await ensureSchema();
  const r = await getTurso().execute({
    sql: "SELECT id, provider, label, api_key, status FROM api_keys WHERE id = ?",
    args: [id],
  });
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    id: String(row.id),
    provider: String(row.provider) as RawKey["provider"],
    label: String(row.label ?? ""),
    api_key: String(row.api_key),
    status: String(row.status ?? "active") as RawKey["status"],
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function attempt(a: Omit<TaskAttempt, "at">): TaskAttempt {
  return { ...a, at: nowIso() };
}

/** آخر وقت محاولة (للتهدئة) */
function lastAttemptAt(task: Task): number {
  const times = task.attempts.map((a) => Date.parse(a.at)).filter((n) => !Number.isNaN(n));
  return times.length ? Math.max(...times) : 0;
}

/** بناء input المزود من معطيات الأداة الأصلية (نفس الدالة عند إعادة الإنشاء) */
function buildProviderInput(def: ModelDef, params: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: params.prompt };
  if (def.type === "image") {
    if (typeof params.aspect_ratio === "string" && params.aspect_ratio !== "auto") {
      input.aspect_ratio = params.aspect_ratio;
    }
    if (typeof params.resolution === "string") input.resolution = params.resolution;
    // الخلفية تُطبق عند 1K فقط (حسب مخطط الأداة)
    if (typeof params.background === "string" && params.background !== "auto" && params.resolution === "1K") {
      input.background = params.background;
    }
    if (typeof params.output_format === "string") input.output_format = params.output_format;
  } else if (def.type === "video") {
    if (typeof params.image_url === "string" && params.image_url) input.image_url = params.image_url;
    if (typeof params.aspect_ratio === "string" && params.aspect_ratio !== "auto") {
      input.aspect_ratio = params.aspect_ratio;
    }
    if (typeof params.resolution === "string") input.resolution = params.resolution;
    if (typeof params.enable_audio === "boolean") input.enable_audio = params.enable_audio;
    if (typeof params.duration === "number") input.duration = params.duration;
  }
  return input;
}

function adapterFor(provider: string): ProviderAdapter {
  const a = ADAPTERS[provider];
  if (!a) throw new ProviderError(null, `لا يوجد محوّل للمزود ${provider}`);
  return a;
}

function failTaskMessage(cls: string, message: string): string {
  // رسائل فشل حقيقية (سياسة/معطيات) تُعرض للعميل — دون أي ذكر لمفاتيح أو رصيد
  if (cls === "params") return `معطيات الطلب غير مقبولة لدى المزود: ${message}`;
  if (cls === "provider") return `الموديل غير مدعوم لدى هذا المزود: ${message}`;
  return message;
}

/** تسجيل محاولة + عدّادات المفتاح + تعليمه عند التعطيل/الاستنفاد */
async function recordKeyAttempt(
  key: RawKey,
  provider: string,
  ok: boolean,
  error: { cls?: string; message?: string } = {},
): Promise<void> {
  await bumpKeyCounters(key.id, ok, {
    errorClass: error.cls,
    error: ok ? undefined : `[${error.cls ?? "temporary"}] ${error.message ?? ""}`.trim().slice(0, 500),
    markStatus: error.cls === "disabled" ? "disabled" : error.cls === "exhausted" ? "exhausted" : undefined,
  });
}

// ---------------------------------------------------------------
// الإنشاء على مجموعة المفاتيح بالترتيب التسلسلي
// ---------------------------------------------------------------

interface CreateOutcome {
  created: boolean;
  provider?: string;
  providerTaskId?: string;
  keyId?: string;
  /** خطأ معطيات حتمي — يفشل المهمة فورًا */
  paramsError?: string;
}

async function createOnPool(
  taskId: string,
  def: ModelDef,
  params: Record<string, unknown>,
  pool: RawKey[],
  startIndex = 0,
): Promise<CreateOutcome> {
  const input = buildProviderInput(def, params);
  for (let i = Math.max(0, startIndex); i < pool.length; i++) {
    const key = pool[i];
    const adapter = adapterFor(key.provider);
    const providerModel = def.providerModel[key.provider as keyof typeof def.providerModel] ?? def.canonical;
    try {
      // صور CometAPI متزامنة — تُحفظ النتيجة مباشرة دون providerTaskId
      if (def.type === "image" && adapter.createImageSync) {
        const { urls } = await adapter.createImageSync(key.api_key, providerModel, input);
        await updateTask(taskId, {
          provider: key.provider,
          keyId: key.id,
          status: "completed",
          resultUrls: urls,
          errorMessage: null,
        });
        await recordKeyAttempt(key, key.provider, true);
        await updateTask(taskId, {
          appendAttempt: attempt({ provider: key.provider, keyId: key.id, keyLabel: key.label || key.id.slice(0, 8), ok: true }),
        });
        return { created: true, provider: key.provider, keyId: key.id, providerTaskId: "sync-image" };
      }

      const handle = await adapter.createTask(key.api_key, providerModel, input);
      await updateTask(taskId, {
        provider: key.provider,
        providerTaskId: handle.providerTaskId,
        keyId: key.id,
        status: "processing",
        errorMessage: null,
      });
      await recordKeyAttempt(key, key.provider, true);
      await updateTask(taskId, {
        appendAttempt: attempt({ provider: key.provider, keyId: key.id, keyLabel: key.label || key.id.slice(0, 8), ok: true }),
      });
      return { created: true, provider: key.provider, providerTaskId: handle.providerTaskId, keyId: key.id };
    } catch (e) {
      const cls = e instanceof ProviderError ? classifyProviderError(e.status, e.message) : "temporary";
      const message = (e as Error).message ?? "خطأ غير معروف";
      await recordKeyAttempt(key, key.provider, false, { cls, message });
      await updateTask(taskId, {
        appendAttempt: attempt({
          provider: key.provider,
          keyId: key.id,
          keyLabel: key.label || key.id.slice(0, 8),
          ok: false,
          errorClass: cls,
          error: message.slice(0, 500),
        }),
      });
      if (cls === "params") {
        // خطأ معطيات — تبديل المفاتيح لن يحلّه: توقف فورًا (قسم 4.2)
        return { created: false, paramsError: message };
      }
      // disabled/exhausted/provider/temporary → انتقل للمفتاح التالي بصمت
      continue;
    }
  }
  return { created: false };
}

// ---------------------------------------------------------------
// حلقة الاستعلام أثناء نافذة الانتظار
// ---------------------------------------------------------------

async function pollUntilDone(
  task: Task,
  def: ModelDef,
  waitSeconds: number,
  notify?: NotifyFn,
): Promise<Task> {
  const adapter = adapterFor(task.provider ?? "");
  const key = task.keyId ? await getRawKeyById(task.keyId) : null;
  if (!key || !task.providerTaskId) return task;

  const deadline = Date.now() + waitSeconds * 1000;
  let current = task;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const state = await adapter.checkTask(key.api_key, current.providerTaskId ?? "");

    if (state.status === "completed" && state.urls && state.urls.length > 0) {
      await updateTask(current.id, { status: "completed", resultUrls: state.urls, errorMessage: null });
      await notify?.(100, "اكتمل التوليد — 100%");
      return (await getTask(current.id)) ?? current;
    }

    if (state.status === "failed") {
      const msg = state.error ?? "فشل غير معروف لدى المزود";
      if (isKeyOrBalanceFailure(msg)) {
        // فشل مفتاح/رصيد في منتصف المهمة → أعد الإنشاء بنفس task_id على المفتاح التالي
        const next = await recreateOnNextKey(current, def);
        if (next.created && next.task) {
          current = next.task;
          continue; // استمر بالاستعلام على المهمة الجديدة بنفس task_id
        }
        // لا مفتاح متاح الآن → تبقى processing بانتظار مفتاح صالح (يُعاد مع get_task)
        await updateTask(current.id, { status: "processing", errorMessage: INTERNAL_WAITING });
        await notify?.(0, "قيد التوليد… بانتظار توفر الموارد");
        return (await getTask(current.id)) ?? current;
      }
      // فشل حقيقي (سياسة/معطيات لدى المزود) → فشل نهائي
      await updateTask(current.id, { status: "failed", errorMessage: msg.slice(0, 800) });
      return (await getTask(current.id)) ?? current;
    }

    // جارية — حدّث التقدم في القاعدة وأرسل إشعارًا
    const progress = Math.min(99, Math.max(current.progress, state.progress ?? 50));
    if (progress > current.progress) {
      await updateTask(current.id, { progress });
      current = { ...current, progress };
    }
    await notify?.(progress, `قيد التوليد… ${progress}%`);
  }

  // انتهت النافذة والنتيجة لم تظهر → أعد المهمة بحالة processing
  return (await getTask(current.id)) ?? current;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------
// إعادة الإنشاء على المفتاح التالي بنفس task_id
// ---------------------------------------------------------------

interface RecreateOutcome {
  created: boolean;
  task?: Task;
}

async function recreateOnNextKey(task: Task, def: ModelDef): Promise<RecreateOutcome> {
  const pool = await getKeyPool(def.providers);
  const usedIdx = pool.findIndex((k) => k.id === task.keyId);
  const startIndex = usedIdx >= 0 ? usedIdx + 1 : 0; // التالي بعد المفتاح المستخدم أخيرًا
  if (startIndex >= pool.length) return { created: false };

  const outcome = await createOnPool(task.id, def, task.params, pool, startIndex);
  if (outcome.paramsError) {
    await updateTask(task.id, {
      status: "failed",
      errorMessage: `معطيات الطلب غير مقبولة لدى المزود: ${outcome.paramsError}`.slice(0, 800),
    });
    return { created: false, task: await getTask(task.id) ?? undefined };
  }
  if (!outcome.created) return { created: false };
  return { created: true, task: (await getTask(task.id)) ?? undefined };
}

// ---------------------------------------------------------------
// runGeneration — التدفق الرئيسي لأداتي generate_image / generate_video
// ---------------------------------------------------------------

export interface GenerateArgs {
  type: "image" | "video";
  prompt: string;
  model?: string;
  params?: Record<string, unknown>;
  waitSeconds?: number;
  notify?: NotifyFn;
}

export async function runGeneration(args: GenerateArgs): Promise<Task> {
  const type = args.type;
  const modelArg = args.model ?? (type === "image" ? "gpt-image-2-6/flare-text-to-image" : "grok-imagine-video-1-5-preview");
  const def = findModel(modelArg);
  if (!def || def.type !== type) {
    throw new ParamsError(`موديل غير معروف: ${modelArg}. المتاح: ${type === "image" ? "gpt-image-2-6/flare-text-to-image" : "grok-imagine-video-1-5-preview"}`);
  }

  const params: Record<string, unknown> = {
    prompt: args.prompt,
    ...(args.params ?? {}),
    model: def.canonical,
  };
  const waitSeconds = clampWait(args.waitSeconds ?? DEFAULT_WAIT[type]);

  // 1) المفاتيح أولًا — فارغة → رد no_keys فوري قبل إنشاء أي مهمة
  const pool = await getKeyPool(def.providers);
  if (pool.length === 0) throw new NoKeysError(def.canonical);

  // 2) سجّل المهمة في Turso قبل أي نداء خارجي (قسم 6.3)
  let task = await insertTask({
    id: randomUUID(),
    model: def.canonical,
    type,
    prompt: args.prompt,
    params,
    status: "processing",
  });

  // 3) جرّب المرشحين بالترتيب حتى نجاح الإنشاء
  const outcome = await createOnPool(task.id, def, params, pool, 0);
  if (outcome.paramsError) {
    await updateTask(task.id, {
      status: "failed",
      errorMessage: `معطيات الطلب غير مقبولة لدى المزود: ${outcome.paramsError}`.slice(0, 800),
    });
    return (await getTask(task.id)) ?? task;
  }
  if (!outcome.created) {
    // فشل على كل المفاتيح → تبقى processing وتُعاد محاولتها مع كل get_task
    await updateTask(task.id, { status: "processing", errorMessage: INTERNAL_WAITING });
    return (await getTask(task.id)) ?? task;
  }

  // 4) نافذة الانتظار مع بث تقدم
  task = (await getTask(task.id)) ?? task;
  return await pollUntilDone(task, def, waitSeconds, args.notify);
}

function clampWait(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(240, Math.round(n)));
}

// ---------------------------------------------------------------
// refreshTask — منطق get_task لكل أنواع المهام
// ---------------------------------------------------------------

export async function refreshTask(taskId: string, notify?: NotifyFn): Promise<Task | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  if (task.status === "completed" || task.status === "failed") return task;

  if (task.type === "merge") {
    return await refreshMergeTask(task, notify);
  }

  const def = findModel(task.model);
  if (!def) {
    await updateTask(task.id, { status: "failed", errorMessage: "موديل المهمة غير معروف في السجل" });
    return (await getTask(task.id)) ?? task;
  }

  // لم تُنشأ لدى أي مزود بعد → أعد المحاولة على كل المفاتيح بعد التهدئة
  if (!task.providerTaskId || !task.keyId || !task.provider) {
    if (Date.now() - lastAttemptAt(task) < RETRY_COOLDOWN_MS) {
      await notify?.(0, "قيد التوليد… بانتظار توفر الموارد");
      return task;
    }
    const pool = await getKeyPool(def.providers);
    if (pool.length === 0) {
      await notify?.(0, "قيد التوليد… بانتظار توفر الموارد");
      return task;
    }
    const outcome = await createOnPool(task.id, def, task.params, pool, 0);
    if (outcome.paramsError) {
      await updateTask(task.id, {
        status: "failed",
        errorMessage: `معطيات الطلب غير مقبولة لدى المزود: ${outcome.paramsError}`.slice(0, 800),
      });
      return (await getTask(task.id)) ?? task;
    }
    if (!outcome.created) return task;
    const fresh = (await getTask(task.id)) ?? task;
    // مهام الصور المتزامنة تكتمل فورًا عند الإنشاء
    if (fresh.status === "completed") return fresh;
    // بعد إنشاء ناجح داخل get_task لا ننتظر طويلاً — يبقى التتبع لدورات get_task القادمة
    return fresh;
  }

  const adapter = adapterFor(task.provider);
  const key = await getRawKeyById(task.keyId);
  if (!key) {
    // اختفى المفتاح (حُذف) → أعد الإنشاء على المفتاح التالي
    const next = await recreateOnNextKey(task, def);
    if (next.created && next.task) return next.task;
    await updateTask(task.id, { status: "processing", errorMessage: INTERNAL_WAITING });
    return (await getTask(task.id)) ?? task;
  }

  try {
    const state = await adapter.checkTask(key.api_key, task.providerTaskId);
    if (state.status === "completed" && state.urls && state.urls.length > 0) {
      await updateTask(task.id, { status: "completed", resultUrls: state.urls, errorMessage: null });
      return (await getTask(task.id)) ?? task;
    }
    if (state.status === "failed") {
      const msg = state.error ?? "فشل غير معروف لدى المزود";
      if (isKeyOrBalanceFailure(msg)) {
        const next = await recreateOnNextKey(task, def);
        if (next.created && next.task) return next.task;
        await updateTask(task.id, { status: "processing", errorMessage: INTERNAL_WAITING });
        return (await getTask(task.id)) ?? task;
      }
      await updateTask(task.id, { status: "failed", errorMessage: msg.slice(0, 800) });
      return (await getTask(task.id)) ?? task;
    }
    // جارية
    const progress = Math.min(99, Math.max(task.progress, state.progress ?? 50));
    if (progress > task.progress) await updateTask(task.id, { progress });
    await notify?.(progress, `قيد التوليد… ${progress}%`);
    return (await getTask(task.id)) ?? task;
  } catch (e) {
    const cls = e instanceof ProviderError ? classifyProviderError(e.status, e.message) : "temporary";
    const msg = (e as Error).message ?? "";
    if (cls === "disabled" || cls === "exhausted") {
      // مفتاح الاستعلام صار مرفوضًا → أنشئ على المفتاح التالي بنفس task_id
      const next = await recreateOnNextKey(task, def);
      if (next.created && next.task) return next.task;
      await updateTask(task.id, { status: "processing", errorMessage: INTERNAL_WAITING });
      return (await getTask(task.id)) ?? task;
    }
    if (cls === "params") {
      await updateTask(task.id, { status: "failed", errorMessage: failTaskMessage(cls, msg).slice(0, 800) });
      return (await getTask(task.id)) ?? task;
    }
    // temporary — تبقى جارية ويُعاد الاستعلام لاحقًا
    await notify?.(task.progress || 50, "قيد التوليد…");
    return task;
  }
}

// ---------------------------------------------------------------
// الدمج — runMerge + refreshMergeTask (قسم 7.3)
// ---------------------------------------------------------------

export interface MergeArgs {
  urls?: string[];
  taskIds?: string[];
  waitSeconds?: number;
  notify?: NotifyFn;
}

export async function runMerge(args: MergeArgs): Promise<Task> {
  if (!merger.mergerConfigured()) {
    throw new ParamsError(
      "❌ خدمة الدمج غير مضبوطة على السيرفر (MERGER_API_BASE). أضف رابط خدمة الدمج في متغيرات البيئة ثم أعد المحاولة.",
    );
  }

  // الترتيب: روابط task_ids أُولًا ثم urls المباشرة بنفس ترتيبها
  const resolved: string[] = [];
  const failures: string[] = [];
  for (const tid of args.taskIds ?? []) {
    const t = await getTask(tid);
    if (!t || t.type !== "video" || t.status !== "completed" || t.resultUrls.length === 0) {
      failures.push(`${tid} (${!t ? "غير موجودة" : t.status !== "completed" ? `الحالة: ${t.status}` : "بلا روابط"})`);
      continue;
    }
    resolved.push(t.resultUrls[0]);
  }
  if (failures.length > 0) {
    throw new ParamsError(
      `❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.\nمعرّفات غير قابلة للاستخدام:\n- ${failures.join("\n- ")}`,
    );
  }

  const urls = [...resolved, ...(args.urls ?? [])];
  if (urls.length < 2) {
    throw new ParamsError("❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.");
  }
  if (urls.length > 10) {
    throw new ParamsError("❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).");
  }
  const bad = urls.filter((u) => !/^https?:\/\/\S+$/.test(u));
  if (bad.length > 0) {
    throw new ParamsError(`❌ كل المقاطع يجب أن تكون روابط http/https مباشرة وعامة. روابط غير صالحة:\n- ${bad.join("\n- ")}`);
  }

  // سجّل مهمة الدمج أولًا (قاعدة 7.3.2)
  const task = await insertTask({
    id: randomUUID(),
    provider: "merger",
    model: MERGE_MODEL,
    type: "merge",
    prompt: `دمج ${urls.length} مقاطع`,
    params: { urls },
    status: "processing",
  });

  const created = await merger.createMergeJob(urls);
  await updateTask(task.id, { providerTaskId: created.jobId });

  // أطلق process خلفيًا وبمرة واحدة فقط (قفل في الذاكرة)
  await ensureMergeProcessStarted(created.jobId);

  const fresh = (await getTask(task.id)) ?? task;
  return await waitForMerge(fresh, clampWait(args.waitSeconds ?? DEFAULT_WAIT.merge), args.notify);
}

/** فحص مخطط مهمة الدمج المخزنة — أداة merge_videos مع دمج واحد فقط مرفوض */
export async function waitForMerge(task: Task, waitSeconds: number, notify?: NotifyFn): Promise<Task> {
  const deadline = Date.now() + waitSeconds * 1000;
  let current = task;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    current = (await refreshMergeTask(current, notify)) ?? current;
    if (current.status === "completed" || current.status === "failed") return current;
  }
  return current;
}

/** يضمن تنفيذ POST process مرة واحدة فقط لكل مهمة (حتى مع تزامن get_task) */
async function ensureMergeProcessStarted(jobId: string): Promise<void> {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  (async () => {
    try {
      // نقطة process حاجبة (~10-15 ثانية): نطلقها خلفيًا — الاكتمال يُلتقط
      // عبر getMergeJob في الاستعلام التالي فلا حاجة لنتيجتها هنا
      await merger.startMergeProcess(jobId);
    } catch {
      // الفشل الحتمي يُسجل عند الاستعلام التالي عبر getMergeJob / حالة الخدمة
    } finally {
      processInFlight.delete(jobId);
    }
  })();
}

export async function refreshMergeTask(task: Task, notify?: NotifyFn): Promise<Task> {
  const jobId = task.providerTaskId;

  // لم تُنشأ لدى الخدمة بعد — أعد الإنشاء من الروابط المخزنة
  if (!jobId) {
    const urls = (task.params?.urls as string[]) ?? [];
    if (urls.length < 2) {
      await updateTask(task.id, { status: "failed", errorMessage: "روابط الدمج المخزنة غير مكتملة" });
      return (await getTask(task.id)) ?? task;
    }
    const created = await merger.createMergeJob(urls);
    await updateTask(task.id, { providerTaskId: created.jobId });
    await ensureMergeProcessStarted(created.jobId);
    return (await getTask(task.id)) ?? task;
  }

  let status: merger.MergeStatus;
  try {
    status = await merger.getMergeJob(jobId);
  } catch (e) {
    // 404 → فشل نهائي: مهمة الدمج غير موجودة (حُذفت أو انتهت صلاحيتها)
    await updateTask(task.id, {
      status: "failed",
      errorMessage: ((e as Error).message || "فشل الاستعلام عن مهمة الدمج").slice(0, 800),
    });
    return (await getTask(task.id)) ?? task;
  }

  if (status.status === "done") {
    const url = status.videoUrl ?? status.downloadUrl;
    if (!url) {
      await updateTask(task.id, { status: "failed", errorMessage: "اكتمل الدمج دون رابط ناتج قابل للقراءة" });
    } else {
      await updateTask(task.id, {
        status: "completed",
        resultUrls: [url],
        errorMessage: null,
        providerTaskId: jobId,
      });
    }
    await notify?.(100, "اكتمل الدمج — 100%");
    return (await getTask(task.id)) ?? task;
  }

  if (status.status === "failed") {
    // أخطاء الخدمة المعلنة = فشل حتمي فوري (قاعدة 6)
    await updateTask(task.id, {
      status: "failed",
      errorMessage: `فشل الدمج لدى الخدمة: ${status.error ?? "غير معروف"}`.slice(0, 800),
    });
    return (await getTask(task.id)) ?? task;
  }

  // queued/processing
  await ensureMergeProcessStarted(jobId);
  const progress = Math.min(99, Math.max(task.progress, status.progress));
  if (progress > task.progress) await updateTask(task.id, { progress });
  await notify?.(progress, `جارٍ الدمج… ${progress}%`);
  return (await getTask(task.id)) ?? task;
}
