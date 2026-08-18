'use strict';

/**
 * Building the search index by walking the library once and remembering
 * what has already been read.
 *
 * "Incremental" means the same thing here it does in lib/sync.js: a file
 * whose size and modification time match what is already in the index is
 * skipped entirely — no re-hashing, no re-opening it for EXIF — so a repeat
 * scan of a mostly-unchanged library costs almost nothing. The first scan of
 * a real library is the slow one; every scan after that is cheap.
 *
 * Vault contents are indexed shallow, on purpose. A file inside a vault gets
 * its path, size, modification time and kind — enough to find it by name —
 * and nothing else. It is never opened, so no metadata is ever extracted
 * from it; the encrypted bytes on disk are not photo data to this module,
 * they are ciphertext, and treating them otherwise would defeat the vault.
 *
 * A relocated album (Phase C — a directory junction pointing at another
 * drive) is walked into, not skipped. Search would otherwise be silently
 * blind to everything that had ever been moved to another drive, which is
 * most of what Phase C exists for. The distinction that matters: only a
 * *top-level* link is followed, exactly matching what lib/locations.js will
 * ever create — a link found further down the tree is not a relocated album
 * by this app's own rules, and is skipped the same way lib/sync.js skips
 * one, to guard against a loop.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const P = require('./paths.js');
const hashLib = require('./hash.js');
const metadataLib = require('./metadata.js');
const vaults = require('./vaults.js');

/**
 * How far apart two mtimes can be and still count as "did not change".
 *
 * Not exact equality, because `fs.utimes` — which this app's own sync engine
 * calls on every file it copies, specifically to preserve timestamps across
 * a sync — rounds to the millisecond and loses whatever sub-millisecond
 * fraction the original had. A file synced from another machine and then
 * scanned here would otherwise look "changed" by a fraction of a
 * millisecond, forever, and get needlessly re-hashed and re-extracted on
 * every single scan. Same tolerance and the same reasoning lib/sync-plan.js
 * already uses for its own file-identity check.
 */
const MTIME_TOLERANCE_MS = 2000;

/** Same internal names lib/sync.js already excludes — never part of the library's own content. */
const EXCLUDED = new Set([P.INTERNAL_DIR, '.lanshare-sync', '.lanshare-sync-trash', '.DS_Store', 'Thumbs.db']);

/**
 * How much of a file is read to look for EXIF. A JPEG's APP1 segment is
 * capped at 65,535 bytes by the format itself (a 16-bit length field), and
 * it appears near the start of the file — this is generous headroom for
 * whatever else (a large APP0, an ICC profile) might come before it, without
 * reading a 50 MB photo in full just to check its first few kilobytes.
 */
const EXIF_HEAD_BYTES = 256 * 1024;

