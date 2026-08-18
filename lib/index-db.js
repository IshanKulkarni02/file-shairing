'use strict';

/**
 * The search index: one SQLite file per library, holding what is known about
 * every file in it — path, size, content hash, and whatever metadata could
 * be read from it.
 *
 * Built on `node:sqlite`, which is bundled with the Node runtime rather than
 * a package that has to be installed. That matters more here than it would
 * elsewhere in this app: sharp already needs `asarUnpack` and a rebuild step
 * to work once packaged, because it is a native module. `node:sqlite` needs
 * neither — it is verified to work identically in a plain `npm start` and
 * inside a packaged Electron app, with no native binary of its own to go
 * missing or mismatch. It is marked experimental upstream; the risk that
 * carries is an API change on a future Node upgrade, not a runtime failure,
 * and this module is the only place that would need to change in response.
 *
 * WAL (write-ahead logging) is turned on because a search has to stay
 * responsive while a rebuild is writing thousands of rows. SQLite's default
 * journal mode can block a reader for the duration of a writer's transaction;
 * WAL lets a reader see the last committed snapshot instead of waiting.
 *
 * The database lives at `library/.lanshare/index.db`. Everything under
 * `.lanshare` is already excluded from sync (see lib/sync.js's `EXCLUDED`),
 * so the index never gets copied to a drive or a paired machine as a side
 * effect of syncing the library it describes.
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS files (
    rel_path     TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    size         INTEGER NOT NULL,
    mtime_ms     REAL NOT NULL,
    hash         TEXT,
    kind         TEXT NOT NULL,
    encrypted    INTEGER NOT NULL DEFAULT 0,
    width        INTEGER,
    height       INTEGER,
    duration     REAL,
    camera_make  TEXT,
    camera_model TEXT,
    captured_at  TEXT,
    captured_at_basis TEXT,
    gps_lat      REAL,
    gps_lon      REAL,
    indexed_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
  CREATE INDEX IF NOT EXISTS idx_files_kind ON files(kind);
  CREATE INDEX IF NOT EXISTS idx_files_camera_make ON files(camera_make);
  CREATE INDEX IF NOT EXISTS idx_files_captured_at ON files(captured_at);
  CREATE INDEX IF NOT EXISTS idx_files_gps ON files(gps_lat, gps_lon);

  -- A standalone FTS5 table rather than an "external content" one keyed on
  -- rowid: rel_path is already this app's natural identity for a file, and
  -- keeping the FTS index's own copy of (name, rel_path) means every write
  -- is a plain delete-then-insert with no rowid bookkeeping to get wrong.
  CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(name, rel_path);

  -- Content-search embeddings (Phase N), keyed by content hash rather than
  -- path — the same "one entry per hash" identity lib/federation.js's
  -- merge-by-hash and lib/import.js's dedup both already use, so two copies
  -- of the same photo in different albums are embedded, and pay CLIP's
  -- per-image compute cost, exactly once. The model column is part of the
  -- key because an embedding is only ever comparable to another one from the
  -- same model — switching lib/clip.js's MODEL_ID would otherwise let stale
  -- vectors silently mix with new ones and rank against them as if they
  -- shared a vector space, which they never do.
  CREATE TABLE IF NOT EXISTS content_embeddings (
    hash        TEXT NOT NULL,
    model       TEXT NOT NULL,
    embedding   BLOB NOT NULL,
    computed_at TEXT NOT NULL,
    PRIMARY KEY (hash, model)
  );
`;

class IndexDb {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = OFF');
    this.db.exec(SCHEMA);
    this._migrateColumns();

    this._upsertFile = this.db.prepare(`
      INSERT INTO files (
        rel_path, name, size, mtime_ms, hash, kind, encrypted,
        width, height, duration, camera_make, camera_model,
        captured_at, captured_at_basis, gps_lat, gps_lon, indexed_at
      ) VALUES (
        :relPath, :name, :size, :mtimeMs, :hash, :kind, :encrypted,
        :width, :height, :duration, :cameraMake, :cameraModel,
        :capturedAt, :capturedAtBasis, :gpsLat, :gpsLon, :indexedAt
      )
      ON CONFLICT(rel_path) DO UPDATE SET
        name = excluded.name, size = excluded.size, mtime_ms = excluded.mtime_ms,
        hash = excluded.hash, kind = excluded.kind, encrypted = excluded.encrypted,
        width = excluded.width, height = excluded.height, duration = excluded.duration,
        camera_make = excluded.camera_make, camera_model = excluded.camera_model,
        captured_at = excluded.captured_at, captured_at_basis = excluded.captured_at_basis,
        gps_lat = excluded.gps_lat, gps_lon = excluded.gps_lon,
        indexed_at = excluded.indexed_at
    `);
    this._deleteFile = this.db.prepare('DELETE FROM files WHERE rel_path = ?');
    this._deleteFts = this.db.prepare('DELETE FROM files_fts WHERE rel_path = ?');
    this._insertFts = this.db.prepare('INSERT INTO files_fts (name, rel_path) VALUES (?, ?)');
    this._getByPath = this.db.prepare('SELECT * FROM files WHERE rel_path = ?');
    this._getByHash = this.db.prepare('SELECT * FROM files WHERE hash = ? ORDER BY rel_path');
    this._allPaths = this.db.prepare('SELECT rel_path, size, mtime_ms FROM files');
    this._countAll = this.db.prepare('SELECT COUNT(*) AS n FROM files');

    this._upsertEmbedding = this.db.prepare(`
      INSERT INTO content_embeddings (hash, model, embedding, computed_at)
      VALUES (:hash, :model, :embedding, :computedAt)
      ON CONFLICT(hash, model) DO UPDATE SET
        embedding = excluded.embedding, computed_at = excluded.computed_at
    `);
    this._getEmbedding = this.db.prepare(
      'SELECT embedding FROM content_embeddings WHERE hash = ? AND model = ?',
    );
    this._allEmbeddings = this.db.prepare(
      'SELECT hash, embedding FROM content_embeddings WHERE model = ?',
    );
    this._countEmbedded = this.db.prepare(
      'SELECT COUNT(*) AS n FROM content_embeddings WHERE model = ?',
    );
    // Non-encrypted only: an embedding is computed from a decoded thumbnail,
    // and lib/indexer.js never opens a vault file to begin with — content
    // search stays exactly as blind to vault contents as the metadata
    // indexer already is, for the same reason (see lib/indexer.js's own
    // header comment).
    this._countEmbeddable = this.db.prepare(
      'SELECT COUNT(DISTINCT hash) AS n FROM files WHERE hash IS NOT NULL AND encrypted = 0',
    );
    this._hashesNeedingEmbedding = this.db.prepare(`
      SELECT MIN(rel_path) AS rel_path, hash
      FROM files
      WHERE hash IS NOT NULL AND encrypted = 0
        AND hash NOT IN (SELECT hash FROM content_embeddings WHERE model = :model)
      GROUP BY hash
      LIMIT :limit
    `);
  }

  /**
   * `CREATE TABLE IF NOT EXISTS` only creates a table that doesn't exist yet
   * — it does nothing for a column added to this schema after an install
   * already has a `files` table on disk. Without this, upgrading over an
   * existing index.db would fail every insert with "no such column" instead
   * of gaining the new field, the first time this ships a column addition.
   */
  _migrateColumns() {
    const existing = new Set(this.db.prepare('PRAGMA table_info(files)').all().map((c) => c.name));
    if (!existing.has('captured_at_basis')) {
      this.db.exec('ALTER TABLE files ADD COLUMN captured_at_basis TEXT');
    }
  }

  /** Insert or replace everything known about one file, keyed by its path. */
  upsert(entry) {
    const row = {
      relPath: entry.relPath,
      name: path.posix.basename(entry.relPath),
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      hash: entry.hash ?? null,
      kind: entry.kind,
      encrypted: entry.encrypted ? 1 : 0,
      width: entry.width ?? null,
      height: entry.height ?? null,
      duration: entry.duration ?? null,
      cameraMake: entry.cameraMake ?? null,
      cameraModel: entry.cameraModel ?? null,
      capturedAt: entry.capturedAt ?? null,
      capturedAtBasis: entry.capturedAtBasis ?? null,
      gpsLat: entry.gpsLat ?? null,
      gpsLon: entry.gpsLon ?? null,
      indexedAt: new Date().toISOString(),
    };
    this._upsertFile.run(row);
    // FTS5 has no native upsert; a plain delete-then-insert is simple, cheap
    // at library scale, and cannot drift from the main table the way a
    // trigger-based sync could if a schema changed on one side and not
    // the other.
    this._deleteFts.run(entry.relPath);
    this._insertFts.run(row.name, entry.relPath);
    return row;
  }

  remove(relPath) {
    this._deleteFile.run(relPath);
    this._deleteFts.run(relPath);
  }

  getByPath(relPath) {
    return this._getByPath.get(relPath) || null;
  }

  /** Every file sharing a content hash — how a duplicate or a replica is found. */
  getByHash(hash) {
    if (!hash) return [];
    return this._getByHash.all(hash);
  }

  /** Every indexed path with just enough to decide "unchanged, skip re-reading it". */
  allEntries() {
    return this._allPaths.all();
  }

  count() {
    return this._countAll.get().n;
  }

  /**
   * Search. Every filter is optional and they combine with AND — "DJI videos
   * from March" is camera + kind + date range all at once, which is the
   * whole point of extracting structured fields rather than only text.
   *
   * `near`/`radiusKm` are handled in two passes: a cheap SQL bounding box
   * first (a plain range on two indexed columns), then an exact haversine
   * distance in JS on the few rows that pass it. Doing the trigonometry in
   * SQL for every row would cost far more than it saves at library scale.
   */
  search({ text, kind, cameraMake, from, to, near, radiusKm = 5, limit = 500 } = {}) {
    const clauses = [];
    const params = {};

    let base = 'SELECT f.* FROM files f';
    // Computed once and checked for emptiness after cleaning, not before: a
    // query that is nothing but control characters (a stray NUL from a
    // decoded "%00", say) survives `text.trim()` — NUL is not whitespace —
    // but reduces to nothing once ftsQuery() strips it, and FTS5 rejects an
    // empty MATCH string as a syntax error rather than matching nothing.
    const ftsText = text ? ftsQuery(text) : '';
    if (ftsText) {
      base += ' JOIN files_fts ON files_fts.rel_path = f.rel_path';
      clauses.push('files_fts MATCH :text');
      params.text = ftsText;
    }
    if (kind) { clauses.push('f.kind = :kind'); params.kind = kind; }
    if (cameraMake) { clauses.push('f.camera_make = :cameraMake'); params.cameraMake = cameraMake; }
    if (from) { clauses.push('f.captured_at >= :from'); params.from = from; }
    if (to) { clauses.push('f.captured_at <= :to'); params.to = to; }

    let box = null;
    if (near && Number.isFinite(near.lat) && Number.isFinite(near.lon)) {
      box = boundingBox(near.lat, near.lon, radiusKm);
      clauses.push('f.gps_lat BETWEEN :latMin AND :latMax');
      clauses.push('f.gps_lon BETWEEN :lonMin AND :lonMax');
      Object.assign(params, box);
    }

    const sql = `${base}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY f.captured_at DESC, f.rel_path LIMIT :limit`;
    params.limit = limit;

    let rows = this.db.prepare(sql).all(params);

    if (near) {
      rows = rows
        .map((row) => ({ ...row, _distanceKm: haversineKm(near.lat, near.lon, row.gps_lat, row.gps_lon) }))
        .filter((row) => row._distanceKm <= radiusKm)
        .sort((a, b) => a._distanceKm - b._distanceKm);
    }

    return rows;
  }

  /** Store (or replace) one hash's embedding under the given model. */
  upsertEmbedding(hash, model, vector) {
    this._upsertEmbedding.run({
      hash, model, embedding: vectorToBlob(vector), computedAt: new Date().toISOString(),
    });
  }

  getEmbedding(hash, model) {
    const row = this._getEmbedding.get(hash, model);
    return row ? blobToVector(row.embedding) : null;
  }

  /** How many distinct hashes have *something* embeddable — the denominator for progress. */
  countEmbeddable() {
    return this._countEmbeddable.get().n;
  }

  /** How many of those already have an embedding under this model — the numerator. */
  countEmbedded(model) {
    return this._countEmbedded.get(model).n;
  }

  /**
   * Up to `limit` hashes that are embeddable but do not yet have an
   * embedding under `model`, each with one representative path (the file
   * lib/content-index.js should actually read). Naturally incremental: a
   * hash already embedded simply stops appearing, the same "unchanged, skip
   * it" shape lib/indexer.js's own scan already has.
   */
  hashesNeedingEmbedding(model, limit = 200) {
    return this._hashesNeedingEmbedding.all({ model, limit }).map((r) => ({ hash: r.hash, relPath: r.rel_path }));
  }

  /**
   * Rank every embedded hash against a query vector by cosine similarity —
   * a plain dot product, since lib/clip.js only ever hands out unit-length
   * vectors on both sides of the comparison. Brute force over every stored
   * embedding rather than an approximate-nearest-neighbour index: at a
   * personal library's scale (thousands, not millions, of distinct photos)
   * a linear scan comparing 512-float vectors is comfortably sub-second, and
   * an ANN structure would be an extra native dependency and a second index
   * to keep consistent for a problem this size does not actually have.
   *
   * Returns one file row per matching hash — the same "one entry per
   * content hash" identity the rest of this table already uses — carrying
   * a `_score` alongside the usual columns, highest first.
   *
   * `isVisible` decides *which* of a hash's files represents it, and exists
   * because one photo filed in two albums is exactly what dedup-by-hash is
   * for. Picking a row blindly and letting the caller filter afterwards
   * looks equivalent and is not: an account restricted to /Public that also
   * has the same photo sitting in /Private would get the /Private row (it
   * sorts first), have it filtered away, and see no result at all — despite
   * having a perfectly visible copy. Choosing among the hash's files here
   * instead means the account gets its own copy back, and a hash with no
   * visible copy at all correctly yields nothing.
   */
  searchByContent(queryVector, { model, limit = 100, isVisible = null } = {}) {
    const rows = this._allEmbeddings.all(model);
    const ranked = rows
      .map((row) => ({ hash: row.hash, score: dotProduct(queryVector, blobToVector(row.embedding)) }))
      .sort((a, b) => b.score - a.score);

    const out = [];
    for (const { hash, score } of ranked) {
      if (out.length >= limit) break;
      const candidates = this._getByHash.all(hash);
      const fileRow = isVisible ? candidates.find((row) => isVisible(row)) : candidates[0];
      if (fileRow) out.push({ ...fileRow, _score: score });
    }
    return out;
  }

  close() {
    this.db.close();
  }
}

