/**
 * سجل الموديلات — الأسماء الرسمية كما يراها عميل MCP مع صيغ بديلة تُوحَّد،
 * وأسماء المزودين قابلة للتجاوز بمتغيرات البيئة.
 */

export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحدّها (شرطات/نقاط)
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحهم كلها بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسَل لكل مزود
}

// الأسماء المدمجة مثبّتة كما هي، وتُجرَّب من البيئة إن لزم (قسم 5.1)
const KIE_IMAGE_MODEL = process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
const KIE_VIDEO_MODEL = process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
const COMETAPI_IMAGE_MODEL = process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image";
const COMETAPI_VIDEO_MODEL = process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1-5-preview";

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image", "gpt-image-2-6/flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_IMAGE_MODEL, cometapi: COMETAPI_IMAGE_MODEL },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview", "grok-imagine-video-1-5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_VIDEO_MODEL, cometapi: COMETAPI_VIDEO_MODEL },
  },
];

/**
 * توحيد اسم الموديل: استبدال النقاط بشرطات يوحّد الصيغ البديلة المعتمدة
 * (gpt-image-2.6/... ← gpt-image-2-6/...) — الأسماء الرسمية بلا نقاط.
 */
export function normalizeModelName(name: string): string {
  return (name || "").trim().replace(/\./g, "-");
}

/** إيجاد موديل بالاسم الموحّد — غير معروف يعيد null (خطأ معطيات فوري) */
export function findModel(name: string): ModelDef | null {
  const n = normalizeModelName(name);
  return MODELS.find((m) => normalizeModelName(m.canonical) === n) ?? null;
}

/** موديل الدمج — يُسجَّل في قاعدة البيانات بنوع merge */
export const MERGE_MODEL = "video-merger";
