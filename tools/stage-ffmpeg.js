'use strict';

/**
 * Copies ffmpeg/ffprobe from PATH into a vendor directory to be embedded in
 * a build. Shared by build.js (the pkg console exe) and
 * desktop-build.js (the Electron installer) — both need the same two files,
 * just delivered to the target machine by different mechanisms.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function log(message) {
  console.log(`  ${message}`);
}

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function findOnPath(name) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(probe, [name], { encoding: 'utf8' });
  if (res.status !== 0) return null;
  const first = res.stdout.split(/\r?\n/).find((line) => line.trim());
  return first && fs.existsSync(first.trim()) ? first.trim() : null;
}

function copyInto(source, targetDir, label) {
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, path.basename(source));
  // Staging is the slow part of a build; skip files already in place.
  if (fs.existsSync(target) && fs.statSync(target).size === fs.statSync(source).size) {
    log(`${label} already staged (${mb(fs.statSync(target).size)})`);
    return target;
  }
  fs.copyFileSync(source, target);
  log(`staged ${label} (${mb(fs.statSync(target).size)})`);
  return target;
}

/** Stage ffmpeg and ffprobe from PATH into `targetDir`. Warns, never throws, if either is missing. */
function stageFfmpeg(targetDir) {
  const missing = [];

  for (const tool of ['ffmpeg', 'ffprobe']) {
    const exe = process.platform === 'win32' ? `${tool}.exe` : tool;
    const staged = path.join(targetDir, exe);
    if (fs.existsSync(staged)) {
      log(`${tool} already staged (${mb(fs.statSync(staged).size)})`);
      continue;
    }
    const found = findOnPath(tool);
    if (!found) {
      missing.push(tool);
      continue;
    }
    copyInto(found, targetDir, tool);
  }

  if (missing.length) {
    console.warn(`\n  WARNING: ${missing.join(' and ')} not found on PATH.`);
    console.warn('  The build will still complete, but video thumbnails and the');
    console.warn('  HEVC fallback will not work on a machine without ffmpeg.');
    console.warn('  Install ffmpeg and rebuild for a fully self-contained app.\n');
  }
  return missing;
}

module.exports = { stageFfmpeg, findOnPath, copyInto, log, mb };
