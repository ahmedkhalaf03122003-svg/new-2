/**
 * أنواع موحّدة لمزودي التوليد — أي خطأ يُرمى كـ ProviderError ليُصنَّف
 * في classifyProviderError (قسم 4.2).
 */

export class ProviderError extends Error {
  status: number | null;
  constructor(status: number | null, message: string) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

/** خطأ معطيات الطلب نفسها (الموديل/البرومبت) — يوقف التبديل فورًا */
export class ParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParamsError";
  }
}

/** لا توجد مفاتيح نشطة للموديل المطلوب */
export class NoKeysError extends Error {
  constructor(modelCanonical: string) {
    super(
      `❌ لا توجد مفاتيح نشطة لخدمة ${modelCanonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
    );
    this.name = "NoKeysError";
  }
}

export interface TaskHandle {
  providerTaskId: string;
}

export interface ProviderTaskState {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number; // تقدير 0..100 (المزودون لا يرسلون نسبة حقيقية)
}

export interface ProviderAdapter {
  /** مهمة غير متزامنة (فيديو، وبعض الصور): تعيد providerTaskId */
  createTask(key: string, model: string, input: Record<string, unknown>): Promise<TaskHandle>;
  /** صور متزامنة إن كان المزود يدعمها */
  createImageSync?(key: string, model: string, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  /** استعلام حالة مهمة جارية */
  checkTask(key: string, providerTaskId: string): Promise<ProviderTaskState>;
}
