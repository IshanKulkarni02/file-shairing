'use strict';

/**
 * Carrying out a sync plan.
 *
 * lib/sync-plan.js decides what should happen; this module does it. The split
 * matters: everything risky about two-way sync lives in the decision, which is
 * pure and exhaustively tested, so this half only has to be careful about the
 * filesystem.
 *
 * The rules it works to, all of which exist because the alternative loses
 * photos:
 *
 *   - **Nothing is ever hard-deleted.** A deletion moves the file into a
 *     `.lanshare-sync-trash` folder on the side being changed, stamped with
 *     the run. Getting a deletion wrong then costs a folder move, not a photo.
 *   - **Copies are atomic.** Written to a temporary name beside the
 *     destination and renamed into place, so a drive pulled mid-copy leaves
 *     either the old file or the new one, never half of one.
 *   - **Timestamps are preserved.** sync-plan's baseline is built by
 *     re-listing both sides afterwards, so a copy that loses its mtime would
 *     make the next run treat the whole library as changed on both sides.
 *   - **Encrypted files are moved as bytes.** A vault file is copied exactly
 *     as it sits on disk. Never decrypting to copy is the entire reason an
 *     encrypted album stays safe on a drive you lose or a cloud you do not
 *     control.
 *   - **A disappearing drive stops the run, it does not corrupt it.** Every
 *     action is independent, and the baseline is only written from what is
 *     actually on disk at the end.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const plan = require('./sync-plan.js');

/** Where deletions go, on whichever side is being changed. */
const TRASH_DIR = '.lanshare-sync-trash';

/** Bookkeeping that lives with the library, not on the removable drive. */
const STATE_DIR = '.lanshare-sync';

/**
 * Names never carried across. `.lanshare` holds server state and thumbnail
 * caches that are specific to one machine; copying them would overwrite one
 * machine's sessions with another's. The sync trash and state are ours.
 */
const EXCLUDED = new Set(['.lanshare', STATE_DIR, TRASH_DIR, '.DS_Store', 'Thumbs.db']);

class SyncError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
  }
}

/**
 * List one side of a sync: relative posix path -> { size, mtimeMs }.
 *
 * Symlinks and junctions are skipped rather than followed. A relocated album
 * (Phase C) inside a synced folder points at another drive, and following it
 * would copy that drive's contents into this target behind the user's back —
 * and could loop if it points at an ancestor.
 */
async function listSide(root, { onProgress } = {}) {
  const out = new Map();
  if (!fs.existsSync(root)) return out;

  let count = 0;
  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }

    for (const entry of entries) {
      if (EXCLUDED.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;

      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        let stat;
        try {
          stat = await fsp.stat(full);
        } catch {
          // Vanished between readdir and stat. Nothing to sync.
          continue;
        }
        out.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs });
        if (onProgress && ++count % 500 === 0) onProgress({ scanned: count });
      }
    }
  }

  await walk(root, '');
  return out;
}

const baselinePath = (library, targetId) =>
  path.join(library, STATE_DIR, `${targetId}.json`);

/** The baseline from the last successful run, or null if there has not been one. */
async function readBaseline(library, targetId) {
  try {
    const raw = await fsp.readFile(baselinePath(library, targetId), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.files) return null;
    return new Map(Object.entries(parsed.files));
  } catch {
    // A missing or unreadable baseline is not an error — it means the next
    // run is a first run, which is the safe interpretation because a first
    // run never deletes anything.
    return null;
  }
}

async function writeBaseline(library, targetId, baseline) {
  const dir = path.join(library, STATE_DIR);
  await fsp.mkdir(dir, { recursive: true });
  const body = JSON.stringify({
    version: 1,
    recordedAt: new Date().toISOString(),
    files: Object.fromEntries(baseline),
  });
  // Written beside and renamed, so an interrupted write cannot leave a
  // truncated baseline — which would read as "these files were deleted".
  const tmp = `${baselinePath(library, targetId)}.tmp`;
  await fsp.writeFile(tmp, body);
  await fsp.rename(tmp, baselinePath(library, targetId));
}

