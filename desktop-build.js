'use strict';

/**
 * Build the LANShare desktop installer with electron-builder.
 *
 *   node desktop-build.js
 *
 * Unlike build.js's pkg-based console exe, sharp needs no special handling
 * here — electron-builder's asarUnpack (configured in package.json) puts
 * sharp's native files on real disk inside the install, and Electron
 * transparently resolves an unpacked asar path back to them. Only ffmpeg
 * needs staging, since it is not an npm package at all.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { stageFfmpeg } = require('./tools/stage-ffmpeg');

const ROOT = __dirname;
const VENDOR = path.join(ROOT, 'vendor');

function main() {
  console.log('\n  Building the LANShare desktop installer\n');

  stageFfmpeg(path.join(VENDOR, 'ffmpeg'));

  console.log('\n  Running electron-builder (this takes a few minutes)...\n');
  const res = spawnSync('npx', ['electron-builder', '--win', '--x64'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: ROOT,
  });

  if (res.status !== 0) {
    console.error('\n  Desktop build failed.\n');
    process.exit(res.status || 1);
  }

  console.log('\n  Done. See dist-desktop/ for the installer and the unpacked app.\n');
}

main();
