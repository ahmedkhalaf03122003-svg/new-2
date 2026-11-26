"use strict";

/**
 * طبقة قاعدة البيانات — Turso (libSQL عبر HTTP).
 * كل شيء يُخزن هنا: المهام، أجزاء ملفات المصادر، والفيديو الناتج (Blobs).
 * لا S3 ولا خدمات خارجية ولا نظام ملفات دائم.
 */

const { createClient } = require("@libsql/client");
const { expiresAtSql } = require("./util");

let client = null;
function db() {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      const e = new Error("متغيرا TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبان");
      e.status = 500;
      throw e;
    }
    client = createClient({ url, authToken: token });
  }
  return client;
}

// ---------------------------------------------------------------
// المخطط — CREATE TABLE IF NOT EXISTS مع مفتاح أساسي مركب
// ---------------------------------------------------------------

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    status TEXT DEFAULT 'queued',
    progress INTEGER DEFAULT 0,
    error TEXT,
    size INTEGER,
    duration REAL,
    resolution TEXT,
    video_url TEXT,
    download_url TEXT,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    processed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sources (
    job_id TEXT,
    seq INTEGER,
    kind TEXT,
    url TEXT,
    name TEXT,
    mime TEXT,
    size INTEGER,
    received INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    PRIMARY KEY (job_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS source_chunks (
    job_id TEXT,
    seq INTEGER,
    chunk INTEGER,
    data BLOB,
    PRIMARY KEY (job_id, seq, chunk)
  )`,
  `CREATE TABLE IF NOT EXISTS output_chunks (
    job_id TEXT,
    chunk INTEGER,
    data BLOB,
    PRIMARY KEY (job_id, chunk)
  )`,
];

let schemaPromise = null;
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      for (const sql of SCHEMA) {
        await db().execute(sql);
      }
    })().catch((e) => {
      schemaPromise = null;
      throw e;
    });
  }
  return schemaPromise;
}

// ---------------------------------------------------------------
// المهام
// ---------------------------------------------------------------

async function createJob(id, sources) {
  await ensureSchema();
  const expires = expiresAtSql();
  const statements = [
    {
      sql: `INSERT INTO jobs (id, status, progress, expires_at) VALUES (?, ?, 0, ?)`,
      args: [id, sources.some((s) => s.kind === "file") ? "uploading" : "queued", expires],
    },
    ...sources.map((s, i) => ({
      sql: `INSERT INTO sources (job_id, seq, kind, url, name, mime, size, received, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      args: [id, i, s.kind, s.url ?? null, s.name ?? null, s.mime ?? null, s.size ?? null, s.kind === "file" ? "uploading" : "ready"],
    })),
  ];
  await db().batch(statements, "write");
  return { id, expiresAt: expires };
}

function rowToJob(row) {
  return {
    id: String(row.id),
    status: String(row.status),
    progress: Number(row.progress ?? 0),
    error: row.error ? String(row.error) : null,
    size: row.size == null ? null : Number(row.size),
    duration: row.duration == null ? null : Number(row.duration),
    resolution: row.resolution ? String(row.resolution) : null,
    videoUrl: row.video_url ? String(row.video_url) : null,
    downloadUrl: row.download_url ? String(row.download_url) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    createdAt: row.created_at ? String(row.created_at) : null,
    processedAt: row.processed_at ? String(row.processed_at) : null,
  };
}

async function getJob(id) {
  await ensureSchema();
  const r = await db().execute({ sql: "SELECT * FROM jobs WHERE id = ?", args: [id] });
  if (r.rows.length === 0) return null;
  const job = rowToJob(r.rows[0]);
  const rs = await db().execute({
    sql: "SELECT seq, kind, url, name, mime, size, received, status FROM sources WHERE job_id = ? ORDER BY seq ASC",
    args: [id],
  });
  job.sources = rs.rows.map((row) => ({
    seq: Number(row.seq),
    kind: String(row.kind),
    url: row.url ? String(row.url) : null,
    name: row.name ? String(row.name) : null,
    mime: row.mime ? String(row.mime) : null,
    size: row.size == null ? null : Number(row.size),
    received: Number(row.received ?? 0),
    status: String(row.status),
  }));
  return job;
}

