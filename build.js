'use strict';

/**
 * Build dist/LANShare.exe — a single self-contained Windows executable.
 *
 *   node build.js
 *
 * Native code cannot execute from inside a pkg snapshot, so sharp's binary
 * and the ffmpeg tools are staged into vendor/ and embedded as assets. On
 * first run lib/runtime.js unpacks them beside the user's app data.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { stageFfmpeg: stageFfmpegShared, copyInto, log, mb } = require('./tools/stage-ffmpeg');

const ROOT = __dirname;
const VENDOR = path.join(ROOT, 'vendor');
const DIST = path.join(ROOT, 'dist');
const TARGET = 'node22-win-x64';

const platform = `${process.platform}-${process.arch}`;

// --- stage sharp -----------------------------------------------------------

function stageSharp() {
  const packageDir = path.join(ROOT, 'node_modules', '@img', `sharp-${platform}`);
  const libDir = path.join(packageDir, 'lib');

  if (!fs.existsSync(libDir)) {
    console.error(`\n  Cannot find sharp's native package at ${packageDir}`);
    console.error('  Run: npm install --os=win32 --cpu=x64 sharp\n');
    process.exit(1);
  }

  const targetDir = path.join(VENDOR, 'sharp');
  // The .node addon and the libvips DLLs must land in the same folder:
  // Windows resolves an addon's dependent DLLs from the addon's directory.
  for (const entry of fs.readdirSync(libDir)) {
    if (!/\.(node|dll)$/i.test(entry)) continue;
    copyInto(path.join(libDir, entry), targetDir, `sharp/${entry}`);
  }
}

// --- package ---------------------------------------------------------------

function runPkg() {
  fs.mkdirSync(DIST, { recursive: true });
  const output = path.join(DIST, 'LANShare.exe');

  const args = [
    '@yao-pkg/pkg',
    path.join(ROOT, 'server.js'),
    '--targets', TARGET,
    '--output', output,
    // Brotli takes ffmpeg from 185 MB to about 60 MB inside the snapshot.
    '--compress', 'Brotli',
    '--config', path.join(ROOT, 'package.json'),
  ];

  log(`packaging for ${TARGET} (this takes a few minutes)...`);
  const res = spawnSync('npx', args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: ROOT,
  });

  if (res.status !== 0) {
    console.error('\n  Packaging failed.\n');
    process.exit(res.status || 1);
  }
  return output;
}

function main() {
  console.log('\n  Building LANShare\n');

  stageSharp();
  stageFfmpegShared(path.join(VENDOR, 'ffmpeg'));

  const output = runPkg();

  if (!fs.existsSync(output)) {
    console.error('\n  pkg reported success but produced no file.\n');
    process.exit(1);
  }

  console.log(`\n  Built ${output}`);
  console.log(`  Size:  ${mb(fs.statSync(output).size)}\n`);
  console.log('  Copy that one file anywhere and double-click it.');
  console.log('  It needs no Node.js and no ffmpeg on the target machine.\n');
}

main();
