# MCP Media Generator + خدمة دمج الفيديو

مشروعان في مستودع واحد يعملان معًا:

| المشروع | المسار | الوصف |
|---|---|---|
| **خادم MCP لتوليد الوسائط** | `src/` (Next.js) | توليد صور وفيديو بالذكاء الاصطناعي عبر `kie.ai` و`CometAPI` مع **تبديل تسلسلي تلقائي للمفاتيح**، ودمج المقاطع، ولوحة إدارة عربية RTL |
| **خدمة دمج الفيديو** | `merger/` (Node خالص) | API عامة لدمج مقاطع الفيديو (ffmpeg) مع تخزين كامل في Turso — تفاصيلها في [merger/README.md](merger/README.md) |

**قواعد جوهرية مطبقة:**

- لا يُنزَّل أي ملف وسائط على السيرفر إطلاقًا — تُخزَّن **روابط النتائج فقط** في قاعدة البيانات.
- المفاتيح تُجرَّب **بتسلسل صارم حسب ترتيب الإضافة** مع تبديل فوري عند أي خطأ أو نفاد رصيد دون توقف المهمة، ونموذج الذكاء الاصطناعي **لا يرى أخطاء المفاتيح أو الرصيد أبدًا**.
- التوليد غير متزامن: `task_id` فوري + بث تقدم حي، ثم تتبع بأداة `get_task` كل ~10 ثوانٍ.
- المفاتيح مُخفية دائمًا (`ABCD123••••••••WXYZ`) في كل الاستجابات.
- لا أسرار في الكود أو Git — `.env*` مستثناة منذ أول commit.

---

## الأدوات الخمس على `/mcp`

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة بـ `gpt-image-2-6/flare-text-to-image` |
| `generate_video` | توليد فيديو بـ `grok-imagine-video-1-5-preview` (صوت متزامن أصلي، image-to-video اختياري) |
| `merge_videos` | دمج 2–10 مقاطع عبر `urls` أو `task_ids` لمهام مكتملة |
| `get_task` | تتبع أي مهمة بمعرّفها حتى الاكتمال |
| `list_media` | أحدث الوسائط المخزنة بروابطها |

سجل أسماء الموديلات قابلة للتجاوز بمتغيرات البيئة (`KIE_IMAGE_MODEL`، `KIE_VIDEO_MODEL`، `COMETAPI_IMAGE_MODEL`، `COMETAPI_VIDEO_MODEL`)، والصيغ البديلة بالنقاط (`gpt-image-2.6/...`) تُقبل وتُوحَّد تلقائيًا.

---

## التشغيل المحلي

```bash
# 1) المشروع الرئيسي (منفذ 3000)
npm install
cp .env.example .env.local   # ثم ضع القيم الحقيقية
npm run dev

# 2) خدمة الدمج (منفذ 3001) — في طرفية أخرى
cd merger
npm install
cp .env.example .env         # ثم ضع القيم الحقيقية
npm run dev

# اختبارات
npm run typecheck            # tsc --noEmit
npm run build                # next build
cd merger && npm test        # اختبار وحدات المحرك والتخزين
node scripts/test-http.js    # اختبار HTTP كامل (يجب أن يكون dev-server يعمل)
```

ثم جرّب MCP:

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# ثم tools/list أو tools/call بالطريقة نفسها (وضع stateless: لا حاجة لمعرّف جلسة)
```

---

## النشر على Vercel (مشروعان من نفس المستودع)

### المشروع الأول: خادم MCP (الجذر `/`)

1. Vercel → **Add New Project** → اختر المستودع `new-2`.
2. **Framework Preset**: يُكتشف تلقائيًا Next.js — **Root Directory**: `./` (اتركه فارغًا).
3. **Environment Variables** (Settings → Environment Variables):
   | المتغير | القيمة |
   |---|---|
   | `TURSO_DATABASE_URL` | `libsql://cartoon2-ahmed123456.aws-ap-northeast-1.turso.io` |
   | `TURSO_AUTH_TOKEN` | توكن Turso بصلاحيات كتابة |
   | `MERGER_API_BASE` | **رابط مشروع خدمة الدمج بعد نشره** (مثل `https://new-2-merger.vercel.app`) |
   | `MCP_ACCESS_TOKEN` | اختياري — إن ضُبط يُطلب `Authorization: Bearer <token>` على `/mcp` |
4. Deploy.

### المشروع الثاني: خدمة الدمج (المجلد `merger/`)

1. Vercel → **Add New Project** → نفس المستودع مرة أخرى.
2. **Framework Preset**: Other — **Root Directory**: `merger`.
3. **Environment Variables**: `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` (إلزاميان) + الحدود الاختيارية — القائمة الكاملة في [merger/README.md](merger/README.md).
4. Deploy، ثم انسخ رابط النشر وضعه في `MERGER_API_BASE` للمشروع الأول وأعد نشره (Redeploy).

> ملاحظة: الرابط الناتج عن الدمج يُحذف تلقائيًا بعد 24 ساعة من خدمة الدمج — تُنبَّه الأداة والنموذج المستخدم بذلك تلقائيًا.

---

## واجهة الإدارة

الصفحة الرئيسية هي لوحة عربية RTL من ثلاث بطاقات:

- **مدير المفاتيح**: إضافة/تعطيل/حذف مفاتيح kie.ai و CometAPI (مُقنَّعة دائمًا) مع عدّادات الاستخدام وآخر خطأ وشارات حالة ملونة (`نشط` أخضر / `مستنزف` كهرماني / `معطّل` رمادي).
- **لوحة المهام**: شرائح إحصائيات + قائمة تتحدث تلقائيًا كل 5 ثوانٍ (نوع، حالة، شريط تقدم، موديل، وصف، روابط النتائج، عدد المحاولات).
- **ربط السيرفر**: رابط `<origin>/mcp` جاهز للنسخ + JSON لكل عميل (ChatGPT Connectors / Claude Desktop / Cursor & Windsurf & Cline) + رقائق الأدوات الخمس.

## نقاط فحص الجهوزية

```bash
curl https://<APP>/api/health
# {"ok":true,"database":"turso-connected","mcpEndpoint":"/mcp","models":[...],
#  "merger":{"base":"...","configured":true,"healthy":true},"authRequired":false}
```

## بنية المستودع

```
├── src/
│   ├── app/mcp/route.ts            # خادم MCP (Streamable HTTP، وضع stateless)
│   ├── app/api/health/route.ts
│   ├── app/api/keys/route.ts + [id]
│   ├── app/api/tasks/route.ts
│   ├── app/page.tsx                # لوحة الإدارة العربية
│   └── lib/
│       ├── turso.ts                # طبقة قاعدة البيانات + ensureSchema
│       ├── keys.ts                 # مجموعة المفاتيح التسلسلية + classifyProviderError + maskKey
│       ├── models.ts               # سجل الموديلات وAliases
│       ├── generation.ts           # منسق التوليد بالتبديل التسلسلي «لا توقف أبدًا»
│       ├── merger.ts               # عميل خدمة الدمج v2 (دفاعي)
│       └── providers/              # kie.ts (Jobs API) + cometapi.ts + types.ts
├── merger/                         # خدمة الدمج — Node خالص (تفاصيلها داخلها)
│   ├── api/                        # jobs / upload / process / video / config / cron
│   ├── lib/                        # db (Blobs صفوف 2MB) + engine (ffmpeg) + util
│   ├── public/index.html           # واجهة دمج عربية داكنة
│   ├── dev-server.js               # محاكي بيئة Vercel محليًا
│   └── scripts/                    # test-unit / test-http / cleanup-turso
├── .env.example
└── vercel.json
```
