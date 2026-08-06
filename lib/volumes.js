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
function parseWindows(out) {
  if (!out) return [];

  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return [];
  }
  // ConvertTo-Json collapses a single result to an object rather than an array.
  const rows = Array.isArray(parsed) ? parsed : [parsed];

  return rows.filter((row) => row && row.DriveLetter).map((row) => ({
    id: row.UniqueId || null,
    label: row.FileSystemLabel || `${row.DriveLetter}:`,
    mountPoint: `${row.DriveLetter}:\\`,
    removable: row.DriveType === 'Removable',
    sizeBytes: Number(row.Size) || 0,
    freeBytes: Number(row.SizeRemaining) || 0,
  }));
}

function listWindows() {
  const script = `
    Get-Volume |
      Where-Object { $_.DriveLetter } |
      Select-Object DriveLetter, FileSystemLabel, DriveType, Size, SizeRemaining, UniqueId |
      ConvertTo-Json -Compress
  `;
  return parseWindows(run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]));
}

/**
 * macOS: one `diskutil info` block, turned into a volume.
 *
 * Returns null for anything that is not a real mounted volume, which is what
 * a network share or an unmounted entry looks like here.
 *
 * Parsing is deliberately tolerant: the field set differs between HFS+, APFS
 * and disk images, and a missing UUID is a degraded-but-working case (the
 * caller falls back to the plain path) rather than an error.
 */
function parseDarwinInfo(mountPoint, info) {
  if (!info) return null;

  const field = (name) => {
    const match = new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, 'm').exec(info);
    return match ? match[1] : null;
  };

  // APFS calls it "Volume UUID"; some disk images report only "Disk / Partition
  // UUID". Either is stable for our purpose, so take whichever is present.
  const uuid = field('Volume UUID') || field('Disk / Partition UUID') || null;

  const removableField = field('Removable Media');
  const protocol = field('Protocol') || '';
  const removable = /removable/i.test(removableField || '')
    || /^(USB|Thunderbolt|FireWire|SD Card)/i.test(protocol);

  // "Volume Total Space:  494384795648 Bytes (494.4 GB)" — the exact count
  // comes first and the rounded figure is the part in parentheses.
  const size = Number(/Volume Total Space:\s*(\d+)\s*Bytes/.exec(info)?.[1] || 0);
  const free = Number(/Volume Free Space:\s*(\d+)\s*Bytes/.exec(info)?.[1] || 0);

  return {
    id: uuid,
    label: field('Volume Name') || mountPoint.split('/').filter(Boolean).pop() || mountPoint,
    mountPoint,
    removable,
    sizeBytes: size,
    freeBytes: free,
  };
}

/**
 * Every path under /Volumes, one per line.
 *
 * Volume names routinely contain spaces ("My Passport"), so this splits on
 * newlines only — never on whitespace.
 */
function parseDarwinVolumeNames(out) {
  if (!out) return [];
  return out.split('\n').map((line) => line.replace(/\/+$/, '').trim()).filter(Boolean);
}

function listDarwin() {
  // The startup disk is reachable at / and is also linked under /Volumes, so
  // enumerating /Volumes alone covers everything a person would call a drive.
  const names = parseDarwinVolumeNames(run('sh', ['-c', 'ls -1 /Volumes 2>/dev/null']));

  const volumes = [];
  for (const name of names) {
    const mountPoint = `/Volumes/${name}`;
    const parsed = parseDarwinInfo(mountPoint, run('diskutil', ['info', mountPoint]));
    if (parsed) volumes.push(parsed);
  }
  return volumes;
}

/**
 * Linux: lsblk reports a filesystem UUID and mount point per partition.
 * Same caveat as macOS — written to the documented format, verified in
 * Phase E.
 */
/**
 * Mount points that are not drives anyone means.
 *
 * Every installed snap is a loop-mounted squashfs under /snap, so on an
 * ordinary Ubuntu desktop these outnumber the real disks several times over.
 */
function isPseudoMount(node) {
  if (node.type === 'loop') return true;
  if (node.fstype === 'squashfs') return true;
  const mount = node.mountpoint || '';
  return mount.startsWith('/snap/') || mount.startsWith('/var/lib/docker');
}

function parseLinux(out) {
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
      // lsblk reports a single mountpoint in older versions and a
      // mountpoints array in newer ones; a btrfs subvolume legitimately has
      // several. Take them all so a library on any of them is identifiable.
      const mounts = Array.isArray(node.mountpoints) && node.mountpoints.length
        ? node.mountpoints.filter(Boolean)
        : [node.mountpoint].filter(Boolean);

      for (const mountPoint of mounts) {
        if (!node.uuid) continue;
        if (isPseudoMount({ ...node, mountpoint: mountPoint })) continue;
        volumes.push({
          id: node.uuid,
          label: node.label || mountPoint,
          mountPoint,
          // Newer lsblk gives a real boolean, older gives the string "1".
          removable: node.rm === true || node.rm === '1' || node.hotplug === true,
          sizeBytes: Number(node.fssize) || Number(node.size) || 0,
          freeBytes: Number(node.fsavail) || 0,
        });
      }
      if (node.children) walk(node.children);
    }
  };
  walk(parsed.blockdevices);
  return volumes;
}

function listLinux() {
  // -b for byte counts rather than "14.6G", and TYPE/FSTYPE so snap's loop
  // mounts can be told from real disks.
  return parseLinux(run('lsblk', [
    '-J', '-b', '-o', 'UUID,LABEL,MOUNTPOINT,MOUNTPOINTS,SIZE,RM,HOTPLUG,TYPE,FSTYPE,FSAVAIL,FSSIZE',
  ]));
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

module.exports = {
  list,
  findById,
  identify,
  resolveLocation,
  describeLocation,
  _clearCache,
  // Parsing is exported separately from running the commands so the macOS and
  // Linux paths can be tested from any machine. The command output they take
  // is the real thing, recorded — see test/volume-parsers.mjs.
  parseWindows,
  parseDarwinInfo,
  parseDarwinVolumeNames,
  parseLinux,
};
