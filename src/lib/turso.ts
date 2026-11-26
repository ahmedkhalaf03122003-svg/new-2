import { createClient, type Client, type InValue } from "@libsql/client";

/**
 * طبقة Turso (libSQL عبر HTTP) — عميل واحد لكل العملية، متوافق مع بيئة Vercel
 * serverless (لا ملفات SQLite محلية إطلاقًا).
 */

let client: Client | null = null;

export function getTurso(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error(
        "ENV_MISSING: متغيرا TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبان (محليًا في .env.local وعلى Vercel في Environment Variables)",
      );
    }
    client = createClient({ url, authToken: token });
  }
  return client;
}

/** فحص جهوزية قاعدة البيانات: SELECT 1 فقط — لا يعدّل شيئًا */
export async function dbHealthy(): Promise<boolean> {
  try {
    const r = await getTurso().execute("SELECT 1");
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------
// المخطط — CREATE TABLE IF NOT EXISTS عند أول وصول، بلا أدوات migrations
// ---------------------------------------------------------------

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    provider TEXT,
    provider_task_id TEXT,
    key_id TEXT,
    model TEXT NOT NULL,
    type TEXT NOT NULL,
    prompt TEXT DEFAULT '',
    params_json TEXT DEFAULT '{}',
    status TEXT NOT NULL,
    progress INTEGER DEFAULT 0,
    result_urls_json TEXT,
    error_message TEXT,
    attempts_json TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    label TEXT DEFAULT '',
    api_key TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    usage_count INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    last_used_at TEXT,
    last_checked_at TEXT,
    last_error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
];

let schemaPromise: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = getTurso();
      for (const sql of SCHEMA_STATEMENTS) {
        await db.execute(sql);
      }
    })().catch((e) => {
      schemaPromise = null; // اسمح بإعادة المحاولة عند الفشل
      throw e;
    });
  }
  return schemaPromise;
}

// ---------------------------------------------------------------
// أنواع المهام
// ---------------------------------------------------------------

export type TaskStatus = "pending" | "processing" | "completed" | "failed";
export type MediaType = "image" | "video" | "merge";

