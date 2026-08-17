'use strict';

/**
 * Turning a rule set (lib/sort-rules.js) into an actual plan over real
 * files, applying it, and taking the whole thing back as one action if it
 * was wrong.
 *
 * Three steps, deliberately separate: plan() only reads — the index and,
 * where a rule needs it, the geocoder — so a person can see exactly which
 * files would move where before anything does. apply() is the only thing
 * that touches disk, and only ever moves files a prior plan identified.
 * undoLastBatch() is what makes automated sorting safe to trust: every
 * batch is recorded, and taking it back is one call, not a search through
 * what changed.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const sortRules = require('./sort-rules');
const geocodeLib = require('./geocode');
const hashLib = require('./hash');
const P = require('./paths');

class SortEngineError extends Error {}

const BATCHES_FILE = path.join('.lanshare', 'sort-batches.json');
const MAX_BATCHES_KEPT = 20;

function batchesPath(library) {
  return path.join(library, BATCHES_FILE);
}

function loadBatches(library) {
  try {
    const parsed = JSON.parse(fs.readFileSync(batchesPath(library), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveBatches(library, batches) {
  const file = batchesPath(library);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(batches, null, 1));
  fs.renameSync(tmp, file);
}

/**
 * A library-relative path as a real one on disk.
 *
 * The containment check is deliberate belt-and-braces. lib/sort-rules.js
 * already refuses to parse a destination that could climb out, so nothing
 * reaching here should ever fail this — but `moves` can also be a
 * person-edited subset handed straight to apply(), and this function is the
 * single point every read and write in this module goes through, which
 * makes it the one place a containment mistake anywhere upstream still
 * cannot turn into a file written outside the library.
 *
 * path.join collapses ".." *before* anything touches disk, so this compares
 * the already-collapsed result rather than scanning the input for segments
 * it might have missed.
 */
function absFromRel(library, relPath) {
  const abs = path.join(library, ...relPath.split('/').filter(Boolean));
  if (!P.isInside(library, abs)) {
    throw new SortEngineError(`"${relPath}" is outside the library — refusing to touch it`);
  }
  return abs;
}

/**
 * Same-volume rename where possible; a verified copy-then-delete when not
 * (EXDEV — the destination is a relocated album on another drive, Phase C).
 * The original is only ever removed after the copy is re-hashed and found
 * to match exactly, so a failure at any point leaves the original in
 * place, never gone.
 */
async function moveFile(fromAbs, toAbs) {
  try {
    await fsp.rename(fromAbs, toAbs);
    return;
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
  }
  const originalHash = await hashLib.hashFile(fromAbs);
  const tmp = `${toAbs}.lanshare-part`;
  await fsp.copyFile(fromAbs, tmp);
  const copiedHash = await hashLib.hashFile(tmp);
  if (copiedHash !== originalHash) {
    await fsp.unlink(tmp).catch(() => {});
    throw new SortEngineError('The copy did not match the original — nothing was removed from its original location');
  }
  await fsp.rename(tmp, toAbs);
  await fsp.unlink(fromAbs);
}

async function resolvedGeocoder(library, parsedRules) {
  const places = sortRules.placesReferencedBy(parsedRules);
  if (!places.length) return () => null;
  const resolved = await geocodeLib.resolveMany(places, { library });
  return (name) => resolved.get(name) ?? null;
}

/**
 * Where every entry would go under the current rules — read-only, moves
 * nothing. `entries` is the shape lib/index-db.js's dbRowToResult()
 * produces (path, name, kind, cameraMake, cameraModel, capturedAt, gpsLat,
 * gpsLon, ...) — the same shape /api/search already returns.
 *
 * A file already sitting exactly where its own matching rule would put it
 * is left out of `moves` entirely, not listed as a move to nowhere — this
 * is also what makes applying the same rules twice in a row a no-op the
 * second time.
 */
async function plan({ library, entries, rulesText = null }) {
  const parsedRules = sortRules.parse(rulesText ?? sortRules.readRulesText(library));
  const geocodePlace = await resolvedGeocoder(library, parsedRules);

  const moves = [];
  const unmatched = [];
  for (const entry of entries) {
    const destinationAlbum = sortRules.destinationFor(parsedRules, entry, geocodePlace);
    if (!destinationAlbum) {
      unmatched.push(entry.path);
      continue;
    }
    const currentAlbum = path.posix.dirname(entry.path);
    if (currentAlbum === destinationAlbum) continue;
    moves.push({ path: entry.path, name: entry.name, destinationAlbum });
  }
  return { moves, unmatched, ruleCount: parsedRules.length };
}

/**
 * Actually move the files a prior plan() (or a person-edited subset of its
 * `moves`) identified. Recorded as one batch — even a batch where every
 * move failed is worth keeping a record of, for the same reason a failed
 * sync run still logs what it tried.
 */
async function apply({ library, moves, onProgress }) {
  const moved = [];
  const failed = [];

  for (const move of moves) {
    try {
      const fromAbs = absFromRel(library, move.path);
      const destDirAbs = absFromRel(library, move.destinationAlbum);
      // eslint-disable-next-line no-await-in-loop
      await fsp.mkdir(destDirAbs, { recursive: true });
      const uniqueName = P.uniqueName(fs, destDirAbs, move.name);
      const toAbs = path.join(destDirAbs, uniqueName);

      // eslint-disable-next-line no-await-in-loop
      await moveFile(fromAbs, toAbs);
      moved.push({ from: move.path, to: path.posix.join(move.destinationAlbum, uniqueName) });
    } catch (err) {
      failed.push({ path: move.path, error: err.message });
    }
    onProgress?.({ done: moved.length + failed.length, total: moves.length });
  }

  const batch = { id: crypto.randomBytes(8).toString('hex'), at: new Date().toISOString(), moved, failed };
  if (moved.length) {
    const batches = loadBatches(library);
    batches.unshift(batch);
    saveBatches(library, batches.slice(0, MAX_BATCHES_KEPT));
  }
  return batch;
}

/**
 * Undo the most recent batch, moving every file it moved back to exactly
 * where it came from. Safe to call again on a batch that partly failed to
 * undo — only what is left un-restored stays recorded, so a retry only
 * retries those, never re-attempts a file already back in place.
 */
async function undoLastBatch({ library }) {
  const batches = loadBatches(library);
  const batch = batches[0];
  if (!batch) throw new SortEngineError('There is nothing to undo');

  const restored = [];
  const stillFailed = [];
  for (const move of batch.moved) {
    try {
      const fromAbs = absFromRel(library, move.to);
      const toAbs = absFromRel(library, move.from);
      if (fs.existsSync(toAbs)) {
        throw new SortEngineError('Something is already at the original location — not overwriting it');
      }
      // eslint-disable-next-line no-await-in-loop
      await fsp.mkdir(path.dirname(toAbs), { recursive: true });
      // eslint-disable-next-line no-await-in-loop
      await moveFile(fromAbs, toAbs);
      restored.push(move.from);
    } catch (err) {
      stillFailed.push({ ...move, error: err.message });
    }
  }

  if (stillFailed.length) batches[0] = { ...batch, moved: stillFailed };
  else batches.shift();
  saveBatches(library, batches);

  return { restored, failed: stillFailed };
}

module.exports = {
  SortEngineError, plan, apply, undoLastBatch, loadBatches, batchesPath,
};
