# خدمة دمج الفيديوهات — Video Merger API v2

موقع كامل لدمج الفيديوهات مع واجهة برمجية عامة (API) للمطورين — Node.js خالص (CommonJS) بلا Next.js أو React أو خطوة بناء: واجهة ثابتة في `public/` + دوال Vercel Serverless في `api/`، وكل التخزين في **Turso** (لا S3 ولا خدمات خارجية).

## الواجهة (عربية RTL — ثيم داكن بتدرجات سماوي/بنفسجي)

- حقل رابط + زر إضافة، ومنطقة **سحب وإفلات** لرفع الملفات (mp4/mov/webm/mkv/avi/m4v/mpg/3gp).
- قائمة مصادر قابلة لإعادة الترتيب بالسحب أو أزرار ↑↓ مع حذف — **ترتيب القائمة = ترتيب الدمج**.
- زر «دمج الفيديوهات» ينفذ التدفق كاملًا: إنشاء مهمة → رفع الأجزاء (4MB ×إعادة محاولة 3) → الدمج → النتيجة، مع شريط تقدم حقيقي من تقدم الخادم.
- صفحة النتيجة: مشغل، الحجم/المدة/الدقة، تحميل، نسخ الرابط، عملية جديدة، وعدّاد تنازلي حتى الحذف (24 ساعة).
- قسم «توثيق API» قابل للطي بأمثلة curl بالدومين الحقيقي.
- استئناف العرض بعد تحديث الصفحة عبر `#job=<id>`.

## واجهة API العامة (بدون تسجيل دخول، CORS مفتوح، الأخطاء `{"error":"..."}`)

| Method | Endpoint | الوظيفة |
|---|---|---|
| `POST` | `/api/jobs` | إنشاء مهمة دمج |
| `POST` | `/api/upload?job=<id>&seq=<n>&chunk=<k>` | رفع أجزاء الملفات (ثنائي ≤4MB، octet-stream) |
| `POST` | `/api/jobs/{id}/process` | تنفيذ الدمج كاملًا → رابط الفيديو النهائي |
| `GET` | `/api/jobs/{id}` | الحالة + التقدم (0–100) + الرابط عند الاكتمال |
| `GET` | `/api/jobs/{id}/video` | بث الناتج بدعم Range — `?download=1` للتحميل |
| `DELETE` | `/api/jobs/{id}` | حذف فوري شامل |
| `GET` | `/api/config` | الحدود العامة + version |
| `GET` | `/api/cron` | حذف المهام المنتهية (Cron يومي عبر vercel.json) |

### أمثلة curl واستجاباتها

```bash
# 1) إنشاء مهمة من روابط مباشرة عامة
curl -X POST https://YOUR-DOMAIN/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4","https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_2MB.mp4"]}'
# 201:
# {"jobId":"wkucdefoxwvd","status":"queued",
#  "statusUrl":"https://YOUR-DOMAIN/api/jobs/wkucdefoxwvd",
#  "processUrl":"https://YOUR-DOMAIN/api/jobs/wkucdefoxwvd/process",
#  "expiresAt":"2026-11-27 18:00:00"}

# مع ملفات:
curl -X POST https://YOUR-DOMAIN/api/jobs -H "Content-Type: application/json" \
  -d '{"sources":[{"kind":"url","url":"https://example.com/a.mp4"},{"kind":"file","name":"clip.mp4","size":1234567,"mime":"video/mp4"}]}'
# 201: نفس الشكل + {"uploads":[{"seq":1,"url":"https://YOUR-DOMAIN/api/upload?job=...&seq=1&chunk=0","uploadChunkBytes":4194304}]}

# 2) رفع الأجزاء (كل جزء ≤4MB ثنائي):
curl -X POST "https://YOUR-DOMAIN/api/upload?job=wkucdefoxwvd&seq=1&chunk=0" \
  -H "Content-Type: application/octet-stream" --data-binary @chunk_000
# 200: {"ok":true,"received":4194304,"size":1234567,"complete":false}

# 3) تنفيذ الدمج (متزامن ~10-15 ثانية للحالات الصغيرة):
curl -X POST https://YOUR-DOMAIN/api/jobs/wkucdefoxwvd/process
# 200:
# {"status":"done","videoUrl":"https://YOUR-DOMAIN/api/jobs/wkucdefoxwvd/video",
#  "downloadUrl":"https://YOUR-DOMAIN/api/jobs/wkucdefoxwvd/video?download=1",
#  "size":1234567,"duration":30.2,"resolution":"640x360","expiresAt":"..."}
# فشل معلن (مثل مصدر يرفض التحميل) → 500 + {"error":"Download failed (HTTP 403)"}
# قيد المعالجة → 202 + {"status":"processing","progress":55}

# 4) الحالة والتقدم:
curl https://YOUR-DOMAIN/api/jobs/wkucdefoxwvd
# {"jobId":"...","status":"done","progress":100,"videoUrl":"...","size":...,"duration":...,"resolution":"..."}

# 5) البث والتحميل (يدعم Range لمشغل الويب):
curl -H "Range: bytes=0-99" -i https://YOUR-DOMAIN/api/jobs/wkucdefoxwvd/video   # 206 + Content-Range
curl -o merged.mp4 "https://YOUR-DOMAIN/api/jobs/wkucdefoxwvd/video?download=1"

# 6) حذف فوري شامل:
curl -X DELETE https://YOUR-DOMAIN/api/jobs/wkucdefoxwvd   # {"ok":true,"deleted":"..."}

# 7) الحدود:
curl https://YOUR-DOMAIN/api/config
# {"ok":true,"version":"1.0.0","limits":{"maxSources":10,"sourceMaxMB":200,"outputMaxMB":150,...}}
```

