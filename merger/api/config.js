"use strict";

/**
 * GET /api/config — الحدود العامة + version (تُستخدم لفحص الجهوزية في health)
 */

const { sendJson, LIMITS, VERSION } = require("../lib/util");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "الطريقة غير مسموحة" });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    version: VERSION,
    limits: {
      maxSources: LIMITS.maxSources,
      sourceMaxMB: LIMITS.sourceMaxMB,
      outputMaxMB: LIMITS.outputMaxMB,
      maxTotalDurationSec: LIMITS.maxTotalDurationSec,
      uploadChunkBytes: LIMITS.uploadChunkBytes,
      outputFormat: "MP4 (H.264 + AAC) حتى 1080p — CRF 18",
      retentionHours: 24,
    },
  });
};
