'use strict';

/**
 * Letting albums live on other drives without splitting the library.
 *
 * The obvious design — a set of library roots the gallery merges — means
 * rewriting every path in the app to carry which root it belongs to, and it
 * has an ugly failure: unplug a drive and albums silently vanish from the
 * listing with no explanation.
 *
 * This takes the simpler route. An album that lives elsewhere is moved to
 * that drive and a **directory junction** is left behind in its place. Every
 * existing path keeps working untouched — the gallery, thumbnails, vaults,
 * uploads and downloads have no idea anything moved — while the bytes are
 * genuinely on the other disk. Junctions need no administrator rights, and
 * Node reports them as ordinary directories to everything that matters.
 *
 * What this module adds on top is the part a bare junction cannot do:
 * remembering *which volume* the target is on, so when the external disk
 * comes back as F: instead of E: the link is repointed rather than left
 * dangling. That is what lib/volumes.js is for.
 *
 * Google Drive needs nothing special: with Drive for Desktop running, its
 * folder is an ordinary path on an ordinary volume, so it is just another
 * location.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const volumes = require('./volumes');
const { INTERNAL_DIR, safeName } = require('./paths');

class LocationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * Create a directory junction (Windows) or symlink (elsewhere).
 *
 * Junctions rather than symlinks on Windows deliberately: creating a
 * symlink there needs either administrator rights or Developer Mode, while a
 * junction needs neither. For pointing one directory at another on the same
 * machine they behave identically.
 */
function createLink(linkPath, targetPath) {
  if (process.platform === 'win32') {
    const res = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        `New-Item -ItemType Junction -Path ${JSON.stringify(linkPath)} -Target ${JSON.stringify(targetPath)} -ErrorAction Stop | Out-Null`],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 },
    );
    if (res.status !== 0) {
      throw new LocationError(`Could not link the album to that drive: ${(res.stderr || '').trim() || 'unknown error'}`);
    }
    return;
  }
  fs.symlinkSync(targetPath, linkPath, 'dir');
}