حالات المهمة: `queued` → (`uploading`) → `processing` → `done` | `failed` مع عمود `progress` 0–100.
أكواد الرفض: 400 مدخلات تالفة · 404 غير موجود · 409 حالة غير مناسبة · 413 تجاوز الحجم · 405 طريقة خاطئة.

## محرك الدمج (جودة عالية)

- ffprobe لكل مصدر: الدقة، معدل الإطارات، المدة، وجود الصوت.
- توحيد عبر `filter_complex`: scale + pad إلى **أكبر دقة بين المدخلات** (حد أقصى 1920×1080 أبعاد زوجية)، `fps=30`، `setsar=1`، `format=yuv420p` ثم `concat`.
- مصدر بلا صوت؟ مسار صامت `anullsrc` بنفس مدته بدل أن يفشل الدمج.
- الترميز: **libx264 CRF 18 + AAC 192k/44100 + +faststart** — MP4 يعمل فورًا على الويب. الـ preset من `FFMPEG_PRESET`.
- تقدم الترميز من `-progress pipe:1` (out_time_us): 0–40 سحب المصادر، 40–90 ترميز، 100 اكتمال.
- `ensureExecutable` ينسخ ثنائي ffmpeg إلى /tmp بصلاحية 755 عند فقدان صلاحية التنفيذ في الاستضافة.
- فحص الحدود قبل وأثناء العمل: عدد المصادر، حجم كل مصدر أثناء التنزيل، حجم الناتج، المدة الإجمالية.

## التخزين والحذف التلقائي (24 ساعة)

- الجداول: `jobs`، `sources`، `source_chunks`، `output_chunks` (مفاتيح أساسية مركبة، `CREATE TABLE IF NOT EXISTS`).
- كل Blob يُقسَّم إلى **صفوف 2MB** (حد HTTP في Turso) ويُقرأ تدفقيًا بصفحات من **8 صفوف**.
- كل مهمة لها `expires_at = created_at + 24 ساعة`؛ التنظيف كسول عند كل إنشاء/دمج + `/api/cron` يوميًا (vercel.json).
- DELETE يحذف كل صفوف المهمة في batch واحد، وبعد نجاح الدمج تُحذف أجزاء المصادر (الناتج فقط هو المطلوب).

## النشر على Vercel خطوة بخطوة

1. Vercel → **Add New Project** → اختر مستودع المشروع.
2. **Framework Preset**: `Other` — **Root Directory**: `merger`.
3. **Build Command**: اتركه فارغًا (لا خطوة بناء) — و **Output Directory** فارغ أيضًا.
4. أضف متغيرات البيئة ثم **Deploy**.

### متغيرات البيئة

| المتغير | إلزامي | الافتراضي | الوصف |
|---|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | — | رابط قاعدة Turso (`libsql://...`) |
| `TURSO_AUTH_TOKEN` | ✅ | — | توكن بصلاحيات كتابة |
| `MAX_SOURCES` | | 10 | أقصى عدد مصادر |
| `SOURCE_MAX_MB` | | 200 | أقصى حجم لمصدر واحد |
| `OUTPUT_MAX_MB` | | 150 | أقصى حجم للناتج |
| `MAX_TOTAL_DURATION_SEC` | | 600 | أقصى مجموع مدد المقاطع |
| `FFMPEG_PRESET` | | medium | preset ترميز ffmpeg (fast/veryfast لزيادة السرعة) |
| `PORT` | | 3001 | بورْت خادم التطوير المحلي فقط |

`vercel.json` يضبط `maxDuration: 300` لكل الدوال + cron يومي `0 3 * * *` (الحد المسموح في الخطة المجانية).

## حدود الخطة المجانية التي يجب معرفتها

| الحد | القيمة | الأثر هنا |
|---|---|---|
| حجم الطلب | ≈ 4.5MB | الرفع أجزاء 4MB ثنائية مع إعادة محاولة ×3 |
| مدة الدالة (Fluid compute) | حتى 300 ثانية | ضُبط في vercel.json — المقاطع الكبيرة جدًا قد تحتاج التقسيم |
| ذاكرة الدالة | 1GB (Hobby) | الترميز حتى 1080p يعمل؛ المقاطع الطويلة جدًا استخدم preset أسرع |
| حجم قاعدة Turso (مجانية) | ≈ 5GB | الناتج + الأجزاء المؤقتة يُحسبان — التنظيف التلقائي بعد 24 ساعة يجعل الاستهلاك مؤقتًا |
| تنفيذ Cron | يوميًا مرة واحدة (Hobby) | جدولة `0 3 * * *` متوافقة |

## التشغيل والاختبار المحلي

```bash
npm install
cp .env.example .env   # ضع متغيري Turso
npm run dev            # خادم تطوير يحاكي Vercel على :3001
npm test               # اختبار وحدات: توليد مقاطع بffmpeg ودمجها + sha256 للتخزين
node scripts/test-http.js   # اختبار HTTP كامل ضد خادم التطوير
node scripts/cleanup-turso.js --jobs  # تنظيف مهام الاختبار من القاعدة
```
