'use strict';

const path = require('path');

// Anything the server writes for its own bookkeeping lives here and is hidden
// from the browser.
const INTERNAL_DIR = '.lanshare';

const IMAGE_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.tif', '.tiff',
  '.heic', '.heif', '.svg',
]);

const VIDEO_EXT = new Set([
  '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.wmv', '.flv', '.3gp', '.mpg', '.mpeg',
]);

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus']);

// Formats every browser can paint directly. Everything else in IMAGE_EXT
// (HEIC from iPhones, TIFF, AVIF on older clients) gets converted for preview.
const WEB_SAFE_IMAGE = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);

// Containers Safari plays natively but Chrome and Firefox often cannot,
// because iPhones record HEVC into them.
const APPLE_VIDEO = new Set(['.mov', '.m4v']);

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.tif': 'image/tiff',
  '.tiff': 'image/tiff', '.heic': 'image/heic', '.heif': 'image/heif', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.3gp': 'video/3gpp',
  '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/opus',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.zip': 'application/zip',
};

// Characters Windows forbids inside a filename.
const ILLEGAL_NAME_CHARS = '<>:"|?*/\\';

function ext(name) {
  return path.extname(name).toLowerCase();
}

function kindOf(name) {
  const e = ext(name);
  if (IMAGE_EXT.has(e)) return 'image';
  if (VIDEO_EXT.has(e)) return 'video';
  if (AUDIO_EXT.has(e)) return 'audio';
  return 'file';
}

function mimeOf(name) {
  return MIME[ext(name)] || 'application/octet-stream';
}

function isWebSafeImage(name) {
  return WEB_SAFE_IMAGE.has(ext(name));
}

function isAppleVideo(name) {
  return APPLE_VIDEO.has(ext(name));
}

/**
 * Turn a browser-supplied path into an absolute path inside `library`.
 * Rejects traversal, absolute paths, and the internal directory.
 * Returns null when the input is not safe to use.
 */
function resolveSafe(library, relPath) {
  const raw = String(relPath == null ? '/' : relPath).replace(/\\/g, '/');
  const normalized = path.posix.normalize('/' + raw.replace(/^\/+/, ''));
  const segments = normalized.split('/');
  if (segments.includes('..')) return null;
  if (segments.includes(INTERNAL_DIR)) return null;

  const base = path.resolve(library);
  const abs = path.resolve(base, '.' + normalized);
  // path.relative is the reliable containment check on Windows, where casing
  // and 8.3 short names make plain prefix comparison unsafe.
  const rel = path.relative(base, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

  return { abs, rel: normalized };
}

function hasControlChar(str) {
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) < 32 || str.charCodeAt(i) === 127) return true;
  }
  return false;
}

function hasIllegalChar(str) {
  for (const ch of str) {
    if (ILLEGAL_NAME_CHARS.includes(ch)) return true;
  }
  return false;
}

/**
 * Reject names that would escape a directory or upset Windows.
 * Spaces and hyphens stay legal: "Beach Trip - 2024.jpg" is a normal photo name.
 */
function safeName(name) {
  // Validate what the caller actually sent. Running basename() first would
  // quietly turn "../escape" into "escape" and create a folder under a name
  // nobody asked for, instead of reporting the input as bad.
  const base = String(name == null ? '' : name).trim();
  if (!base || base === '.' || base === '..') return null;
  if (base === INTERNAL_DIR) return null;
  if (hasIllegalChar(base) || hasControlChar(base)) return null;
  // Windows silently strips a trailing dot, which breaks every later lookup.
  if (base.endsWith('.')) return null;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(base)) return null;
  return base;
}

/**
 * Split an upload's relative path ("Trip/Day 1/IMG_0042.HEIC") into safe
 * segments, so dropping a folder keeps its structure. Returns null if any
 * segment is unsafe.
 */
function safeRelSegments(relPath) {
  const parts = String(relPath == null ? '' : relPath).replace(/\\/g, '/').split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    const clean = safeName(part);
    if (!clean) return null;
    out.push(clean);
  }
  return out.length ? out : null;
}

/** Append " (2)", " (3)"… until the name is free, so uploads never clobber. */
function uniqueName(fs, dir, name) {
  const e = path.extname(name);
  const stem = name.slice(0, name.length - e.length);
  let candidate = name;
  let n = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem} (${n})${e}`;
    n++;
  }
  return candidate;
}

module.exports = {
  INTERNAL_DIR,
  ext,
  kindOf,
  mimeOf,
  isWebSafeImage,
  isAppleVideo,
  resolveSafe,
  safeName,
  safeRelSegments,
  uniqueName,
};
