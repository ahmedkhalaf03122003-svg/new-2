import { NextRequest, NextResponse } from "next/server";
import { listRecentTasks, taskStats, type MediaType, type TaskStatus } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tasks — أحدث المهام + الإحصائيات للوحة المهام (تُستعلم كل ~5 ثوانٍ).
 * prompt يُقتطع سيرفريًا — لا حاجة لعرض الوصف كاملًا في القائمة.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const limit = Math.max(1, Math.min(50, Number(sp.get("limit") ?? 30) || 30));
  const type = (sp.get("type") ?? undefined) as MediaType | undefined;
  const status = (sp.get("status") ?? undefined) as TaskStatus | undefined;

  const [tasks, stats] = await Promise.all([
    listRecentTasks(limit, { type, status }),
    taskStats(),
  ]);

  return NextResponse.json({
    stats,
    tasks: tasks.map((t) => ({
      id: t.id,
      type: t.type,
      status: t.status,
      progress: t.progress,
      model: t.model,
      prompt: t.prompt.length > 140 ? `${t.prompt.slice(0, 140)}…` : t.prompt,
      resultUrls: t.resultUrls,
      errorMessage: t.errorMessage,
      attempts: t.attempts.length,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    })),
  });
}