async function readHead(absPath, maxBytes) {
  const handle = await fsp.open(absPath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** ISO 8601, from EXIF's "YYYY:MM:DD HH:MM:SS" or whatever ffprobe already gives (also ISO-ish). */
function normalizeCaptureTime(raw) {
  if (!raw) return null;
  const exifShape = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (exifShape) {
    const [, y, mo, d, h, mi, s] = exifShape;
    return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Metadata for one file, routed by kind. Never throws — a file this cannot read yields nothing extracted. */
async function extractMetadata(absPath, kind) {
  const empty = {
    width: null, height: null, duration: null,
    cameraMake: null, cameraModel: null, capturedAt: null, capturedAtBasis: null,
    gpsLat: null, gpsLon: null,
  };
  try {
    const ext = path.extname(absPath).toLowerCase();
    if (kind === 'image' && (ext === '.jpg' || ext === '.jpeg')) {
      const head = await readHead(absPath, EXIF_HEAD_BYTES);
      const exif = metadataLib.parseJpegExif(head);
      // GPSDateStamp/GPSTimeStamp are the fix's own UTC clock, independent
      // of the camera's local-time clock — used when present because it is
      // an exact instant, not a guess. DateTimeOriginal alone carries no
      // timezone, so a photo with no GPS fix stays naive-local; mixing the
      // two bases without marking which is which is what silently breaks
      // cross-camera drift detection (see plan.md's Phase O1).
      const useGpsTime = Boolean(exif.gpsDateTimeUTC);
      const capturedAt = normalizeCaptureTime(useGpsTime ? exif.gpsDateTimeUTC : exif.dateTimeOriginal);
      return {
        width: exif.pixelWidth, height: exif.pixelHeight, duration: null,
        cameraMake: exif.make, cameraModel: exif.model,
        capturedAt,
        capturedAtBasis: !capturedAt ? null : (useGpsTime ? 'utc-gps' : 'local-naive'),
        gpsLat: exif.gpsLatitude, gpsLon: exif.gpsLongitude,
      };
    }
    if (kind === 'video') {
      const video = await metadataLib.probeVideoMetadata(absPath);
      const capturedAt = normalizeCaptureTime(video.dateTimeOriginal);
      return {
        width: video.pixelWidth, height: video.pixelHeight, duration: null,
        cameraMake: video.cameraMake, cameraModel: video.cameraModel,
        capturedAt,
        capturedAtBasis: capturedAt ? 'utc' : null,
        gpsLat: video.gpsLatitude, gpsLon: video.gpsLongitude,
      };
    }
    return empty;
  } catch {
    return empty;
  }
}

/**
 * Walk the library and bring the index up to date.
 *
 * @param {string} library    absolute path to the library root
 * @param {import('./index-db.js').IndexDb} db
 * @param {object} [options]
 * @param {(progress: object) => void} [options.onProgress]
 * @returns {Promise<{scanned:number, added:number, updated:number, skipped:number, removed:number, failed:Array}>}
 */
async function scanLibrary(library, db, { onProgress = null } = {}) {
  const report = { scanned: 0, added: 0, updated: 0, skipped: 0, removed: 0, failed: [] };
  const seen = new Set();

  // What the index already believes, so an unchanged file can be recognised
  // without touching it. Keyed by path for O(1) lookup during the walk.
  const known = new Map();
  for (const row of db.allEntries()) known.set(row.rel_path, row);

  async function walk(absDir, relDir, depth) {
    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      report.failed.push({ path: relDir || '/', error: err.message });
      return;
    }

    for (const dirent of entries) {
      if (EXCLUDED.has(dirent.name) || dirent.name.startsWith('.')) continue;

      const abs = path.join(absDir, dirent.name);
      const rel = relDir ? `${relDir}/${dirent.name}` : `/${dirent.name}`;

      if (dirent.isSymbolicLink()) {
        // Only a top-level entry can legitimately be a relocated album —
        // lib/locations.js refuses to create a link anywhere else. A link
        // found deeper is not one this app made, and is skipped rather than
        // followed, exactly as lib/sync.js does, so a link that happens to
        // point at an ancestor cannot turn this walk into a loop.
        if (depth !== 0) continue;
        let stat;
        try {
          stat = await fsp.stat(abs); // follows the link
        } catch (err) {
          report.failed.push({ path: rel, error: `unreachable (its drive may be disconnected): ${err.message}` });
          continue;
        }
        if (stat.isDirectory()) await walk(abs, rel, depth + 1);
        continue;
      }

      if (dirent.isDirectory()) {
        await walk(abs, rel, depth + 1);
        continue;
      }

      if (!dirent.isFile()) continue;

      seen.add(rel);
      report.scanned++;
      if (onProgress && report.scanned % 200 === 0) onProgress({ ...report, current: rel });

      try {
        const stat = await fsp.stat(abs);
        const existing = known.get(rel);
        const unchanged = existing && existing.size === stat.size
          && Math.abs(existing.mtime_ms - stat.mtimeMs) <= MTIME_TOLERANCE_MS;

        if (unchanged) {
          report.skipped++;
          continue;
        }

        const ctx = vaults.contextFor(library, rel);
        const encrypted = Boolean(ctx);
        const kind = P.kindOf(dirent.name);

        const hash = await hashLib.hashFile(abs);
        const meta = encrypted ? null : await extractMetadata(abs, kind);

        db.upsert({
          relPath: rel, size: stat.size, mtimeMs: stat.mtimeMs, hash, kind, encrypted,
          width: meta?.width ?? null, height: meta?.height ?? null, duration: meta?.duration ?? null,
          cameraMake: meta?.cameraMake ?? null, cameraModel: meta?.cameraModel ?? null,
          capturedAt: meta?.capturedAt ?? null, capturedAtBasis: meta?.capturedAtBasis ?? null,
          gpsLat: meta?.gpsLat ?? null, gpsLon: meta?.gpsLon ?? null,
        });

        if (existing) report.updated++;
        else report.added++;
      } catch (err) {
        report.failed.push({ path: rel, error: err.message });
      }
    }
  }

  await walk(library, '', 0);

  // Anything indexed before but not seen this time no longer exists — moved,
  // renamed or deleted by some path other than this scan.
  for (const relPath of known.keys()) {
    if (!seen.has(relPath)) {
      db.remove(relPath);
      report.removed++;
    }
  }

  onProgress?.({ ...report, current: null, done: true });
  return report;
}

module.exports = { scanLibrary, EXCLUDED, EXIF_HEAD_BYTES, normalizeCaptureTime };