async function updateJob(id, patch) {
  await ensureSchema();
  const sets = [];
  const args = [];
  for (const key of ["status", "error", "resolution", "video_url", "download_url", "processed_at"]) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = ?`);
      args.push(patch[key]);
    }
  }
  if (patch.progress !== undefined) {
    sets.push("progress = ?");
    args.push(Math.max(0, Math.min(100, Math.round(patch.progress))));
  }
  if (patch.size !== undefined) {
    sets.push("size = ?");
    args.push(patch.size);
  }
  if (patch.duration !== undefined) {
    sets.push("duration = ?");
    args.push(patch.duration);
  }
  if (sets.length === 0) return;
  args.push(id);
  await db().execute({ sql: `UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args });
}

async function deleteJob(id) {
  await ensureSchema();
  await db().batch(
    [
      { sql: "DELETE FROM jobs WHERE id = ?", args: [id] },
      { sql: "DELETE FROM sources WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [id] },
    ],
    "write",
  );
}

/** التنظيف الكسول: حذف المهام المنتهية الصلاحية (24 ساعة) + أجزائها */
async function cleanupExpired() {
  await ensureSchema();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const r = await db().execute({
    sql: "SELECT id FROM jobs WHERE expires_at IS NOT NULL AND expires_at < ?",
    args: [now],
  });
  let deleted = 0;
  for (const row of r.rows) {
    await deleteJob(String(row.id));
    deleted++;
  }
  return deleted;
}

// ---------------------------------------------------------------
// تخزين الـ Blobs — تقسيم لصفوف 2MB (حد HTTP في Turso) وقراءة تدفقية بصفحات
// ---------------------------------------------------------------

const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB لكل صف
const READ_PAGE_ROWS = 8; // 8 صفوف لكل استعلام (16MB)

async function appendSourceChunk(jobId, seq, chunkIdx, buffer) {
  await ensureSchema();
  await db().batch(
    [
      {
        sql: "INSERT INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)",
        args: [jobId, seq, chunkIdx, new Uint8Array(buffer)],
      },
      {
        sql: "UPDATE sources SET received = received + ?, status = CASE WHEN received + ? >= size THEN 'ready' ELSE 'uploading' END WHERE job_id = ? AND seq = ?",
        args: [buffer.length, buffer.length, jobId, seq],
      },
    ],
    "write",
  );
}

/** مولّد يقرأ أجزاء المصدر تدفقيًا بصفحات من 8 صفوف */
async function* readSourceChunks(jobId, seq) {
  await ensureSchema();
  let offset = 0;
  while (true) {
    const r = await db().execute({
      sql: "SELECT chunk, data FROM source_chunks WHERE job_id = ? AND seq = ? ORDER BY chunk ASC LIMIT ? OFFSET ?",
      args: [jobId, seq, READ_PAGE_ROWS, offset],
    });
    if (r.rows.length === 0) break;
    for (const row of r.rows) {
      yield Buffer.from(row.data);
    }
    offset += r.rows.length;
    if (r.rows.length < READ_PAGE_ROWS) break;
  }
}

async function writeOutputChunks(jobId, buffer) {
  await ensureSchema();
  const statements = [];
  for (let i = 0; i * CHUNK_SIZE < buffer.length; i++) {
    statements.push({
      sql: "INSERT INTO output_chunks (job_id, chunk, data) VALUES (?, ?, ?)",
      args: [jobId, i, new Uint8Array(buffer.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE))],
    });
    if (statements.length >= 5) {
      await db().batch(statements, "write");
      statements.length = 0;
    }
  }
  if (statements.length > 0) await db().batch(statements, "write");
}

/** مولّد يقرأ الفيديو الناتج تدفقيًا بصفحات من 8 صفوف */
async function* readOutputChunks(jobId) {
  await ensureSchema();
  let offset = 0;
  while (true) {
    const r = await db().execute({
      sql: "SELECT chunk, data FROM output_chunks WHERE job_id = ? ORDER BY chunk ASC LIMIT ? OFFSET ?",
      args: [jobId, READ_PAGE_ROWS, offset],
    });
    if (r.rows.length === 0) break;
    for (const row of r.rows) {
      yield Buffer.from(row.data);
    }
    offset += r.rows.length;
    if (r.rows.length < READ_PAGE_ROWS) break;
  }
}

async function deleteSourceChunks(jobId) {
  await ensureSchema();
  await db().execute({ sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] });
}

module.exports = {
  db,
  ensureSchema,
  createJob,
  getJob,
  updateJob,
  deleteJob,
  cleanupExpired,
  appendSourceChunk,
  readSourceChunks,
  writeOutputChunks,
  readOutputChunks,
  deleteSourceChunks,
  CHUNK_SIZE,
  READ_PAGE_ROWS,
};
