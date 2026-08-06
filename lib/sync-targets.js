'use strict';

/**
 * Sync targets: what gets synced, to where, and under what rules.
 *
 * A target pairs one album in the library with one folder on a registered
 * location (Phase C), plus the settings that decide how disagreements are
 * resolved. Stored in config alongside locations, and deliberately small —
 * everything hard lives in lib/sync-plan.js and lib/sync.js.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const locations = require('./locations.js');
const P = require('./paths.js');
const { POLICIES } = require('./sync-plan.js');

class SyncTargetError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'SyncTargetError';
    this.status = status;
  }
}

function ensureList(config) {
  if (!Array.isArray(config.syncTargets)) config.syncTargets = [];
  return config.syncTargets;
}

/** Where a target's files live on its drive. */
function targetDirFor(location, target) {
  if (!location?.path) return null;
  return path.join(location.path, ...target.subPath.split('/').filter(Boolean));
}

/**
 * Resolve the album this target syncs, inside the library.
 *
 * '/' is allowed and means the whole library, which is the plain reading of
 * "back up everything".
 */
function sourceDirFor(library, target) {
  const resolved = P.resolveSafe(library, target.album);
  if (!resolved) return null;
  return resolved.abs;
}

function list(config, library) {
  const all = locations.list(config);
  return ensureList(config).map((target) => {
    const location = all.find((l) => l.id === target.locationId) || null;
    const targetDir = location ? targetDirFor(location, target) : null;
    return {
      ...target,
      location: location
        ? { id: location.id, label: location.label, attached: location.attached }
        : null,
      // A target whose location was removed is broken rather than merely
      // offline, and the UI has to be able to tell the difference.
      orphaned: !location,
      ready: Boolean(location?.attached && targetDir && fs.existsSync(path.dirname(targetDir))),
      targetDir,
      sourceDir: library ? sourceDirFor(library, target) : null,
    };
  });
}

function find(config, id) {
  return ensureList(config).find((t) => t.id === id) || null;
}

/**
 * Create a target.
 *
 * `album` is a library path ('/' for everything). `subPath` is where on the
 * drive it lands, defaulting to the album's own name so two albums backed up
 * to one drive do not land on top of each other.
 */
function add(config, library, { locationId, album = '/', subPath, policy = 'keep-both', runOnConnect = true, label } = {}) {
  const location = locations.list(config).find((l) => l.id === locationId);
  if (!location) throw new SyncTargetError('Choose a drive to sync to', 404);

  if (!POLICIES.includes(policy)) {
    throw new SyncTargetError('That is not a conflict policy this app knows');
  }

  const resolved = P.resolveSafe(library, album);
  if (!resolved) throw new SyncTargetError('That album path is not valid');
  if (!fs.existsSync(resolved.abs)) throw new SyncTargetError('That album does not exist', 404);

  // A relocated album already lives on a drive. Syncing it to another drive
  // is legitimate, but syncing it to the drive it is already on would have a
  // folder sync with itself.
  if (locations.isLink(resolved.abs)) {
    const target = locations.linkTarget(resolved.abs);
    if (target && location.path && path.resolve(target).startsWith(path.resolve(location.path))) {
      throw new SyncTargetError(
        'That album already lives on this drive, so there is nothing to sync', 409,
      );
    }
  }

  const leaf = resolved.rel === '/' ? 'Library' : path.posix.basename(resolved.rel);
  const cleanSub = normalizeSubPath(subPath || leaf);

  const existing = ensureList(config);
  if (existing.some((t) => t.locationId === locationId && t.subPath.toLowerCase() === cleanSub.toLowerCase())) {
    throw new SyncTargetError('That folder on this drive is already the target of another sync', 409);
  }
  if (existing.some((t) => t.locationId === locationId && t.album === resolved.rel)) {
    throw new SyncTargetError('This album is already synced to this drive', 409);
  }

  const record = {
    id: crypto.randomBytes(8).toString('hex'),
    label: (typeof label === 'string' && label.trim()) ? label.trim().slice(0, 60) : `${leaf} → ${location.label}`,
    locationId,
    album: resolved.rel,
    subPath: cleanSub,
    policy,
    runOnConnect: runOnConnect !== false,
    createdAt: new Date().toISOString(),
    lastRun: null,
  };
  existing.push(record);
  return record;
}