/** Copy one file atomically, preserving its modification time. */
async function copyFile(fromRoot, toRoot, rel) {
  const from = path.join(fromRoot, ...rel.split('/'));
  const to = path.join(toRoot, ...rel.split('/'));

  await fsp.mkdir(path.dirname(to), { recursive: true });

  const stat = await fsp.stat(from);
  const tmp = `${to}.lanshare-part`;
  try {
    await fsp.copyFile(from, tmp);

    // Cheap integrity check. Not a hash — hashing a photo library on both
    // sides of a USB link would turn a routine sync into an hours-long one —
    // but it catches a copy that ran out of space or was cut short.
    const written = await fsp.stat(tmp);
    if (written.size !== stat.size) {
      throw new SyncError(`Copy of ${rel} came out the wrong size — the drive may be full`);
    }

    await fsp.utimes(tmp, stat.atime, stat.mtime);
    await fsp.rename(tmp, to);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return stat.size;
}

/**
 * Move a file into the trash on its own side.
 *
 * The original folder structure is kept inside the stamped trash folder, so
 * what was deleted — and from where — is still legible weeks later.
 */
async function trashFile(root, rel, stamp) {
  const from = path.join(root, ...rel.split('/'));
  const to = path.join(root, TRASH_DIR, stamp, ...rel.split('/'));
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.rename(from, to);
  } catch (err) {
    // Crossing a device boundary (rare here, but possible with mount points)
    // rename refuses; copy and remove instead.
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(from, to);
    await fsp.rm(from, { force: true });
  }
}

/** Remove folders left empty by the run, so a mirror does not accumulate them. */
async function pruneEmptyDirs(root) {
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }

    let remaining = 0;
    for (const entry of entries) {
      if (EXCLUDED.has(entry.name)) { remaining++; continue; }
      if (entry.isSymbolicLink()) { remaining++; continue; }
      if (entry.isDirectory()) {
        const emptied = await walk(path.join(dir, entry.name));
        if (!emptied) remaining++;
      } else {
        remaining++;
      }
    }

    if (remaining === 0 && dir !== root) {
      await fsp.rmdir(dir).catch(() => {});
      return true;
    }
    return false;
  }
  await walk(root);
}

