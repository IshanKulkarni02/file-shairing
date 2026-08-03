'use strict';

/**
 * Library location management for the desktop app's Library screen: size and
 * item counts, changing where the library lives, clearing the thumbnail
 * cache, and emptying trash.
 *
 * This is deliberately a single "the library has one location" model. Phase
 * C — storage that spans several drives, tracked by volume id, with sync —
 * is a bigger, separate piece of work; this module intentionally does not
 * try to anticipate it. moveLibrary()'s same-volume/cross-volume rules are
 * written to still make sense once that lands, so it should extend rather
 * than need replacing.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { INTERNAL_DIR } = require('./paths');

class LibraryError extends Error {}

// A very large library (hundreds of thousands of items) could make a naive
// walk take a long time; stop counting past this and report "at least".
const STATS_ENTRY_CAP = 250_000;

async function walk(dir, visit, budget) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return; // A folder that vanished mid-walk is not fatal to the total.
  }
  for (const entry of entries) {
    if (budget.count >= budget.cap) { budget.capped = true; return; }
    if (entry.name === INTERNAL_DIR) continue; // internal bookkeeping, not the user's data
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, visit, budget);
    } else {
      let stat;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }
      budget.count++;
      visit(stat);
    }
    if (budget.capped) return;
  }
}

/** Total size and item count under `dir`. Excludes the internal bookkeeping folder. */
async function getStats(dir) {
  if (!fs.existsSync(dir)) return { bytes: 0, files: 0, capped: false };
  const budget = { count: 0, cap: STATS_ENTRY_CAP, capped: false };
  let bytes = 0;
  await walk(dir, (stat) => { bytes += stat.size; }, budget);
  return { bytes, files: budget.count, capped: budget.capped };
}

/** Size of everything already in trash, so "empty trash" can say how much it frees. */
function trashDir(library) {
  return path.join(library, INTERNAL_DIR, 'trash');
}

function thumbsDir(library) {
  return path.join(library, INTERNAL_DIR, 'thumbs');
}

async function getTrashStats(library) {
  return getStats(trashDir(library));
}

async function getCacheStats(library) {
  return getStats(thumbsDir(library));
}

/** Deletes and recreates a directory; used for both cache and trash. */
async function clearDir(dir) {
  const before = await getStats(dir);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  return before;
}

function clearThumbnailCache(library) {
  return clearDir(thumbsDir(library));
}

function emptyTrash(library) {
  return clearDir(trashDir(library));
}

// ---------------------------------------------------------------------------
// Moving the library
// ---------------------------------------------------------------------------

/**
 * Best-effort "are these two paths on the same volume". On Windows this is a
 * drive-letter or UNC-server comparison; on POSIX it is st_dev. Getting this
 * wrong only costs performance (a same-volume move done the slow way still
 * works correctly) — it is never load-bearing for correctness, so a
 * conservative "assume different volumes" fallback is fine.
 */
function sameVolume(a, b) {
  if (process.platform === 'win32') {
    const rootOf = (p) => {
      const resolved = path.resolve(p);
      const unc = /^\\\\([^\\]+)\\([^\\]+)/.exec(resolved);
      if (unc) return `\\\\${unc[1].toLowerCase()}\\${unc[2].toLowerCase()}`;
      const drive = /^[a-zA-Z]:/.exec(resolved);
      return drive ? drive[0].toLowerCase() : null;
    };
    const ra = rootOf(a);
    const rb = rootOf(b);
    return Boolean(ra) && ra === rb;
  }
  try {
    return fs.statSync(path.dirname(a)).dev === fs.statSync(path.dirname(b)).dev;
  } catch {
    return false;
  }
}

/** True if `child` is inside `parent`, or the same path — used to refuse nesting a move into itself. */
function isNestedOrSame(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function dirExistsAndNonEmpty(dir) {
  if (!fs.existsSync(dir)) return false;
  const entries = await fsp.readdir(dir);
  return entries.length > 0;
}

/** Recursively copy `src` to `dst`, preserving structure. Stops on the first error. */
async function copyTree(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyTree(from, to);
    } else if (entry.isFile()) {
      await fsp.copyFile(from, to);
    }
    // Symlinks and other special entries are skipped deliberately — a photo
    // library should not contain them, and following one could copy well
    // outside the library.
  }
}

