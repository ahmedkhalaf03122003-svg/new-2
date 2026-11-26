import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { runGeneration, runMerge, refreshTask } from "@/lib/generation";
import { findModel, MODELS } from "@/lib/models";
import { ParamsError, ProviderError, NoKeysError } from "@/lib/providers/types";
import { mergerConfigured } from "@/lib/merger";
import { listRecentTasks, type Task } from "@/lib/turso";

/**
 * خادم MCP على المسار /mcp — نقل Streamable HTTP حسب مواصفات MCP.
 * وضع stateless (sessionIdGenerator: undefined) — الإلزام لتوافق بيئة Vercel
 * serverless حيث لا توجد ذاكرة مشتركة بين الاستدعاءات للجلسات.
 * استجابات الأدوات بالعربية؛ الأوصاف والمصطلحات بالإنجليزية (قاعدة ذهبية 8).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// نافذة الانتظار قد تصل 240 ثانية + مدة المعالجة — 300 الحد الأعلى على Vercel
export const maxDuration = 300;

const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

// ---------------------------------------------------------------
// صياغة الردود العربية (قسم 8)
// ---------------------------------------------------------------

function typeAr(type: Task["type"]): string {
  return type === "image" ? "صورة" : type === "video" ? "فيديو" : "دمج";
}

function statusAr(task: Task): string {
  switch (task.status) {
    case "completed": return "✅ مكتملة";
    case "failed": return "❌ فاشلة";
    default: return "⏳ جارية";
  }
}

function formatTaskResult(task: Task): string {
  if (task.status === "completed") {
    const links = task.resultUrls.map((u) => `الرابط المباشر: ${u}`).join("\n");
    if (task.type === "image") {
      const multi = task.resultUrls.length > 1 ? `\n\nروابط إضافية:\n${task.resultUrls.slice(1).map((u) => `- ${u}`).join("\n")}` : "";
      return `✅ تم توليد الصورة بنجاح\n\n![image](${task.resultUrls[0]})\n\n${links}${multi}`;
    }
    if (task.type === "video") {
      return `✅ تم توليد الفيديو بنجاح\n\n${links}`;
    }
    return `✅ تم دمج المقاطع بنجاح\n\n${links}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
  }
  if (task.status === "failed") {
    return `❌ فشلت المهمة: ${task.errorMessage ?? "سبب غير معروف"}`;
  }
  // processing / pending — لا تُذكر أي رسائل داخلية عن المفاتيح أو الرصيد أبدًا
  return `⏳ المهمة قيد المعالجة — task_id: ${task.id}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

function errorResult(e: unknown) {
  if (e instanceof NoKeysError) return textResult(e.message, true);
  if (e instanceof ParamsError) return textResult(e.message, true);
  // لا تسريب لأخطاء المفاتيح/الرصيد للعميل — تصنيفها يبقى داخليًا (قاعدة ذهبية 4)
  if (e instanceof ProviderError) return textResult("❌ تعذر إتمام العملية لدى المزود حاليًا. أعد المحاولة بعد قليل.", true);
  return textResult(`❌ حدث خطأ غير متوقع: ${(e as Error).message ?? "unknown"}`, true);
}

/** جسر الإشعارات: يبث التقدم كل ~3 ثوانٍ إن زوّد العميل بـ progressToken وتدفق SSE متاح */
function makeNotify(
  progressToken: string | number | undefined,
  sseAvailable: boolean,
  sendNotification: ((n: ServerNotification) => Promise<void>) | undefined,
) {
  return async (progress: number, message: string) => {
    if (progressToken === undefined || !sseAvailable || !sendNotification) return;
    try {
      const notification: ServerNotification = {
        method: "notifications/progress",
        params: { progressToken, progress, total: 100, message },
      };
      await sendNotification(notification);
    } catch {
      // فشل إشعار لا يكسر المهمة أبدًا
    }
  };
}

interface ToolExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (n: ServerNotification) => Promise<void>;
  requestInfo?: { headers?: Record<string, string | string[] | undefined> };
}

/** استخراج إعدادات الإشعارات من extra الخاص بالأداة */
function notifyFromExtra(extra: ToolExtra) {
  const hv = extra.requestInfo?.headers?.["accept"];
  const accept = Array.isArray(hv) ? hv.join(",") : (hv ?? "");
  return makeNotify(
    extra._meta?.progressToken,
    accept.includes("text/event-stream"),
    extra.sendNotification,
  );
}

