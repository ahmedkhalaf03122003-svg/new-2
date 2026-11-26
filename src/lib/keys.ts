import { randomUUID } from "crypto";
import { getTurso, ensureSchema } from "./turso";
import type { InValue } from "@libsql/client";

/**
 * نظام المفاتيح المتسلسلة — قلب المشروع.
 * الترتيب صارم حسب ترتيب الإضافة (created_at ASC, id ASC) — ليس round-robin.
 * المفتاح المستنزف (exhausted) يبقى في القاعدة ولا يُستبعد؛ الوحيد المستبعد
 * هو المعطّل يدويًا (disabled).
 */

export type KeyProvider = "kie" | "cometapi";
export type KeyStatus = "active" | "exhausted" | "disabled";

export interface KeyRecord {
  id: string;
  provider: KeyProvider;
  label: string;
  /** مُقنَّع دائمًا — لا يُعاد المفتاح الكامل في أي استجابة (قاعدة ذهبية 9) */
  masked: string;
  status: KeyStatus;
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface RawKey {
  id: string;
  provider: KeyProvider;
  label: string;
  api_key: string;
  status: KeyStatus;
}

/** إخفاء المفتاح: أول 7 أحرف + نقاط + آخر 4 (للقصيرة: أول 3 + نقاط) */
export function maskKey(key: string): string {
  if (key.length > 12) return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
  return `${key.slice(0, 3)}••••`;
}

// ---------------------------------------------------------------
// تصنيف الأخطاء الموحد (قسم 4.2) — الترتيب مقصود ودقيق
// ---------------------------------------------------------------

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

const EXHAUSTED_RE = /insufficient|quota|balance|credit|out of credits|exhausted|充值/i;
const DISABLED_RE = /invalid api key|invalid key|unauthorized|forbidden|authentication|authenticat|invalid token/i;
const MODEL_RE = /model not found|unsupported model|not a valid model|no such model/i;

/**
 * تصنيف خطأ المزود لتحديد الإجراء.
 * ملاحظة: نفاد الرصيد يُفحص *قبل* 400 لأن بعض المزودين يرسلونه بحالة 400،
 * وقبل أنماط التعطيل لأن "insufficient balance" ليست مشكلة مفتاح.
 */
export function classifyProviderError(status: number | null, message: string): ErrorClass {
  const msg = (message || "").toLowerCase();
  if (status === 402 || EXHAUSTED_RE.test(msg)) return "exhausted";
  if (status === 401 || status === 403 || DISABLED_RE.test(msg)) return "disabled";
  if (MODEL_RE.test(msg) && (status === 400 || status === 404 || status === 422)) return "provider";
  if (status === 400 || status === 422) return "params";
  if (status === 429 || (status !== null && status >= 500)) return "temporary";
  return "temporary"; // انقطاع شبكة / timeout / abort / مجهول
}

/** هل رسالة الفشل في منتصف المهمة تشير لمشكلة مفتاح/رصيد (تستوجب التبديل الصامت)؟ */
export function isKeyOrBalanceFailure(message: string): boolean {
  return /insufficient|balance|credit|quota|402|401|unauthorized|forbidden|invalid api key|exhausted|充值/i.test(
    message || "",
  );
}

// ---------------------------------------------------------------
// جلب المفاتيح بالترتيب التسلسلي الصارم
// ---------------------------------------------------------------

export async function getKeyPool(providers: readonly string[]): Promise<RawKey[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(",");
  const r = await getTurso().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers as unknown as InValue[],
  });
  return r.rows.map((row) => ({
    id: String(row.id),
    provider: String(row.provider) as KeyProvider,
    label: String(row.label ?? ""),
    api_key: String(row.api_key),
    status: String(row.status ?? "active") as KeyStatus,
  }));
}

export async function keyExists(provider: string, apiKey: string): Promise<boolean> {
  await ensureSchema();
  const r = await getTurso().execute({
    sql: "SELECT id FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey],
  });
  return r.rows.length > 0;
}

export async function addKey(
  provider: KeyProvider,
  apiKey: string,
  label = "",
): Promise<{ id: string }> {
  await ensureSchema();
  const id = randomUUID();
  await getTurso().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key, status) VALUES (?, ?, ?, ?, 'active')`,
    args: [id, provider, label, apiKey],
  });
  return { id };
}

export async function setKeyStatus(id: string, status: KeyStatus): Promise<boolean> {
  await ensureSchema();
  const r = await getTurso().execute({
    sql: "UPDATE api_keys SET status = ? WHERE id = ?",
    args: [status, id],
  });
  return r.rowsAffected > 0;
}

export async function deleteKey(id: string): Promise<boolean> {
  await ensureSchema();
  const r = await getTurso().execute({
    sql: "DELETE FROM api_keys WHERE id = ?",
    args: [id],
  });
  return r.rowsAffected > 0;
}

/** تحديث عدّادات المفتاح بعد كل محاولة (نجاح أو فشل) — يحدث دائمًا */
export async function bumpKeyCounters(
  id: string,
  ok: boolean,
  opts: { errorClass?: string; error?: string; markStatus?: KeyStatus } = {},
): Promise<void> {
  await ensureSchema();
  const db = getTurso();
  await db.execute({
    sql: `UPDATE api_keys SET
            usage_count = usage_count + 1,
            success_count = success_count + ?,
            fail_count = fail_count + ?,
            last_used_at = datetime('now'),
            last_checked_at = datetime('now'),
            last_error = ?,
            status = COALESCE(?, status)
          WHERE id = ?`,
    args: [ok ? 1 : 0, ok ? 0 : 1, opts.error ?? null, opts.markStatus ?? null, id],
  });
}

/** قائمة المفاتيح للواجهة — مُقنَّعة دائمًا */
export async function listKeysMasked(): Promise<KeyRecord[]> {
  await ensureSchema();
  const r = await getTurso().execute(
    "SELECT * FROM api_keys ORDER BY created_at ASC, id ASC",
  );
  return r.rows.map((row) => ({
    id: String(row.id),
    provider: String(row.provider) as KeyProvider,
    label: String(row.label ?? ""),
    masked: maskKey(String(row.api_key)),
    status: String(row.status ?? "active") as KeyStatus,
    usageCount: Number(row.usage_count ?? 0),
    successCount: Number(row.success_count ?? 0),
    failCount: Number(row.fail_count ?? 0),
    lastUsedAt: (row.last_used_at as string) ?? null,
    lastError: (row.last_error as string) ?? null,
    createdAt: String(row.created_at ?? ""),
  }));
}
