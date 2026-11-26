import { NextRequest, NextResponse } from "next/server";
import { deleteKey, setKeyStatus } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PATCH /api/keys/{id} {status: "active"|"disabled"} — تعطيل/تنشيط يدوي */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: { status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "جسم الطلب ليس JSON صالحًا" }, { status: 400 });
  }
  if (body.status !== "active" && body.status !== "disabled") {
    return NextResponse.json({ error: "الحالة المسموحة: active أو disabled" }, { status: 400 });
  }
  const ok = await setKeyStatus(id, body.status);
  if (!ok) return NextResponse.json({ error: "لم يتم العثور على المفتاح" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/** DELETE /api/keys/{id} — حذف نهائي */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ok = await deleteKey(id);
  if (!ok) return NextResponse.json({ error: "لم يتم العثور على المفتاح" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