// ---------------------------------------------------------------
// تسجيل الأدوات الخمس بأوصافها الدقيقة
// ---------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active keys). " +
        "Returns a ready image URL if generation completes within the wait window, otherwise returns a task_id — " +
        "call get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z
          .enum(["auto", "transparent", "opaque"])
          .default("auto")
          .describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      const notify = notifyFromExtra(extra);
      try {
        const task = await runGeneration({
          type: "image",
          prompt: args.prompt,
          model: args.model,
          params: {
            aspect_ratio: args.aspect_ratio,
            resolution: args.resolution,
            background: args.background,
            output_format: args.output_format,
          },
          waitSeconds: args.wait_seconds,
          notify,
        });
        return textResult(formatTaskResult(task), task.status === "failed");
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio: dialogue/effects/music, optional image-to-video). " +
        "Videos take minutes: a short wait streams progress, then a task_id is returned — track it with get_task every ~10 seconds until completed.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      const notify = notifyFromExtra(extra);
      try {
        const task = await runGeneration({
          type: "video",
          prompt: args.prompt,
          model: args.model,
          params: {
            image_url: args.image_url,
            aspect_ratio: args.aspect_ratio,
            resolution: args.resolution,
            enable_audio: args.enable_audio,
            duration: args.duration,
          },
          waitSeconds: args.wait_seconds,
          notify,
        });
        return textResult(formatTaskResult(task), task.status === "failed");
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "Merge several clips into ONE final video in the given order. Pass 'urls' (public direct video URLs — e.g. links from generate_video) " +
        "or 'task_ids' (task_ids of COMPLETED video generation tasks — their result URLs are merged in this order). " +
        "Merging is usually fast: a short wait streams progress, then a merge task_id is returned — track it with get_task. " +
        "Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z
          .array(z.string())
          .min(2)
          .max(10)
          .optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z
          .array(z.string())
          .min(2)
          .max(10)
          .optional()
          .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      const notify = notifyFromExtra(extra);
      try {
        const task = await runMerge({
          urls: args.urls,
          taskIds: args.task_ids,
          waitSeconds: args.wait_seconds,
          notify,
        });
        return textResult(formatTaskResult(task), task.status === "failed");
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "Track any task by its id — image/video generation AND merging (reads the database and refreshes live from the provider/service while in progress). " +
        "Poll every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().min(1),
      },
    },
    async (args, extra) => {
      const notify = notifyFromExtra(extra);
      try {
        const task = await refreshTask(args.task_id, notify);
        if (!task) return textResult(`❌ لم يتم العثور على مهمة بالمعرّف: ${args.task_id}`, true);
        return textResult(formatTaskResult(task), task.status === "failed");
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description:
        "Latest stored images/videos/merges with their result URLs from the database (no regeneration) — to recall previously generated media.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      try {
        const tasks = await listRecentTasks(args.limit, { type: args.type, status: args.status });
        if (tasks.length === 0) {
          return textResult("لا توجد وسائط مخزنة بعد — استخدم generate_image أو generate_video أولًا.");
        }
        const lines = tasks.map((t) => {
          const link = t.resultUrls.length > 0 ? ` — ${t.resultUrls[0]}` : "";
          const snippet = t.prompt.length > 60 ? `${t.prompt.slice(0, 60)}…` : t.prompt;
          return `- [${typeAr(t.type)}] task_id: ${t.id} — «${snippet}» — ${statusAr(t)}${link}`;
        });
        return textResult(`📋 أحدث الوسائط المخزنة (${tasks.length}):\n\n${lines.join("\n")}`);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // أدوات إضافية داخلية لا يراها العميل؟ لا شيء — الأدوات الخمس فقط حسب المواصفة
  return server;
}

// ---------------------------------------------------------------
// معالج المسار
// ---------------------------------------------------------------

function checkAuth(req: Request): boolean {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return true; // غير مضبوط → الوصول مفتوح
  return (req.headers.get("authorization") ?? "") === `Bearer ${token}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleMcp(req: Request): Promise<Response> {
  if (!checkAuth(req)) {
    return jsonResponse(
      { error: "Unauthorized — ضبط MCP_ACCESS_TOKEN يتطلب ترويسة Authorization: Bearer <token>" },
      401,
    );
  }

  // CORS/OPTIONS لعملاء المتصفح
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        Allow: "POST, DELETE, OPTIONS",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id, MCP-Protocol-Version",
      },
    });
  }

  // وضع stateless: خادم وترخيص جديدان لكل طلب، بلا جلسات في الذاكرة
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  transport.onclose = () => {
    void server.close().catch(() => {});
  };
  await server.connect(transport);

  try {
    return await transport.handleRequest(req);
  } catch (e) {
    return jsonResponse({ error: `خطأ داخلي في خادم MCP: ${(e as Error).message}` }, 500);
  }
}

export { handleMcp as POST, handleMcp as GET, handleMcp as DELETE, handleMcp as OPTIONS };

// مسار مساعد صغير للفحص اليدوي: أسماء الأدوات والموديلات المسجلة
export async function HEAD(): Promise<Response> {
  const mergeReady = mergerConfigured();
  return jsonResponse({
    server: SERVER_INFO,
    tools: ["generate_image", "generate_video", "merge_videos", "get_task", "list_media"],
    models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
    mergerConfigured: mergeReady,
    knownModels: MODELS.every((m) => Boolean(findModel(m.canonical))),
  });
}
