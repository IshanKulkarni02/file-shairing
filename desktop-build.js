'use strict';

/**
 * Build the LANShare desktop app with electron-builder.
 *
 *   node desktop-build.js            # for this machine's platform
 *   node desktop-build.js --linux    # or --win / --mac
 *
 * Unlike build.js's pkg-based console exe, sharp needs no special handling
 * here — electron-builder's asarUnpack (configured in package.json) puts
 * sharp's native files on real disk inside the install, and Electron
 * transparently resolves an unpacked asar path back to them. Only ffmpeg
 * needs staging, since it is not an npm package at all.
 *
 * **These do not usefully cross-compile.** A DMG needs macOS for its signing
 * and hdiutil toolchain; a .deb wants Linux or Docker. The default is this
 * machine's own platform, which is the case that always works.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { stageFfmpeg } = require('./tools/stage-ffmpeg');

const ROOT = __dirname;
const VENDOR = path.join(ROOT, 'vendor');

const NATIVE_FLAG = { win32: '--win', darwin: '--mac' }[process.platform] || '--linux';

function targetPlatform(argv) {
  return argv.find((a) => ['--win', '--mac', '--linux'].includes(a)) || NATIVE_FLAG;
}

/**
 * The locally installed electron-builder.
 *
 * Called directly rather than through `npx`, which on this machine is
 * intermittently refused by the OS ("The operation was rejected by your
 * operating system") when a security product has the npm shim locked. The
 * binary is right there in node_modules; going through a launcher that can
 * fail for reasons unrelated to the build buys nothing.
 */
function electronBuilderBin() {
  const bin = path.join(
    ROOT, 'node_modules', '.bin',
    process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
  );
  if (fs.existsSync(bin)) return bin;
  console.error('  electron-builder is not installed. Run: npm install');
  process.exit(1);
  return null;
}

/**
 * ffmpeg is bundled on Windows, where it is staged automatically.
 *
 * On macOS and Linux the app falls back to whatever is on PATH — brew or apt —
 * and a build that bundles nothing is the normal, supported case. Dropping
 * binaries into vendor/ffmpeg-mac or vendor/ffmpeg-linux makes the package
 * self-contained instead, which is what an AppImage wants.
 */
function prepareFfmpeg(platformFlag) {
  if (platformFlag === '--win') {
    stageFfmpeg(path.join(VENDOR, 'ffmpeg'));
    return;
  }

  const dir = path.join(VENDOR, platformFlag === '--mac' ? 'ffmpeg-mac' : 'ffmpeg-linux');
  fs.mkdirSync(dir, { recursive: true });

  const bundled = fs.readdirSync(dir).filter((name) => !name.endsWith('.md'));
  if (bundled.length) {
    console.log(`  Bundling ffmpeg from ${path.relative(ROOT, dir)}: ${bundled.join(', ')}`);
  } else {
    console.log(`  No ffmpeg staged in ${path.relative(ROOT, dir)}, so the app will use the`);
    console.log('  system one if there is any. Without it, video thumbnails, duration and');
    console.log('  HEVC conversion are unavailable; everything else works normally.');
  }
}

function main() {
  const platformFlag = targetPlatform(process.argv.slice(2));
  console.log(`\n  Building the LANShare desktop app (${platformFlag.replace('--', '')})\n`);

  if (platformFlag !== NATIVE_FLAG) {
    console.log('  Note: building for another platform from this one usually fails —');
    console.log('  a DMG needs macOS, a .deb wants Linux or Docker.\n');
  }

  prepareFfmpeg(platformFlag);

  if (platformFlag === '--mac') {
    console.log('\n  This DMG will be unsigned unless an Apple Developer certificate is');
    console.log('  configured. Gatekeeper refuses unsigned apps on first launch; the way');
    console.log('  in is right-click → Open, once. That is Apple policy, not a build bug.');
  }

  console.log('\n  Running electron-builder (this takes a few minutes)...\n');
  const res = spawnSync(electronBuilderBin(), [platformFlag], {
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
