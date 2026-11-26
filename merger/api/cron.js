"use strict";

/**
 * GET /api/cron — حذف المهام المنتهية (Cron يومي عبر vercel.json)
 */

const store = require("../lib/db");
const { sendJson } = require("../lib/util");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "الطريقة غير مسموحة" });
    return;
  }
  try {
    const deleted = await store.cleanupExpired();
    sendJson(res, 200, { ok: true, deleted });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
};
