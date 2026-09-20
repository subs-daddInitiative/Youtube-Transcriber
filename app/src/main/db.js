const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'queue.db');
const WASM_PATH = path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let SQL;
let sqlDb;

/** sql.js keeps the DB in memory; persist it to disk after every write. */
function persist() {
  const data = sqlDb.export();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

async function openDb() {
  SQL = await initSqlJs({ locateFile: () => WASM_PATH });
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (fs.existsSync(DB_PATH)) {
    sqlDb = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    sqlDb = new SQL.Database();
  }
  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS videos (
      video_id TEXT PRIMARY KEY,
      title TEXT,
      url TEXT,
      duration_seconds INTEGER,
      language TEXT,
      source_file TEXT,
      raw_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      transcript_txt_path TEXT,
      transcript_srt_path TEXT,
      audio_path TEXT,
      filename_base TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  try {
    sqlDb.run(`ALTER TABLE videos ADD COLUMN filename_base TEXT`);
  } catch (e) {
    // column already exists on a DB created before this field was added
  }
  persist();
  return sqlDb;
}

function runQuery(sql, params = {}) {
  const stmt = sqlDb.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function runExec(sql, params = {}) {
  const stmt = sqlDb.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
}

/** Import every *.jsonl file found in dataDir into the videos table (insert-or-ignore by video_id). */
function importJsonlDir(db, dataDir) {
  if (!fs.existsSync(dataDir)) return { files: 0, inserted: 0 };

  let files = 0;
  let inserted = 0;
  const entries = fs.readdirSync(dataDir).filter((f) => f.endsWith('.jsonl'));
  for (const file of entries) {
    files += 1;
    const fullPath = path.join(dataDir, file);
    const lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch (e) {
        continue;
      }
      if (!obj.video_id) continue;
      const before = runQuery('SELECT 1 FROM videos WHERE video_id = @video_id', { '@video_id': obj.video_id });
      if (before.length > 0) continue;
      runExec(
        `INSERT INTO videos (video_id, title, url, duration_seconds, language, source_file, raw_json)
         VALUES (@video_id, @title, @url, @duration_seconds, @language, @source_file, @raw_json)`,
        {
          '@video_id': obj.video_id,
          '@title': obj.title || null,
          '@url': obj.url || `https://www.youtube.com/watch?v=${obj.video_id}`,
          '@duration_seconds': obj.duration_seconds || null,
          '@language': obj.language || null,
          '@source_file': file,
          '@raw_json': trimmed,
        },
      );
      inserted += 1;
    }
  }
  if (inserted > 0) persist();
  return { files, inserted };
}

/** Crash recovery: anything left mid-flight from a previous run goes back to pending. */
function resetInFlight(db) {
  runExec(`UPDATE videos SET status = 'pending' WHERE status IN ('downloading', 'transcribing')`);
  persist();
}

function listAll(db) {
  return runQuery(
    `SELECT video_id, title, url, status, error, filename_base, transcript_txt_path FROM videos
     WHERE status != 'excluded' ORDER BY rowid ASC`,
  );
}

function getCounts(db) {
  const rows = runQuery(`SELECT status, COUNT(*) as n FROM videos WHERE status != 'excluded' GROUP BY status`);
  const counts = { pending: 0, downloading: 0, transcribing: 0, done: 0, failed: 0, total: 0 };
  for (const r of rows) {
    counts[r.status] = r.n;
    counts.total += r.n;
  }
  return counts;
}

function nextPending(db) {
  const rows = runQuery(`SELECT * FROM videos WHERE status = 'pending' ORDER BY rowid ASC LIMIT 1`);
  return rows[0];
}

/** Same as nextPending but restricted to a specific set of video_ids (used by "retry failed only"). */
function nextPendingAmong(db, videoIds) {
  if (!videoIds || videoIds.length === 0) return undefined;
  const placeholders = videoIds.map((_, i) => `@id${i}`).join(', ');
  const params = {};
  videoIds.forEach((id, i) => {
    params[`@id${i}`] = id;
  });
  const rows = runQuery(
    `SELECT * FROM videos WHERE status = 'pending' AND video_id IN (${placeholders}) ORDER BY rowid ASC LIMIT 1`,
    params,
  );
  return rows[0];
}

function getFailed(db) {
  return runQuery(
    `SELECT video_id, title, url, error, attempts, updated_at FROM videos WHERE status = 'failed' ORDER BY updated_at DESC`,
  );
}

/** Resets specific failed videos back to pending so the queue will process them again. */
function resetToPending(db, videoIds) {
  if (!videoIds || videoIds.length === 0) return;
  for (const id of videoIds) {
    runExec(
      `UPDATE videos SET status = 'pending', error = NULL, updated_at = datetime('now') WHERE video_id = @video_id`,
      { '@video_id': id },
    );
  }
  persist();
}

function setStatus(db, videoId, status, extra = {}) {
  const setParts = ['status = @status', "updated_at = datetime('now')"];
  const params = { '@video_id': videoId, '@status': status };
  for (const [k, v] of Object.entries(extra)) {
    setParts.push(`${k} = @${k}`);
    params[`@${k}`] = v === undefined ? null : v;
  }
  runExec(`UPDATE videos SET ${setParts.join(', ')} WHERE video_id = @video_id`, params);
  persist();
}

/** One-time migration: videos already `done` before filename_base existed get their transcript
 * files renamed from <video_id>.* to a title-based name, matching newly-processed videos. */
function migrateDoneFilenames(db, transcriptsDir) {
  const { sanitizeFilename, uniqueBaseName } = require('./naming');
  const rows = runQuery(
    `SELECT video_id, title, transcript_txt_path, transcript_srt_path FROM videos
     WHERE status = 'done' AND (filename_base IS NULL OR filename_base = '')`,
  );
  let migrated = 0;
  for (const row of rows) {
    const base = sanitizeFilename(row.title, row.video_id);
    const finalBase = uniqueBaseName(transcriptsDir, base);
    const newTxt = path.join(transcriptsDir, `${finalBase}.txt`);
    const newSrt = path.join(transcriptsDir, `${finalBase}.srt`);
    const txtExists = row.transcript_txt_path && fs.existsSync(row.transcript_txt_path);
    if (!txtExists) continue; // nothing on disk to rename — leave this row for manual attention
    try {
      fs.renameSync(row.transcript_txt_path, newTxt);
      if (row.transcript_srt_path && fs.existsSync(row.transcript_srt_path)) fs.renameSync(row.transcript_srt_path, newSrt);
    } catch (e) {
      continue;
    }
    runExec(
      `UPDATE videos SET filename_base = @fb, transcript_txt_path = @txt, transcript_srt_path = @srt WHERE video_id = @id`,
      { '@fb': finalBase, '@txt': newTxt, '@srt': newSrt, '@id': row.video_id },
    );
    migrated += 1;
  }
  if (migrated > 0) persist();
  return migrated;
}

/** Soft-deletes rows from the visible queue (status='excluded') rather than a hard DELETE, so a
 * later re-import of the same source .jsonl (insert-OR-IGNORE by video_id) doesn't resurrect
 * them — the row still exists, just permanently hidden/skipped. Files already on disk are kept. */
function deleteVideos(db, videoIds) {
  if (!videoIds || videoIds.length === 0) return 0;
  for (const id of videoIds) {
    runExec(
      `UPDATE videos SET status = 'excluded', updated_at = datetime('now') WHERE video_id = @video_id`,
      { '@video_id': id },
    );
  }
  persist();
  return videoIds.length;
}

function incrementAttempts(db, videoId) {
  runExec(`UPDATE videos SET attempts = attempts + 1, updated_at = datetime('now') WHERE video_id = @video_id`, {
    '@video_id': videoId,
  });
  persist();
}

module.exports = {
  DB_PATH,
  openDb,
  importJsonlDir,
  resetInFlight,
  getCounts,
  listAll,
  nextPending,
  nextPendingAmong,
  getFailed,
  resetToPending,
  migrateDoneFilenames,
  deleteVideos,
  setStatus,
  incrementAttempts,
};
