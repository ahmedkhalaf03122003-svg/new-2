"use strict";

/**
 * أداة تنظيف: حذف كل المهام من قاعدة Turso (تُستخدم بعد الاختبارات).
 * تشغيل: node scripts/cleanup-turso.js [--jobs|--tasks|--all]
 * الافتراضي: كل الجداول المملوكة للمشاريع (tasks من المشروع الرئيسي + jobs من خدمة الدمج).
 */

const fs = require("fs");
const path = require("path");
const { createClient } = require("@libsql/client");

// تحميل متغيرات البيئة من merger/.env ثم من new-2/.env.local
for (const p of [path.join(__dirname, "..", ".env"), path.join(__dirname, "..", "..", ".env.local")]) {
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  }
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const mode = process.argv[2] || "--all";

async function main() {
  if (mode === "--jobs" || mode === "--all") {
    // مهام خدمة الدمج
    for (const sql of [
      "DELETE FROM output_chunks",
      "DELETE FROM source_chunks",
      "DELETE FROM sources",
      "DELETE FROM jobs",
    ]) {
      const r = await db.execute(sql);
      console.log(`merger ${sql}: rowsAffected=${r.rowsAffected}`);
    }
  }
  if (mode === "--tasks" || mode === "--all") {
    // مهام المشروع الرئيسي + مفاتيح الاختبار الوهمية (الجدول قد لا يكون موجودًا بعد)
    try {
      const r1 = await db.execute("DELETE FROM tasks");
      console.log(`main tasks: rowsAffected=${r1.rowsAffected}`);
    } catch (e) {
      console.log(`main tasks: ${e.message.includes("no such table") ? "الجدول غير موجود بعد (طبيعي قبل أول تشغيل)" : e.message}`);
    }
    try {
      const r2 = await db.execute("DELETE FROM api_keys WHERE label LIKE '%test%' OR label LIKE '%اختبار%' OR api_key LIKE 'invalid-%'");
      console.log(`main test keys: rowsAffected=${r2.rowsAffected}`);
    } catch (e) {
      console.log(`main test keys: ${e.message.includes("no such table") ? "الجدول غير موجود بعد (طبيعي قبل أول تشغيل)" : e.message}`);
    }
  }
  console.log("✅ اكتمل التنظيف");
}

main().catch((e) => {
  console.error("فشل التنظيف:", e.message);
  process.exit(1);
});