export interface TaskAttempt {
  provider: string;
  keyId?: string;
  keyLabel?: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface Task {
  id: string;
  provider: string | null;
  providerTaskId: string | null;
  keyId: string | null;
  model: string;
  type: MediaType;
  prompt: string;
  params: Record<string, unknown>;
  status: TaskStatus;
  progress: number;
  resultUrls: string[];
  errorMessage: string | null;
  attempts: TaskAttempt[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function rowToTask(row: Record<string, unknown>): Task {
  const parseJson = (v: unknown, fallback: unknown) => {
    if (typeof v !== "string" || v === "") return fallback;
    try {
      return JSON.parse(v);
    } catch {
      return fallback;
    }
  };
  return {
    id: String(row.id),
    provider: (row.provider as string) ?? null,
    providerTaskId: (row.provider_task_id as string) ?? null,
    keyId: (row.key_id as string) ?? null,
    model: String(row.model ?? ""),
    type: (row.type as MediaType) ?? "image",
    prompt: String(row.prompt ?? ""),
    params: parseJson(row.params_json, {}) as Record<string, unknown>,
    status: (row.status as TaskStatus) ?? "pending",
    progress: Number(row.progress ?? 0),
    resultUrls: parseJson(row.result_urls_json, []) as string[],
    errorMessage: (row.error_message as string) ?? null,
    attempts: parseJson(row.attempts_json, []) as TaskAttempt[],
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    completedAt: (row.completed_at as string) ?? null,
  };
}

// ---------------------------------------------------------------
// عمليات المهام
// ---------------------------------------------------------------

export async function insertTask(t: {
  id: string;
  provider?: string | null;
  providerTaskId?: string | null;
  keyId?: string | null;
  model: string;
  type: MediaType;
  prompt?: string;
  params?: Record<string, unknown>;
  status?: TaskStatus;
}): Promise<Task> {
  await ensureSchema();
  const db = getTurso();
  await db.execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, attempts_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '[]')`,
    args: [
      t.id,
      t.provider ?? null,
      t.providerTaskId ?? null,
      t.keyId ?? null,
      t.model,
      t.type,
      t.prompt ?? "",
      JSON.stringify(t.params ?? {}),
      t.status ?? "pending",
    ] as InValue[],
  });
  const task = await getTask(t.id);
  if (!task) throw new Error("فشل إنشاء المهمة في قاعدة البيانات");
  return task;
}

export async function getTask(id: string): Promise<Task | null> {
  await ensureSchema();
  const r = await getTurso().execute({
    sql: "SELECT * FROM tasks WHERE id = ?",
    args: [id],
  });
  if (r.rows.length === 0) return null;
  return rowToTask(r.rows[0] as unknown as Record<string, unknown>);
}

export interface TaskPatch {
  status?: TaskStatus;
  progress?: number;
  provider?: string | null;
  providerTaskId?: string | null;
  keyId?: string | null;
  resultUrls?: string[];
  errorMessage?: string | null;
  model?: string;
  /** إضافة محاولة واحدة إلى attempts_json */
  appendAttempt?: TaskAttempt;
}

/** تحديث جزئي — يضبط updated_at دائمًا و completed_at تلقائيًا عند الاكتمال */
export async function updateTask(id: string, patch: TaskPatch): Promise<void> {
  await ensureSchema();
  const db = getTurso();

  if (patch.appendAttempt) {
    // ألحق المحاولة بمصفوفة attempts عبر قراءة-تعديل-كتابة (أداء مقبول وحجم بيانات صغير)
    const cur = await db.execute({
      sql: "SELECT attempts_json FROM tasks WHERE id = ?",
      args: [id],
    });
    if (cur.rows.length > 0) {
      let arr: TaskAttempt[] = [];
      try {
        arr = JSON.parse(String(cur.rows[0].attempts_json ?? "[]"));
      } catch {
        arr = [];
      }
      arr.push(patch.appendAttempt);
      await db.execute({
        sql: "UPDATE tasks SET attempts_json = ? WHERE id = ?",
        args: [JSON.stringify(arr.slice(-200)), id], // حد أقصى 200 محاولة حفظًا من التضخم
      });
    }
  }

  const sets: string[] = ["updated_at = datetime('now')"];
  const args: InValue[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
    if (patch.status === "completed") {
      sets.push("completed_at = COALESCE(completed_at, datetime('now'))");
      sets.push("progress = 100");
    }
  }
  if (patch.progress !== undefined && patch.status !== "completed") {
    sets.push("progress = ?");
    args.push(Math.max(0, Math.min(100, Math.round(patch.progress))));
  }
  if (patch.provider !== undefined) sets.push("provider = ?"), args.push(patch.provider);
  if (patch.providerTaskId !== undefined) sets.push("provider_task_id = ?"), args.push(patch.providerTaskId);
  if (patch.keyId !== undefined) sets.push("key_id = ?"), args.push(patch.keyId);
  if (patch.resultUrls !== undefined) sets.push("result_urls_json = ?"), args.push(JSON.stringify(patch.resultUrls));
  if (patch.errorMessage !== undefined) sets.push("error_message = ?"), args.push(patch.errorMessage);
  if (patch.model !== undefined) sets.push("model = ?"), args.push(patch.model);
  args.push(id);

  await db.execute({
    sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
}

export async function listRecentTasks(
  limit = 10,
  filter: { type?: MediaType; status?: TaskStatus } = {},
): Promise<Task[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filter.type) where.push("type = ?"), args.push(filter.type);
  if (filter.status) where.push("status = ?"), args.push(filter.status);
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY created_at DESC, id DESC LIMIT ?`;
  args.push(limit);
  const r = await getTurso().execute({ sql, args });
  return r.rows.map((row) => rowToTask(row as unknown as Record<string, unknown>));
}

export interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

export async function taskStats(): Promise<TaskStats> {
  await ensureSchema();
  const r = await getTurso().execute(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS processing
     FROM tasks`,
  );
  const row = r.rows[0] ?? {};
  return {
    total: Number(row.total ?? 0),
    completed: Number(row.completed ?? 0),
    failed: Number(row.failed ?? 0),
    processing: Number(row.processing ?? 0),
  };
}

/** حذف مهام (يُستخدم للتنظيف بعد الاختبارات أو من الواجهة مستقبلًا) */
export async function deleteTasks(ids?: string[]): Promise<number> {
  await ensureSchema();
  const db = getTurso();
  if (ids && ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const r = await db.execute({
      sql: `DELETE FROM tasks WHERE id IN (${placeholders})`,
      args: ids as InValue[],
    });
    return r.rowsAffected;
  }
  const r = await db.execute("DELETE FROM tasks");
  return r.rowsAffected;
}