// Written and read byte-by-byte with explicit little-endian Buffer methods
// rather than a reinterpret-cast Float32Array view over the BLOB's backing
// buffer: node:sqlite hands BLOB columns back as a Uint8Array whose byteOffset
// into its underlying ArrayBuffer is not guaranteed 4-byte aligned, and a
// misaligned Float32Array constructor throws. Buffer's readFloatLE/writeFloatLE
// have no such restriction, at the cost of a per-element loop that is
// irrelevant at 512 elements.
function vectorToBlob(vector) {
  const bytes = Buffer.alloc(vector.length * Float32Array.BYTES_PER_ELEMENT);
  for (let i = 0; i < vector.length; i++) bytes.writeFloatLE(vector[i], i * 4);
  return bytes;
}

function blobToVector(blob) {
  const bytes = Buffer.isBuffer(blob) ? blob : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const floats = new Float32Array(bytes.length / Float32Array.BYTES_PER_ELEMENT);
  for (let i = 0; i < floats.length; i++) floats[i] = bytes.readFloatLE(i * 4);
  return floats;
}

function dotProduct(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * FTS5's MATCH treats `-`, `.`, `(` and a handful of other characters as
 * query syntax, not literal text — searching for a file called "IMG-2026"
 * or a query containing one of these means the same characters that appear
 * constantly in real filenames would otherwise throw a syntax error instead
 * of finding anything. Quoting each token makes them literal.
 */
function ftsQuery(text) {
  // Search text ultimately comes from a URL query string, and %00 decodes to
  // a real NUL byte — reachable input, not a theoretical one. SQLite's C
  // string handling treats it as a terminator, so a token that is nothing
  // but NUL bytes becomes an empty quoted string once stripped, which FTS5
  // then rejects as a syntax error rather than searching for nothing.
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\x00-\x1f]/g, ' ');
  const tokens = clean.trim().split(/\s+/).filter(Boolean);
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