/** Each segment validated the same way an album name is, so a target cannot escape its drive. */
function normalizeSubPath(input) {
  const segments = String(input).split(/[\\/]+/).filter(Boolean);
  if (!segments.length) throw new SyncTargetError('Choose a folder name on the drive');
  const clean = segments.map((segment) => {
    const safe = P.safeName(segment);
    if (!safe) throw new SyncTargetError(`"${segment}" is not a valid folder name`);
    return safe;
  });
  return clean.join('/');
}

function update(config, id, patch = {}) {
  const target = find(config, id);
  if (!target) throw new SyncTargetError('No such sync', 404);

  if (patch.policy !== undefined) {
    if (!POLICIES.includes(patch.policy)) {
      throw new SyncTargetError('That is not a conflict policy this app knows');
    }
    target.policy = patch.policy;
  }
  if (patch.runOnConnect !== undefined) target.runOnConnect = Boolean(patch.runOnConnect);
  if (patch.label !== undefined) {
    const label = String(patch.label).trim();
    if (!label) throw new SyncTargetError('A sync needs a name');
    target.label = label.slice(0, 60);
  }
  return target;
}

function remove(config, id) {
  const all = ensureList(config);
  const index = all.findIndex((t) => t.id === id);
  if (index === -1) throw new SyncTargetError('No such sync', 404);
  const [removed] = all.splice(index, 1);
  return removed;
}

/** Record how a run went, for the "last synced" line in the UI. */
function recordRun(config, id, report) {
  const target = find(config, id);
  if (!target) return null;
  target.lastRun = {
    at: new Date().toISOString(),
    copied: (report.planned?.toTarget || 0) + (report.planned?.toSource || 0),
    deleted: (report.planned?.deleteOnTarget || 0) + (report.planned?.deleteOnSource || 0),
    conflicts: report.planned?.conflicts || 0,
    skipped: report.skipped?.length || 0,
    failed: report.failed?.length || 0,
    stoppedEarly: Boolean(report.stoppedEarly),
    bytesCopied: report.bytesCopied || 0,
  };
  return target.lastRun;
}

/**
 * Everything the sync engine needs to run one target.
 *
 * Fails loudly rather than returning something half-usable — a sync started
 * against the wrong folder is exactly the mistake worth refusing.
 *
 * `create` decides whether the destination folder is made if it is missing.
 * A real run wants that, so the first sync to a fresh drive just works. A
 * preview must not: creating a folder is a write, and a dry run that writes
 * is not a dry run.
 */
function resolveForRun(config, library, id, { create = true } = {}) {
  const target = find(config, id);
  if (!target) throw new SyncTargetError('No such sync', 404);

  const location = locations.list(config).find((l) => l.id === target.locationId);
  if (!location) throw new SyncTargetError('The drive for this sync is no longer set up', 404);
  if (!location.attached) throw new SyncTargetError(`${location.label} is not connected`, 409);

  const sourceDir = sourceDirFor(library, target);
  if (!sourceDir) throw new SyncTargetError('That album path is not valid');
  if (!fs.existsSync(sourceDir)) {
    throw new SyncTargetError('The album this sync copies no longer exists', 404);
  }

  const targetDir = targetDirFor(location, target);
  if (create) fs.mkdirSync(targetDir, { recursive: true });

  return {
    target,
    location,
    sourceDir,
    targetDir,
    // The drive itself, so the engine can tell "not connected" apart from
    // "connected, but this sync has not put anything there yet".
    driveRoot: location.path,
    targetId: target.id,
    policy: target.policy,
    conflictLabel: location.label,
  };
}

module.exports = {
  SyncTargetError,
  POLICIES,
  list,
  find,
  add,
  update,
  remove,
  recordRun,
  resolveForRun,
  // exported for tests
  normalizeSubPath,
};
