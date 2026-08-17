'use strict';

/**
 * Building the content-search embedding index (Phase N) — a slower, optional
 * pass layered on top of lib/indexer.js's fast metadata scan, not folded
 * into it. Where the metadata scan reads EXIF/probe data in milliseconds per
 * file, computing a CLIP embedding costs real CPU time per image, so this
 * runs as its own explicitly-triggered background job, the same way
 * lib/sort-engine.js sits on top of the same index rather than living inside
 * indexer.js.
 *
 * Reuses lib/thumbs.js's existing grid thumbnail — already a decoded,
 * normalized, uniform 480x480 WebP for both images and videos (a poster
 * frame, via ffmpeg) — as CLIP's input, rather than re-implementing image
 * decoding or video-frame extraction a second time.
 *
 * Vault contents are never embedded, for the same reason lib/indexer.js
 * never opens them for metadata: the encrypted bytes on disk are ciphertext
 * to this module, not photo data. lib/index-db.js's hashesNeedingEmbedding()
 * already excludes them at the source, so this module never has to know a
 * vault is even involved.
 */

const fsp = require('fs/promises');
const path = require('path');

const thumbs = require('./thumbs');
const clipLib = require('./clip');

// How many hashes are pulled from the index at a time. Not a tuning knob for
// throughput (embedding one image dominates the cost, not the query) — it
// just bounds how much a single batch's own bookkeeping (the `attempted`
// set below) grows before this loop checks in with the database again.
const BATCH_SIZE = 200;

/**
 * Embed every hash the index knows about but hasn't embedded yet, under
 * lib/clip.js's current model. Naturally incremental and resumable: calling
 * this again later only processes whatever hashesNeedingEmbedding() still
 * returns, the same "unchanged, skip it" shape the metadata scan itself
 * already has.
 *
 * A single file's failure (corrupt thumbnail, unreadable original, no
 * visual preview available) is recorded and skipped rather than aborting
 * the whole batch — mirrors lib/indexer.js's own report.failed handling.
 * Every attempted hash is tracked locally for the life of one call so a
 * hash that keeps failing is tried exactly once per call, not forever: it
 * never gains an embedding, so without this it would never leave
 * hashesNeedingEmbedding()'s result set, and the loop below would spin on
 * it endlessly instead of finishing. A later call (after whatever was wrong
 * with that one file is fixed) retries it fresh — the same "retry is cheap,
 * a cached failure is not" reasoning lib/geocode.js already applies to a
 * failed lookup.
 *
 * @param {string} library
 * @param {import('./index-db.js').IndexDb} db
 * @param {(progress: object) => void} [onProgress]
 * @param {(absPath: string) => Promise<Float32Array>} [embedImageFile] injectable for
 *   tests, so this module's own orchestration can be proven correct in
 *   milliseconds without paying the real model's load-and-inference cost —
 *   that real cost is exactly what test/clip.mjs exists to prove separately.
 * @returns {Promise<{embedded:number, total:number, failed:Array}>}
 */
async function buildContentIndex({
  library, db, onProgress = null, embedImageFile = clipLib.embedImageFile,
} = {}) {
  const total = db.countEmbeddable();
  const report = { embedded: db.countEmbedded(clipLib.MODEL_ID), total, failed: [] };
  const attempted = new Set();

  for (;;) {
    const batch = db.hashesNeedingEmbedding(clipLib.MODEL_ID, BATCH_SIZE)
      .filter((item) => !attempted.has(item.hash));
    if (!batch.length) break;

    for (const { hash, relPath } of batch) {
      attempted.add(hash);
      try {
        const absPath = path.join(library, ...relPath.split('/').filter(Boolean));
        const stat = await fsp.stat(absPath);
        const thumbPath = await thumbs.get(library, absPath, relPath, stat, 'grid');
        if (!thumbPath) throw new Error('no visual preview available for this file');
        const vector = await embedImageFile(thumbPath);
        db.upsertEmbedding(hash, clipLib.MODEL_ID, vector);
        report.embedded++;
      } catch (err) {
        report.failed.push({ path: relPath, hash, error: err.message });
      }
      onProgress?.({ ...report, current: relPath });
    }
  }

  onProgress?.({ ...report, current: null, done: true });
  return report;
}

module.exports = { buildContentIndex, BATCH_SIZE };