/**
 * A generous rectangle around a point, wide enough that no real match falls
 * outside it — the exact-distance filter afterwards trims it to the true
 * circle. Longitude degrees shrink toward the poles, so the box is widened
 * in longitude accordingly; near the poles themselves it can wrap past
 * ±180°, which is a known, harmless overestimate rather than a missed match.
 */
function boundingBox(lat, lon, radiusKm) {
  const latDelta = radiusKm / 111; // ~111 km per degree of latitude, everywhere
  const cos = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const lonDelta = radiusKm / (111 * cos);
  return {
    latMin: lat - latDelta, latMax: lat + latDelta,
    lonMin: lon - lonDelta, lonMax: lon + lonDelta,
  };
}

/**
 * A row from `files` (or from `search()`, which returns the same shape plus
 * `_distanceKm`) in the camelCase form the HTTP API and lib/federation.js
 * both use. Kept here, next to the table it reads, so the local /api/search
 * route and a peer's cached results are built from exactly one mapping
 * rather than two that could quietly drift apart.
 */
function dbRowToResult(row) {
  return {
    path: row.rel_path,
    name: row.name,
    kind: row.kind,
    size: row.size,
    mtime: row.mtime_ms,
    hash: row.hash || null,
    encrypted: Boolean(row.encrypted),
    width: row.width,
    height: row.height,
    duration: row.duration,
    cameraMake: row.camera_make,
    cameraModel: row.camera_model,
    capturedAt: row.captured_at,
    capturedAtBasis: row.captured_at_basis,
    gpsLat: row.gps_lat,
    gpsLon: row.gps_lon,
    ...(row._distanceKm !== undefined ? { distanceKm: row._distanceKm } : {}),
    ...(row._score !== undefined ? { score: row._score } : {}),
  };
}

/** The inverse of dbRowToResult, for writing a peer's API response into a local cache. */
function resultToUpsertEntry(result) {
  return {
    relPath: result.path,
    size: result.size,
    mtimeMs: result.mtime,
    hash: result.hash,
    kind: result.kind,
    encrypted: result.encrypted,
    width: result.width,
    height: result.height,
    duration: result.duration,
    cameraMake: result.cameraMake,
    cameraModel: result.cameraModel,
    capturedAt: result.capturedAt,
    capturedAtBasis: result.capturedAtBasis,
    gpsLat: result.gpsLat,
    gpsLon: result.gpsLon,
  };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

module.exports = {
  IndexDb, haversineKm, boundingBox, ftsQuery, dbRowToResult, resultToUpsertEntry,
};
