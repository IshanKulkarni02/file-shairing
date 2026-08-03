'use strict';

/**
 * Packaged-executable bootstrap.
 *
 * Native code cannot run from inside a pkg snapshot: Windows needs a real
 * file on disk to load a DLL or spawn an executable. On first run this
 * unpacks the native payload beside the user's app data and points sharp and
 * ffmpeg at it.
 *
 * MUST be required before sharp, and before anything that requires sharp.
 * In a normal `node server.js` run this does nothing at all.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

const VENDOR_DIRNAME = 'vendor';
const COPY_BUFFER = 8 * 1024 * 1024;

const isPackaged = Boolean(process.pkg);

function appVersion() {
  try {
    // eslint-disable-next-line global-require
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Where unpacked native files live. Versioned, so an upgrade re-unpacks. */
function runtimeDir() {
  const base = process.env.LOCALAPPDATA
    || process.env.XDG_CACHE_HOME
    || path.join(os.homedir(), '.cache');
  return path.join(base, 'LANShare', 'runtime', appVersion());
}

/**
 * Copy in chunks rather than readFileSync. ffmpeg.exe is ~185 MB and buffering
 * it whole, twice, is a lot of memory to ask for at startup.
 */
function copyFileChunked(source, target) {
  const input = fs.openSync(source, 'r');
  try {
    const output = fs.openSync(target, 'w');
    try {
      const buffer = Buffer.allocUnsafe(COPY_BUFFER);
      let bytes;
      // eslint-disable-next-line no-cond-assign
      while ((bytes = fs.readSync(input, buffer, 0, buffer.length, null)) > 0) {
        fs.writeSync(output, buffer, 0, bytes);
      }
    } finally {
      fs.closeSync(output);
    }
  } finally {
    fs.closeSync(input);
  }
}

function listFilesRecursive(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFilesRecursive(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Unpack the vendor payload once. A marker file written last means a run
 * interrupted halfway is retried rather than trusted.
 */
function extractVendor() {
  const source = path.join(__dirname, '..', VENDOR_DIRNAME);
  const target = runtimeDir();
  const marker = path.join(target, '.unpacked');

  if (fs.existsSync(marker)) return target;
  if (!fs.existsSync(source)) return null;

  const files = listFilesRecursive(source);
  if (!files.length) return null;

  process.stdout.write('  First run: unpacking components, one moment...\n');

  for (const rel of files) {
    const from = path.join(source, ...rel.split('/'));
    const to = path.join(target, ...rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });

    // Size is the cheap correctness check; a half-written file from an
    // interrupted run would otherwise be reused forever.
    if (fs.existsSync(to) && fs.statSync(to).size === fs.statSync(from).size) continue;
    copyFileChunked(from, to);
  }

  fs.writeFileSync(marker, new Date().toISOString());
  return target;
}

/**
 * sharp resolves its binary with require('@img/sharp-<platform>/sharp.node'),
 * which cannot work inside a snapshot. Intercept that one specifier and load
 * the unpacked binary directly instead.
 *
 * The libvips DLLs sit in the same folder on purpose: libuv loads addons with
 * LOAD_WITH_ALTERED_SEARCH_PATH, so Windows resolves an addon's dependencies
 * from the addon's own directory.
 */
function hookSharpBinary(dir) {
  const platform = `${process.platform}-${process.arch}`;
  const specifier = `@img/sharp-${platform}/sharp.node`;
  const binaryPath = path.join(dir, 'sharp', `sharp-${platform}.node`);

  if (!fs.existsSync(binaryPath)) return false;

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === specifier) {
      const binding = { exports: {} };
      process.dlopen(binding, binaryPath);
      return binding.exports;
    }
    return originalLoad.apply(this, arguments);
  };
  return true;
}

function init() {
  if (!isPackaged) return { packaged: false };

  let dir = null;
  try {
    dir = extractVendor();
  } catch (err) {
    console.warn(`[runtime] could not unpack components: ${err.message}`);
  }
  if (!dir) return { packaged: true, runtimeDir: null };

  // lib/ffmpeg.js checks this before anything else.
  process.env.LANSHARE_RUNTIME_DIR = dir;

  const sharpReady = hookSharpBinary(dir);
  if (!sharpReady) {
    console.warn('[runtime] image support is unavailable: sharp binary missing');
  }

  return { packaged: true, runtimeDir: dir, sharpReady };
}

module.exports = { init, isPackaged, runtimeDir, VENDOR_DIRNAME };
