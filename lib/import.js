'use strict';

/**
 * Copying from a capture device — a camera, drone, phone or SD card — into
 * the library, without ever reading it for any other reason than to copy,
 * and without ever writing to it, renaming anything on it, or deleting
 * anything from it. Formatting the card afterwards is the owner's decision,
 * made once they can see the files actually arrived — nothing here does
 * that for them, on any path, ever.
 *
 * Two steps, deliberately separate: planImport() only reads, so the person
 * can be shown "240 files, 4.2 GB, 3 already have copies" before anything
 * is written; runImport() is the only thing that touches the destination,
 * and only after that plan has been agreed to (or the 30-second countdown
 * the desktop app shows has run out).
 *
 * "Already imported" is answered by asking the library's own search index
 * whether it already has a file with this content hash — exactly what
 * Phase H's duplicate detection was built for. That means it is *current
 * library state*, not a permanent log: a file imported once and later
 * deleted from the library will be re-offered if the same card goes back
 * in. That is a deliberate reading of "remembered by content hash," not an
 * oversight — a permanent history would re-import nothing even after a
 * deliberate delete, which is the more surprising behaviour of the two.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const hashLib = require('./hash');
const volumes = require('./volumes');
const P = require('./paths');

class ImportError extends Error {}

/** The near-universal capture-device signal. Checked case-insensitively — FAT32 cards are not consistent about it. */
const CAPTURE_FOLDER = 'dcim';

/**
 * Does this volume look like a capture device? Returns the DCIM folder's
 * real path (whatever case it is actually spelled on disk) or null.
 */
async function detectCaptureDevice(mountPoint) {
  let entries;
  try {
    entries = await fsp.readdir(mountPoint, { withFileTypes: true });
  } catch {
    return null;
  }
  const dcim = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === CAPTURE_FOLDER);
  return dcim ? path.join(mountPoint, dcim.name) : null;
}

/**
 * Read-only: walk a capture device's DCIM folder and decide what is new.
 *
 * Every file is hashed, including ones about to be reported as already
 * imported — cheaper pre-filters exist (comparing size first, say) but none
 * are exact, and a false-positive skip here means a photo silently never
 * gets copied. Re-inserting a mostly-unchanged card really does re-hash all
 * of it; that cost is accepted deliberately rather than risked around.
 */
async function planImport({ mountPoint, indexDb }) {
  const dcimPath = await detectCaptureDevice(mountPoint);
  if (!dcimPath) return null;

  const seen = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable subfolder is skipped, not fatal to the whole card
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(abs); continue; }
      if (entry.isFile()) seen.push(abs);
    }
  }
  await walk(dcimPath);

  const candidates = [];
  let totalBytes = 0;
  let alreadyImported = 0;

  for (const abs of seen) {
    let hash;
    let stat;
    try {
      // eslint-disable-next-line no-await-in-loop
      [hash, stat] = await Promise.all([hashLib.hashFile(abs), fsp.stat(abs)]);
    } catch {
      continue; // unreadable file — skipped, same as an unreadable folder
    }
    if (indexDb.getByHash(hash).length > 0) {
      alreadyImported++;
      continue;
    }
    candidates.push({ source: abs, name: path.basename(abs), size: stat.size, hash });
    totalBytes += stat.size;
  }

  return {
    dcimPath, candidates, totalBytes, alreadyImported, totalSeen: seen.length,
  };
}

/**
 * Write: copy exactly the files a prior planImport() identified as new.
 *
 * Free space on the destination volume is checked once, up front, against
 * the plan's total — failing before the first byte is written rather than
 * partway through leaves nothing half-copied to clean up. Each file is
 * written beside its real name and renamed into place only after the copy
 * is re-hashed and found to match exactly what was planned — a card or a
 * cable that corrupts a read is failed loudly, not backed up silently
 * wrong.
 */
async function runImport({ plan, destDir, onProgress, getFreeBytes = (dir) => volumes.identify(dir)?.freeBytes }) {
  if (!plan || !plan.candidates.length) return { copied: [], failed: [] };

  await fsp.mkdir(destDir, { recursive: true });

  const freeBytes = getFreeBytes(destDir);
  if (Number.isFinite(freeBytes) && freeBytes < plan.totalBytes) {
    throw new ImportError(
      `Not enough free space where these files would go: needs ${plan.totalBytes} bytes, `
      + `${freeBytes} available`,
    );
  }

  const result = { copied: [], failed: [] };
  for (const file of plan.candidates) {
    try {
      const name = P.uniqueName(fs, destDir, file.name);
      const destPath = path.join(destDir, name);
      const tmp = `${destPath}.lanshare-part`;

      // eslint-disable-next-line no-await-in-loop
      await fsp.copyFile(file.source, tmp);
      // eslint-disable-next-line no-await-in-loop
      const copiedHash = await hashLib.hashFile(tmp);
      if (copiedHash !== file.hash) {
        // eslint-disable-next-line no-await-in-loop
        await fsp.unlink(tmp).catch(() => {});
        throw new ImportError('The copy did not come out the same as the original');
      }
      // eslint-disable-next-line no-await-in-loop
      await fsp.rename(tmp, destPath);
      result.copied.push({ source: file.source, dest: destPath, size: file.size });
    } catch (err) {
      result.failed.push({ source: file.source, error: err.message });
    }
    onProgress?.({ done: result.copied.length + result.failed.length, total: plan.candidates.length });
  }
  return result;
}

module.exports = { ImportError, CAPTURE_FOLDER, detectCaptureDevice, planImport, runImport };
