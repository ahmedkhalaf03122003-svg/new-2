"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------
// أنواع البيانات القادمة من المسارات
// ---------------------------------------------------------------

interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string | null; configured: boolean; healthy: boolean };
  authRequired: boolean;
}

interface KeyRecord {
  id: string;
  provider: "kie" | "cometapi";
  label: string;
  masked: string;
  status: "active" | "exhausted" | "disabled";
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

interface TaskRow {
  id: string;
  type: "image" | "video" | "merge";
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  model: string;
  prompt: string;
  resultUrls: string[];
  errorMessage: string | null;
  attempts: number;
  createdAt: string;
}

interface TasksResp {
  stats: { total: number; completed: number; failed: number; processing: number };
  tasks: TaskRow[];
}

const TOOLS = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي بالموديل المدمج مع تبديل تلقائي للمفاتيح" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي (حوار/مؤثرات/موسيقى) مع image-to-video اختياري" },
  { name: "merge_videos", desc: "دمج عدة مقاطع في مقطع واحد بالترتيب المطلوب — عبر urls أو task_ids" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها حتى الاكتمال وتعرض روابط النتائج" },
  { name: "list_media", desc: "استرجاع أحدث الوسائط المخزنة بروابطها دون إعادة توليد" },
];

const STATUS_STYLES: Record<TaskRow["status"], string> = {
  completed: "bg-emerald-100 text-emerald-700",
  failed: "bg-rose-100 text-rose-700",
  processing: "bg-sky-100 text-sky-700",
  pending: "bg-slate-200 text-slate-600",
};

const TYPE_LABELS: Record<TaskRow["type"], string> = {
  image: "صورة",
  video: "فيديو",
  merge: "دمج",
};

const KEY_STATUS_STYLES: Record<KeyRecord["status"], string> = {
  active: "bg-emerald-100 text-emerald-700",
  exhausted: "bg-amber-100 text-amber-700",
  disabled: "bg-slate-200 text-slate-600",
};

const KEY_STATUS_LABELS: Record<KeyRecord["status"], string> = {
  active: "نشط",
  exhausted: "مستنزف",
  disabled: "معطّل",
};

function CopyButton({ text, small = false }: { text: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
      className={`shrink-0 rounded-lg bg-indigo-600 text-white transition hover:bg-indigo-700 ${
        small ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm"
      }`}
    >
      {copied ? "✓ تم النسخ" : "نسخ"}
    </button>
  );
}

