'use strict';

/**
 * Identifying a drive in a way that survives being unplugged.
 *
 * Drive letters and mount points are not identities. The external disk that
 * was E: last week is F: today because something else claimed E: first; on
 * macOS a second disk with the same name mounts as "/Volumes/Backup 1". A
 * library location pinned to a path would quietly point at the wrong disk,
 * or at nothing.
 *
 * So a location records the volume's own id — the volume GUID on Windows,
 * the filesystem UUID elsewhere — and asks this module where that volume is
 * mounted right now, or whether it is attached at all. Phase D's
 * sync-on-connect is the same question asked repeatedly.
 *
 * Where a volume cannot be identified, callers fall back to the plain path.
 * That still works; it just stops surviving a letter change, which is
 * strictly better than refusing to function.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Enumerating volumes shells out, which costs ~half a second on Windows.
// Anything polling this (Phase D) would otherwise pay that every tick.
const CACHE_MS = 3000;
let cache = { at: 0, volumes: [] };

function run(command, args) {
  try {
    const res = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (res.status !== 0) return null;
    return res.stdout;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-platform enumeration
// ---------------------------------------------------------------------------

/**
 * Windows: Get-Volume reports the volume GUID path as UniqueId, which is the
 * stable identity, plus the drive type that tells removable from fixed.
 */
function listWindows() {
  const script = `
    Get-Volume |
      Where-Object { $_.DriveLetter } |
      Select-Object DriveLetter, FileSystemLabel, DriveType, Size, SizeRemaining, UniqueId |
      ConvertTo-Json -Compress
  `;
  const out = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (!out) return [];

  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return [];
  }
  // ConvertTo-Json collapses a single result to an object rather than an array.
  const rows = Array.isArray(parsed) ? parsed : [parsed];

  return rows.filter(Boolean).map((row) => ({
    id: row.UniqueId || null,
    label: row.FileSystemLabel || `${row.DriveLetter}:`,
    mountPoint: `${row.DriveLetter}:\\`,
    removable: row.DriveType === 'Removable',
    sizeBytes: Number(row.Size) || 0,
    freeBytes: Number(row.SizeRemaining) || 0,
  }));
}

/**
 * macOS: diskutil reports a Volume UUID per mounted volume.
 *
 * Written from the documented output format but not yet exercised on a Mac —
 * Phase E is where this gets verified on real hardware. It degrades to the
 * path fallback if the output shape differs, rather than breaking.
 */
function listDarwin() {
  const out = run('sh', ['-c', 'ls -1 /Volumes 2>/dev/null']);
  if (!out) return [];

  const volumes = [];
  for (const name of out.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const mountPoint = `/Volumes/${name}`;
    const info = run('diskutil', ['info', mountPoint]) || '';
    const uuid = /Volume UUID:\s*(\S+)/.exec(info)?.[1] || null;
    const removable = /Removable Media:\s*Removable/i.test(info)
      || /Protocol:\s*(USB|Thunderbolt)/i.test(info);
    volumes.push({
      id: uuid,
      label: name,
      mountPoint,
      removable,
      sizeBytes: 0,
      freeBytes: 0,
    });
  }
  return volumes;
}

/**
 * Linux: lsblk reports a filesystem UUID and mount point per partition.
 * Same caveat as macOS — written to the documented format, verified in
 * Phase E.
 */
function listLinux() {
  const out = run('lsblk', ['-J', '-o', 'UUID,LABEL,MOUNTPOINT,SIZE,RM,FSAVAIL,FSSIZE']);
  if (!out) return [];

  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return [];
  }

  const volumes = [];
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (node.mountpoint && node.uuid) {
        volumes.push({
          id: node.uuid,
          label: node.label || node.mountpoint,
          mountPoint: node.mountpoint,
          removable: node.rm === true || node.rm === '1',
          sizeBytes: 0,
          freeBytes: 0,
        });
      }
      if (node.children) walk(node.children);
    }
  };
  walk(parsed.blockdevices);
  return volumes;
}

/** Every currently mounted volume this platform can report. */
function list({ fresh = false } = {}) {
  if (!fresh && Date.now() - cache.at < CACHE_MS) return cache.volumes;

  let volumes = [];
  try {
    if (process.platform === 'win32') volumes = listWindows();
    else if (process.platform === 'darwin') volumes = listDarwin();
    else volumes = listLinux();
  } catch {
    volumes = [];
  }

  cache = { at: Date.now(), volumes };
  return volumes;
}

/** Where a volume is mounted right now, or null if it is not attached. */
function findById(volumeId, options) {
  if (!volumeId) return null;
  return list(options).find((v) => v.id === volumeId) || null;
}

/**
 * The volume a path currently sits on.
 *
 * Matches on the longest mount point that prefixes the path, so a disk
 * mounted inside another disk's tree wins over its parent — otherwise
 * everything on Linux would resolve to "/".
 */
function identify(targetPath) {
  const resolved = path.resolve(targetPath);
  const candidates = list()
    .filter((v) => {
      const mount = path.resolve(v.mountPoint);
      if (process.platform === 'win32') {
        return resolved.toLowerCase().startsWith(mount.toLowerCase());
      }
      return resolved === mount || resolved.startsWith(mount.endsWith('/') ? mount : `${mount}/`);
    })
    .sort((a, b) => b.mountPoint.length - a.mountPoint.length);

  return candidates[0] || null;
}

/**
 * Re-point a stored location at wherever its volume is now.
 *
 * Given the volume id and the path *within* that volume recorded when the
 * location was created, returns the current absolute path — which is how a
 * location keeps working after the drive comes back as a different letter.
 * Returns null when the volume is not attached.
 */
function resolveLocation({ volumeId, relativePath }) {
  const volume = findById(volumeId);
  if (!volume) return null;
  const full = path.join(volume.mountPoint, relativePath || '');
  return { path: full, volume, present: fs.existsSync(full) };
}

/**
 * Split an absolute path into the volume it is on and the part below that
 * volume's mount point — the pair a location stores so it can be found again.
 * Falls back to a plain absolute path when the volume cannot be identified,
 * which still works but will not survive a drive-letter change.
 */
function describeLocation(targetPath) {
  const resolved = path.resolve(targetPath);
  const volume = identify(resolved);
  if (!volume || !volume.id) {
    return { volumeId: null, relativePath: null, path: resolved, volume: null };
  }
  return {
    volumeId: volume.id,
    relativePath: path.relative(path.resolve(volume.mountPoint), resolved),
    path: resolved,
    volume,
  };
}

/** Test-only: drop the cache so the next call re-enumerates. */
function _clearCache() {
  cache = { at: 0, volumes: [] };
}

module.exports = { list, findById, identify, resolveLocation, describeLocation, _clearCache };
