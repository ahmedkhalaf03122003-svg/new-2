import { NextRequest, NextResponse } from "next/server";
import { addKey, keyExists, listKeysMasked, type KeyProvider } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS: KeyProvider[] = ["kie", "cometapi"];

/** GET /api/keys — القائمة كاملة مع إخفاء المفاتيح دائمًا (maskKey) */
export async function GET() {
  const keys = await listKeysMasked();
  return NextResponse.json({ keys });
}

/** POST /api/keys {provider, api_key, label?} — رفض التكرار لنفس المزود */
export async function POST(req: NextRequest) {
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "جسم الطلب ليس JSON صالحًا" }, { status: 400 });
  }
  const provider = body.provider as KeyProvider | undefined;
  const apiKey = (body.api_key ?? "").trim();
  const label = (body.label ?? "").trim().slice(0, 100);

  if (!provider || !PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: "المزود مطلوب ويجب أن يكون أحد: kie أو cometapi" }, { status: 400 });
  }
  if (!apiKey) {
    return NextResponse.json({ error: "مفتاح API مطلوب" }, { status: 400 });
  }
  if (await keyExists(provider, apiKey)) {
    return NextResponse.json({ error: "هذا المفتاح مضاف مسبقًا لنفس المزود — الرفض لمنع التكرار" }, { status: 409 });
  }

  const { id } = await addKey(provider, apiKey, label);
  return NextResponse.json({ ok: true, id }, { status: 201 });
}