// ---------------------------------------------------------------
// الصفحة
// ---------------------------------------------------------------

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [tasks, setTasks] = useState<TasksResp | null>(null);
  const [tab, setTab] = useState<"chatgpt" | "claude" | "cursor">("chatgpt");
  const [mcpUrl, setMcpUrl] = useState("");

  // نموذج إضافة مفتاح
  const [provider, setProvider] = useState<"kie" | "cometapi">("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyMsg, setKeyMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [adding, setAdding] = useState(false);

  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      setHealth(await r.json());
    } catch {
      setHealth(null);
    }
  }, []);

  const loadKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/keys", { cache: "no-store" });
      const j = await r.json();
      setKeys(j.keys ?? []);
    } catch {
      /* تجاهل */
    }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=30", { cache: "no-store" });
      setTasks(await r.json());
    } catch {
      /* تجاهل */
    }
  }, []);

  useEffect(() => {
    setMcpUrl(`${window.location.origin}/mcp`);
    loadHealth();
    loadKeys();
    loadTasks();
    const t1 = setInterval(loadHealth, 15_000);
    const t2 = setInterval(loadTasks, 5_000); // اللوحة تتحدث تلقائيًا كل ~5 ثوانٍ
    return () => {
      clearInterval(t1);
      clearInterval(t2);
    };
  }, [loadHealth, loadTasks, loadKeys]);

  async function addKey(e: React.FormEvent) {
    e.preventDefault();
    setKeyMsg(null);
    setAdding(true);
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey, label }),
      });
      const j = await r.json();
      if (!r.ok) {
        setKeyMsg({ kind: "err", text: j.error ?? "فشل إضافة المفتاح" });
      } else {
        setKeyMsg({ kind: "ok", text: "تم إضافة المفتاح — سيُجرَّب أولًا حسب ترتيب الإضافة" });
        setApiKey("");
        setLabel("");
        await loadKeys();
      }
    } catch {
      setKeyMsg({ kind: "err", text: "تعذر الاتصال بالسيرفر" });
    } finally {
      setAdding(false);
    }
  }

  async function toggleKey(k: KeyRecord) {
    const next = k.status === "disabled" ? "active" : "disabled";
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    await loadKeys();
  }

  async function deleteKey(k: KeyRecord) {
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    await loadKeys();
  }

  // JSON جاهز للنسخ لكل تبويب
  const authBlock = health?.authRequired
    ? `,\n        "headers": { "Authorization": "Bearer <MCP_ACCESS_TOKEN>" }`
    : "";
  const jsonChatGPT = `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${health?.authRequired ? authBlock : ""}\n    }\n  }\n}`;
  const jsonClaude = `{\n  "mcpServers": {\n    "media-generator": {\n      "type": "http",\n      "url": "${mcpUrl}"${health?.authRequired ? authBlock : ""}\n    }\n  }\n}`;
  const jsonCursor = jsonChatGPT;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      {/* الهيدر + شارة الصحة */}
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">
            MCP Media Generator
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — لوحة إدارة عربية
          </p>
        </div>
        <div
          className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold ${
            health?.ok
              ? "bg-emerald-100 text-emerald-700"
              : "bg-rose-100 text-rose-700"
          }`}
        >
          <span className={`h-2.5 w-2.5 rounded-full ${health?.ok ? "bg-emerald-500" : "bg-rose-500"}`} />
          {health?.ok ? "Turso متصل" : health ? "قاعدة البيانات غير متصلة" : "جارٍ الفحص…"}
        </div>
      </header>

      <div className="grid gap-6">
        {/* ------------------------------------------------ أ) مدير المفاتيح */}
        <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <h2 className="mb-1 text-lg font-bold text-slate-900">أ) مدير المفاتيح</h2>
          <p className="mb-4 text-sm leading-6 text-slate-600">
            أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي
            عند أي خطأ أو نفاد رصيد دون توقف.
          </p>

          <form onSubmit={addKey} className="mb-5 grid gap-3 sm:grid-cols-[140px_1fr_1fr_auto]">
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as "kie" | "cometapi")}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="kie">kie.ai</option>
              <option value="cometapi">CometAPI</option>
            </select>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="تسمية اختيارية (مثال: الحساب الأساسي)"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="مفتاح API"
              required
              className="code-ltr rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={adding}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-50"
            >
              {adding ? "جارٍ الإضافة…" : "إضافة"}
            </button>
          </form>
          {keyMsg && (
            <p className={`mb-4 text-sm ${keyMsg.kind === "ok" ? "text-emerald-600" : "text-rose-600"}`}>
              {keyMsg.text}
            </p>
          )}

          <ul className="space-y-3">
            {keys.length === 0 && (
              <li className="rounded-xl border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500">
                لا توجد مفاتيح بعد — أضف أول مفتاح لبدء التوليد.
              </li>
            )}
            {keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="code-ltr rounded bg-slate-200 px-2 py-0.5 text-sm">{k.masked}</code>
                    <span className="rounded bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-700">
                      {k.provider === "kie" ? "kie.ai" : "CometAPI"}
                    </span>
                    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${KEY_STATUS_STYLES[k.status]}`}>
                      {KEY_STATUS_LABELS[k.status]}
                    </span>
                    {k.label && <span className="text-sm text-slate-500">{k.label}</span>}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    استخدام: {k.usageCount} · نجاح: {k.successCount} · فشل: {k.failCount}
                    {k.lastError && (
                      <span className="ms-2 text-rose-500" title={k.lastError}>
                        آخر خطأ: {k.lastError.slice(0, 60)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => toggleKey(k)}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
                  >
                    {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                  </button>
                  <button
                    onClick={() => deleteKey(k)}
                    className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-600 transition hover:bg-rose-50"
                  >
                    حذف
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* ------------------------------------------------ ب) لوحة المهام */}
        <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <h2 className="mb-4 text-lg font-bold text-slate-900">ب) لوحة المهام</h2>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "إجمالي", value: tasks?.stats.total ?? 0, cls: "bg-slate-100 text-slate-700" },
              { label: "مكتملة", value: tasks?.stats.completed ?? 0, cls: "bg-emerald-100 text-emerald-700" },
              { label: "فاشلة", value: tasks?.stats.failed ?? 0, cls: "bg-rose-100 text-rose-700" },
              { label: "جارية", value: tasks?.stats.processing ?? 0, cls: "bg-sky-100 text-sky-700" },
            ].map((s) => (
              <div key={s.label} className={`rounded-xl p-3 text-center ${s.cls}`}>
                <div className="text-2xl font-extrabold">{s.value}</div>
                <div className="text-xs font-semibold">{s.label}</div>
              </div>
            ))}
          </div>

          <ul className="space-y-3">
            {tasks?.tasks.length === 0 && (
              <li className="rounded-xl border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500">
                لا توجد مهام بعد — استدعِ الأدوات من عميل MCP ليظهر السجل هنا.
              </li>
            )}
            {tasks?.tasks.map((t) => (
              <li key={t.id} className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-indigo-50 px-2 py-0.5 text-xs font-bold text-indigo-700">
                    {TYPE_LABELS[t.type]}
                  </span>
                  <span className={`rounded px-2 py-0.5 text-xs font-bold ${STATUS_STYLES[t.status]}`}>
                    {t.status === "completed" ? "مكتملة" : t.status === "failed" ? "فاشلة" : "جارية"}
                  </span>
                  <code className="code-ltr text-xs text-slate-400">{t.id.slice(0, 8)}</code>
                  <code className="code-ltr text-xs text-slate-500">{t.model}</code>
                  {t.attempts > 0 && (
                    <span className="text-xs text-slate-400">محاولات: {t.attempts}</span>
                  )}
                  <span className="ms-auto text-xs text-slate-400" dir="ltr">
                    {t.createdAt.replace("T", " ").slice(0, 19)}
                  </span>
                </div>
                {t.status !== "completed" && t.status !== "failed" && (
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full rounded-full bg-sky-500 transition-all"
                      style={{ width: `${Math.max(4, t.progress)}%` }}
                    />
                  </div>
                )}
                <p className="mt-2 line-clamp-2 text-sm text-slate-600">{t.prompt}</p>
                {t.status === "failed" && t.errorMessage && (
                  <p className="mt-1 text-sm text-rose-600">{t.errorMessage}</p>
                )}
                {t.resultUrls.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {t.resultUrls.map((u) => (
                      <a
                        key={u}
                        href={u}
                        target="_blank"
                        rel="noreferrer"
                        className="code-ltr max-w-full truncate rounded-lg bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100"
                      >
                        {t.type === "image" ? "🖼 فتح الصورة" : "▶️ فتح الفيديو"}
                      </a>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>

        {/* ------------------------------------------------ ج) ربط السيرفر */}
        <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <h2 className="mb-4 text-lg font-bold text-slate-900">ج) ربط السيرفر</h2>

          <div className="mb-5 flex flex-wrap items-center gap-2">
            <input
              readOnly
              value={mcpUrl}
              className="code-ltr min-w-0 flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm"
            />
            <CopyButton text={mcpUrl} />
          </div>

          <div className="mb-3 flex gap-2">
            {(
              [
                ["chatgpt", "ChatGPT / GPT Agents"],
                ["claude", "Claude Desktop"],
                ["cursor", "Cursor / Windsurf / Cline"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                  tab === id ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mb-3 rounded-xl bg-slate-900 p-4">
            <div className="mb-2 flex items-center justify-between">
              <code className="text-xs text-slate-400">
                {tab === "claude" ? "claude_desktop_config.json" : tab === "cursor" ? "mcp.json" : "connector_config.json"}
              </code>
              <CopyButton small text={tab === "claude" ? jsonClaude : tab === "cursor" ? jsonCursor : jsonChatGPT} />
            </div>
            <pre className="code-ltr overflow-x-auto text-xs leading-5 text-emerald-300">
              {tab === "claude" ? jsonClaude : tab === "cursor" ? jsonCursor : jsonChatGPT}
            </pre>
          </div>

          {tab === "chatgpt" && (
            <p className="mb-4 text-sm text-slate-600">
              في ChatGPT: <strong>Settings → Connectors → Create → Custom MCP server</strong> وضع الرابط أعلاه في
              حقل «Server URL».
            </p>
          )}
          {tab === "claude" && (
            <p className="mb-4 text-sm text-slate-600">
              ضع المحتوى في ملف <code className="code-ltr">claude_desktop_config.json</code> مع النوع{" "}
              <code className="code-ltr">http</code> ثم أعد تشغيل Claude Desktop.
            </p>
          )}
          {tab === "cursor" && (
            <p className="mb-4 text-sm text-slate-600">
              ضع المحتوى في <code className="code-ltr">mcp.json</code> لدى Cursor أو Windsurf أو Cline ثم أعد
              التحميل.
            </p>
          )}

          <div className="mb-4 flex flex-wrap gap-2">
            {TOOLS.map((t) => (
              <span
                key={t.name}
                title={t.desc}
                className="inline-flex max-w-full items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600 ring-1 ring-slate-200"
              >
                <code className="code-ltr font-bold text-indigo-700">{t.name}</code>
                <span className="hidden sm:inline">— {t.desc}</span>
              </span>
            ))}
          </div>

          <div className="rounded-xl bg-amber-50 p-4 text-sm leading-6 text-amber-800 ring-1 ring-amber-200">
            ⚠️ الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند
            اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications)
            حتى لا تنقطع العملية.
          </div>
        </section>
      </div>

      <footer className="mt-8 pb-6 text-center text-xs text-slate-400">
        media-generator-mcp v1.2.0 — لا يُنزَّل أي ملف وسائط على السيرفر؛ تُخزَّن روابط النتائج فقط.
      </footer>
    </main>
  );
}