/** True if this path is a link rather than a real directory. */
function isLink(targetPath) {
  try {
    return fs.lstatSync(targetPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Remove a link without touching what it points at.
 *
 * Getting this wrong would delete the album's real contents on the other
 * drive, so it refuses to run on anything that is not a link.
 *
 * A Windows junction is a directory reparse point, and it has to be removed
 * with rmdir. fs.rmSync happens to do the right thing under plain Node, but
 * throws EISDIR under Electron — where this code actually runs — because
 * Electron's asar shim stats through the link. rmdirSync behaves identically
 * in both, and unlinking is what a POSIX symlink needs.
 */
function removeLink(linkPath) {
  if (!isLink(linkPath)) {
    throw new LocationError('Refusing to remove that: it is a real folder, not a link to one');
  }
  if (process.platform === 'win32') fs.rmdirSync(linkPath);
  else fs.unlinkSync(linkPath);
}

function linkTarget(linkPath) {
  try {
    return fs.realpathSync(linkPath);
  } catch {
    // A dangling link — the drive is not attached — cannot be resolved, but
    // readlink still reports where it was aiming.
    try {
      return fs.readlinkSync(linkPath);
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

function ensureList(config) {
  if (!Array.isArray(config.locations)) config.locations = [];
  return config.locations;
}

/** Every registered location, with where it is right now and whether it is attached. */
function list(config) {
  return ensureList(config).map((entry) => {
    const resolved = entry.volumeId
      ? volumes.resolveLocation({ volumeId: entry.volumeId, relativePath: entry.relativePath })
      : null;
    // Without a volume id (a platform that could not identify one) the
    // recorded path is all there is, so fall back to it.
    const currentPath = resolved?.path || entry.path || null;
    const attached = Boolean(currentPath && fs.existsSync(currentPath));
    return {
      id: entry.id,
      label: entry.label,
      path: currentPath,
      recordedPath: entry.path,
      volumeId: entry.volumeId,
      removable: resolved?.volume?.removable ?? null,
      attached,
      // A location whose drive is present but at a different letter than when
      // it was added is exactly the case junction repair exists for.
      moved: Boolean(currentPath && entry.path && path.resolve(currentPath) !== path.resolve(entry.path)),
      addedAt: entry.addedAt,
    };
  });
}

function find(config, id) {
  return ensureList(config).find((entry) => entry.id === id) || null;
}

/**
 * Register a folder on some drive as a place albums can live.
 *
 * Records the volume id alongside the path so the location can be found
 * again after the drive returns on a different letter.
 */
function add(config, { label, targetPath }) {
  const cleanLabel = safeName(label);
  if (!cleanLabel) throw new LocationError('That location name is not valid');
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new LocationError('Choose a folder for this location');
  }

  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) throw new LocationError('That folder does not exist', 404);
  if (!fs.statSync(resolved).isDirectory()) throw new LocationError('That is a file, not a folder');

  const existing = ensureList(config);
  if (existing.some((e) => e.label.toLowerCase() === cleanLabel.toLowerCase())) {
    throw new LocationError('A location with that name already exists', 409);
  }
  if (existing.some((e) => path.resolve(e.path) === resolved)) {
    throw new LocationError('That folder is already a location', 409);
  }

  const described = volumes.describeLocation(resolved);
  existing.push({
    id: crypto.randomBytes(8).toString('hex'),
    label: cleanLabel,
    volumeId: described.volumeId,
    relativePath: described.relativePath,
    path: resolved,
    addedAt: new Date().toISOString(),
  });
  return existing[existing.length - 1];
}

/**
 * Forget a location. Refuses while albums still point at it, since removing
 * it would leave those albums as dangling links with nothing recording where
 * their contents went.
 */
function remove(config, library, id) {
  const entry = find(config, id);
  if (!entry) throw new LocationError('No such location', 404);

  const inUse = albumsOn(library, config, id);
  if (inUse.length) {
    throw new LocationError(
      `Bring these albums back first: ${inUse.map((a) => a.name).join(', ')}`,
      409,
    );
  }

  config.locations = ensureList(config).filter((e) => e.id !== id);
}

// ---------------------------------------------------------------------------
// Albums that live elsewhere
// ---------------------------------------------------------------------------

/** Describe a top-level album: is it linked away, and is that target reachable? */
function describeAlbum(library, config, name) {
  const linkPath = path.join(library, name);
  if (!isLink(linkPath)) return { name, linked: false };

  const target = linkTarget(linkPath);
  const reachable = Boolean(target && fs.existsSync(target));
  const owner = target
    ? list(config).find((loc) => loc.path && path.resolve(target).startsWith(path.resolve(loc.path)))
    : null;

  return {
    name,
    linked: true,
    target,
    reachable,
    location: owner ? { id: owner.id, label: owner.label, attached: owner.attached } : null,
  };
}

/** Every album currently living on a given location. */
function albumsOn(library, config, locationId) {
  const location = list(config).find((l) => l.id === locationId);
  if (!location?.path) return [];

  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(library, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (entry.name === INTERNAL_DIR || entry.name.startsWith('.')) continue;
    const described = describeAlbum(library, config, entry.name);
    if (described.linked && described.location?.id === locationId) out.push(described);
  }
  return out;
}

/**
 * Move an album's contents onto a location and leave a junction behind.
 *
 * Copy, verify, then remove — never move-then-hope. If anything fails the
 * album is left exactly where it was and the half-written copy is cleaned
 * up, because the alternative is losing photos to a full disk.
 */
async function relocateAlbum(library, config, albumName, locationId) {
  const name = safeName(albumName);
  if (!name) throw new LocationError('That album name is not valid');

  const location = list(config).find((l) => l.id === locationId);
  if (!location) throw new LocationError('No such location', 404);
  if (!location.attached) throw new LocationError(`${location.label} is not connected`, 409);

  const source = path.join(library, name);
  if (!fs.existsSync(source)) throw new LocationError('That album does not exist', 404);
  if (isLink(source)) throw new LocationError('That album already lives on another drive', 409);
  if (!fs.statSync(source).isDirectory()) throw new LocationError('That is a file, not an album');

  const destination = path.join(location.path, name);
  if (fs.existsSync(destination)) {
    throw new LocationError(`${location.label} already has a folder called "${name}"`, 409);
  }

  await copyTree(source, destination);

  const [from, to] = await Promise.all([measure(source), measure(destination)]);
  if (from.bytes !== to.bytes || from.files !== to.files) {
    await fsp.rm(destination, { recursive: true, force: true }).catch(() => {});
    throw new LocationError('The copy did not verify — nothing was changed');
  }

  // Only now is it safe to remove the original and put the link in its place.
  await fsp.rm(source, { recursive: true, force: true });
  try {
    createLink(source, destination);
  } catch (err) {
    // The link failed but the data is intact on the other drive; move it back
    // rather than leaving the album missing from the library.
    await copyTree(destination, source).catch(() => {});
    await fsp.rm(destination, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  return { name, target: destination, location: { id: location.id, label: location.label } };
}

/** Move an album's contents back into the library and drop the link. */
async function bringAlbumHome(library, config, albumName) {
  const name = safeName(albumName);
  if (!name) throw new LocationError('That album name is not valid');

  const linkPath = path.join(library, name);
  if (!isLink(linkPath)) throw new LocationError('That album already lives in the library', 409);

  const target = linkTarget(linkPath);
  if (!target || !fs.existsSync(target)) {
    throw new LocationError('That album\'s drive is not connected', 409);
  }

  const staging = path.join(library, `.incoming-${name}-${Date.now()}`);
  await copyTree(target, staging);

  const [from, to] = await Promise.all([measure(target), measure(staging)]);
  if (from.bytes !== to.bytes || from.files !== to.files) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw new LocationError('The copy did not verify — nothing was changed');
  }

  // Staging holds a second full copy of the album. Anything that goes wrong
  // from here on has to take it with it, or a failed attempt quietly leaves a
  // hidden duplicate in the library — invisible in the gallery, and as large
  // as the album itself.
  try {
    removeLink(linkPath);
    await fsp.rename(staging, linkPath);
  } catch (err) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    // The album's real contents are still on the drive and untouched; only
    // the copy is gone. Relinking restores exactly the state we started in.
    if (!fs.existsSync(linkPath)) createLink(linkPath, target);
    throw err;
  }
  await fsp.rm(target, { recursive: true, force: true }).catch(() => {});

  return { name };
}

/**
 * Repoint links whose drive has come back at a different path.
 *
 * A junction stores an absolute path, so an external disk that was E: and is
 * now F: leaves every album on it dangling. Called at startup and whenever a
 * location is seen to have moved.
 */
function repairLinks(library, config) {
  const repaired = [];
  const broken = [];

  let entries;
  try {
    entries = fs.readdirSync(library, { withFileTypes: true });
  } catch {
    return { repaired, broken };
  }

  const locations = list(config);

  for (const entry of entries) {
    if (entry.name === INTERNAL_DIR || entry.name.startsWith('.')) continue;
    const linkPath = path.join(library, entry.name);
    if (!isLink(linkPath)) continue;

    const current = linkTarget(linkPath);
    if (current && fs.existsSync(current)) continue; // still fine

    // Find the location whose *recorded* path this link was aiming at, then
    // repoint it at where that volume lives now.
    const owner = locations.find((loc) => loc.recordedPath
      && current
      && path.resolve(current).toLowerCase().startsWith(path.resolve(loc.recordedPath).toLowerCase()));

    if (!owner?.attached || !owner.path) {
      broken.push({ name: entry.name, target: current, location: owner?.label || null });
      continue;
    }

    const rebuilt = path.join(owner.path, path.basename(current));
    if (!fs.existsSync(rebuilt)) {
      broken.push({ name: entry.name, target: current, location: owner.label });
      continue;
    }

    try {
      removeLink(linkPath);
      createLink(linkPath, rebuilt);
      repaired.push({ name: entry.name, from: current, to: rebuilt });
    } catch (err) {
      broken.push({ name: entry.name, target: current, location: owner.label, error: err.message });
    }
  }

  // Locations that moved are now the truth; record it so the next repair has
  // an accurate starting point.
  for (const loc of locations) {
    if (loc.moved && loc.path) {
      const entry = find(config, loc.id);
      if (entry) entry.path = loc.path;
    }
  }

  return { repaired, broken };
}

// ---------------------------------------------------------------------------
// Copying
// ---------------------------------------------------------------------------

/**
 * Walk a tree without following links.
 *
 * An album that is itself a link, or contains one, would otherwise be walked
 * into — counting another drive's contents, or looping forever if something
 * points back at an ancestor.
 */
async function measure(dir) {
  let bytes = 0;
  let files = 0;

  async function walk(current) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        try {
          bytes += (await fsp.stat(full)).size;
          files++;
        } catch { /* vanished mid-walk */ }
      }
    }
  }

  await walk(dir);
  return { bytes, files };
}

async function copyTree(source, destination) {
  await fsp.mkdir(destination, { recursive: true });
  const entries = await fsp.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    // Links are not followed here either — copying through one would drag in
    // whatever it points at, which is never what a relocation means.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await fsp.copyFile(from, to);
  }
}

module.exports = {
  LocationError,
  list,
  find,
  add,
  remove,
  describeAlbum,
  albumsOn,
  relocateAlbum,
  bringAlbumHome,
  repairLinks,
  isLink,
  linkTarget,
  // exported for tests
  createLink,
  removeLink,
  measure,
};