/**
 * Cheap integrity check after a cross-volume copy: matching file count and
 * total bytes between source and destination. Not a byte-for-byte hash —
 * hashing a large photo library would turn a routine move into an hours-long
 * operation — but it is enough to catch a copy that was interrupted, ran out
 * of space partway, or silently dropped a file.
 */
async function verifyCopy(src, dst) {
  const [from, to] = await Promise.all([getStats(src), getStats(dst)]);
  return from.bytes === to.bytes && from.files === to.files && !from.capped && !to.capped;
}

/**
 * Move the library to a new location.
 *
 * `mode`:
 *   - "move": relocate the existing files (rename if same volume, otherwise
 *     copy, verify, then delete the source).
 *   - "point": leave existing files where they are and just start using
 *     `newPath` — for pointing at a folder you already populated some other
 *     way (an existing Google Drive folder, for instance).
 *
 * The caller is responsible for making sure the server is stopped first —
 * this function only moves files, it does not know about the server.
 *
 * On any failure the source is left exactly as it was; a partially written
 * destination from a failed cross-volume copy is cleaned up before the
 * error is thrown.
 */
async function moveLibrary(oldPath, newPath, mode = 'move') {
  const from = path.resolve(oldPath);
  const to = path.resolve(newPath);

  if (from === to) throw new LibraryError('That is already the library location.');
  if (isNestedOrSame(from, to)) {
    throw new LibraryError('The new location cannot be inside the current library.');
  }
  if (isNestedOrSame(to, from)) {
    throw new LibraryError('The new location cannot contain the current library.');
  }

  if (mode === 'point') {
    await fsp.mkdir(to, { recursive: true });
    return { moved: false };
  }

  if (!fs.existsSync(from)) {
    // Nothing to move yet (a fresh install that never wrote anything) — just
    // create the new location and switch to it.
    await fsp.mkdir(to, { recursive: true });
    return { moved: false };
  }

  if (await dirExistsAndNonEmpty(to)) {
    throw new LibraryError('The new location already has files in it. Choose an empty folder, or use "point at an existing folder" instead.');
  }

  if (sameVolume(from, to)) {
    await fsp.mkdir(path.dirname(to), { recursive: true });
    try {
      await fsp.rename(from, to);
    } catch (err) {
      // EXDEV means the "same volume" heuristic was wrong (bind mounts,
      // mapped drives that are really remote, etc.) — fall back to the
      // cross-volume path rather than fail outright.
      if (err.code !== 'EXDEV') throw new LibraryError(`Could not move the library: ${err.message}`);
      await copyThenVerifyThenDelete(from, to);
    }
    return { moved: true, mode: 'rename' };
  }

  await copyThenVerifyThenDelete(from, to);
  return { moved: true, mode: 'copy' };
}

async function copyThenVerifyThenDelete(from, to) {
  try {
    await copyTree(from, to);
  } catch (err) {
    await fsp.rm(to, { recursive: true, force: true }).catch(() => {});
    throw new LibraryError(`Copy failed, nothing was changed: ${err.message}`);
  }

  const ok = await verifyCopy(from, to);
  if (!ok) {
    await fsp.rm(to, { recursive: true, force: true }).catch(() => {});
    throw new LibraryError('The copy did not verify (file count or size mismatch). Nothing was changed; the original library is untouched.');
  }

  try {
    await fsp.rm(from, { recursive: true, force: true });
  } catch (err) {
    // The new copy is verified good at this point, so this is a cleanup
    // failure, not a data-loss risk — surface it, but do not undo the move.
    throw new LibraryError(`Moved and verified, but could not clean up the old location: ${err.message}. You can delete ${from} by hand.`);
  }
}

module.exports = {
  LibraryError,
  getStats,
  getTrashStats,
  getCacheStats,
  clearThumbnailCache,
  emptyTrash,
  sameVolume,
  isNestedOrSame,
  moveLibrary,
};