function stampFor(when = new Date()) {
  return when.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * Work out what a sync would do, without doing any of it.
 *
 * This is what the dry run shows, and it is the same call the real run makes,
 * so a preview cannot drift from what actually happens.
 */
async function preview({ library, sourceDir, targetDir, driveRoot, targetId, policy, conflictLabel, now = new Date() }) {
  if (!sourceDir || !targetDir) throw new SyncError('A sync needs both a source and a target folder');
  if (!targetId) throw new SyncError('A sync needs a target id to track its baseline');

  // Presence is judged on the drive, not on this sync's own folder within it.
  // A drive that is plugged in but has never been synced to has no such folder
  // yet, and calling that "not connected" would make the first preview fail.
  if (!fs.existsSync(driveRoot || targetDir)) {
    throw new SyncError('That drive is not connected', 409);
  }

  const [source, target] = await Promise.all([listSide(sourceDir), listSide(targetDir)]);
  const baseline = await readBaseline(library, targetId);

  return {
    ...plan.buildPlan({ source, target, baseline, policy, conflictLabel, now }),
    counts: { source: source.size, target: target.size },
  };
}

/**
 * Run a sync.
 *
 * Returns a report of everything attempted, including anything that failed —
 * a partial run is normal when a drive is unplugged, and the caller needs to
 * be able to say so rather than claim success.
 */
async function run({
  library,
  sourceDir,
  targetDir,
  driveRoot,
  targetId,
  policy = 'keep-both',
  conflictLabel = 'the other drive',
  dryRun = false,
  onProgress = null,
  now = new Date(),
}) {
  const started = Date.now();
  const result = await preview({
    library, sourceDir, targetDir, driveRoot, targetId, policy, conflictLabel, now,
  });

  const report = {
    dryRun,
    firstRun: result.firstRun,
    planned: result.summary,
    skipped: result.skipped,
    applied: [],
    failed: [],
    bytesCopied: 0,
    startedAt: new Date(started).toISOString(),
    finishedAt: null,
    stoppedEarly: false,
  };

  if (dryRun) {
    report.actions = result.actions;
    report.finishedAt = new Date().toISOString();
    return report;
  }

  const stamp = stampFor(now);
  let done = 0;

  // Judged on the drive, not on this sync's own folder within it. Watching the
  // folder meant a first sync to one that did not exist yet aborted on its
  // very first action, blaming a disconnection that had not happened.
  const liveness = driveRoot || targetDir;

  for (const action of result.actions) {
    // A drive pulled mid-run turns every remaining action into a confusing
    // individual failure. Notice once and stop.
    if (!fs.existsSync(liveness)) {
      report.stoppedEarly = true;
      report.failed.push({ path: action.path, error: 'The drive was disconnected during the sync' });
      break;
    }

    try {
      if (action.type === 'copy') {
        const [from, to] = action.direction === 'to-target'
          ? [sourceDir, targetDir]
          : [targetDir, sourceDir];
        report.bytesCopied += await copyFile(from, to, action.path);
      } else if (action.type === 'delete') {
        await trashFile(action.side === 'target' ? targetDir : sourceDir, action.path, stamp);
      } else if (action.type === 'conflict-keep-both') {
        // Set the target's version aside under the conflicted name, give the
        // source's version the canonical path on both sides, and make sure
        // both sides end up holding both copies.
        //
        // Ordered so no step can leave a version existing nowhere: the losing
        // copy is renamed (never deleted) before anything is overwritten, and
        // it is on both sides before the winner is written over its old path.
        await renameWithin(targetDir, action.path, action.keepAs);
        report.bytesCopied += await copyFile(targetDir, sourceDir, action.keepAs);
        report.bytesCopied += await copyFile(sourceDir, targetDir, action.path);
      }
      report.applied.push(action);
    } catch (err) {
      report.failed.push({ path: action.path, error: err.message });
    }

    // Fired per action rather than batched: the caller knows better than this
    // module how often it wants to hear, and a per-action hook is what makes
    // mid-run interruption testable.
    if (onProgress) {
      await onProgress({
        done: ++done,
        total: result.actions.length,
        bytesCopied: report.bytesCopied,
        path: action.path,
      });
    }
  }

  // Emptied folders are tidied on both sides, but only if the run got far
  // enough to be trusted about what is empty.
  if (!report.stoppedEarly) {
    await pruneEmptyDirs(targetDir).catch(() => {});
    await pruneEmptyDirs(sourceDir).catch(() => {});
  }

  // The new baseline comes from what is genuinely on disk now, never from
  // what the plan intended. Anything that failed simply is not in it, and the
  // next run sees that work as still outstanding.
  if (fs.existsSync(targetDir)) {
    const [sourceAfter, targetAfter] = await Promise.all([listSide(sourceDir), listSide(targetDir)]);
    await writeBaseline(library, targetId, plan.baselineAfter(sourceAfter, targetAfter));
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - started;
  return report;
}

/** Rename a file within one side, making room for the name if needed. */
async function renameWithin(root, fromRel, toRel) {
  const from = path.join(root, ...fromRel.split('/'));
  const to = path.join(root, ...toRel.split('/'));
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
}

module.exports = {
  SyncError,
  TRASH_DIR,
  STATE_DIR,
  EXCLUDED,
  listSide,
  preview,
  run,
  readBaseline,
  writeBaseline,
  // exported for tests
  copyFile,
  trashFile,
  pruneEmptyDirs,
  stampFor,
};
