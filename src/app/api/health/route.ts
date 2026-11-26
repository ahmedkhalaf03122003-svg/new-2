import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerHealthy, mergerBase, mergerConfigured } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/health — شكل الاستجابة حسب القسم 9 من المواصفة */
export async function GET() {
  const dbOk = await dbHealthy();
  const mergerReady = mergerConfigured();
  const mergerOk = mergerReady ? await mergerHealthy() : false;

  return NextResponse.json({
    ok: dbOk,
    database: dbOk ? "turso-connected" : "turso-error",
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
    merger: {
      base: mergerBase() || null,
      configured: mergerReady,
      healthy: mergerOk,
    },
    authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
  });
}
