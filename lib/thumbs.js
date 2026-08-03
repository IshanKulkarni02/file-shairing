'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const { INTERNAL_DIR, kindOf } = require('./paths');
const ffmpeg = require('./ffmpeg');

// Square tiles for the grid, long-edge fit for the full-screen viewer.
const VARIANTS = {
  grid: { size: 480, fit: 'cover', quality: 72 },
  large: { size: 1600, fit: 'inside', quality: 80 },
};

// Decoding is CPU-bound. Leave the machine usable while a big folder warms up.
const MAX_CONCURRENT = Math.max(2, Math.min(6, os.cpus().length - 1));

let active = 0;
const queue = [];
const inFlight = new Map();

sharp.cache({ files: 0, memory: 128 });
sharp.concurrency(1); // We do our own queueing; libvips threads on top would thrash.

function runNext() {
  if (active >= MAX_CONCURRENT || !queue.length) return;
  const job = queue.shift();
  active++;
  job.run().then(job.resolve, job.reject).finally(() => {
    active--;
    runNext();
  });
}

function schedule(run) {
  return new Promise((resolve, reject) => {
    queue.push({ run, resolve, reject });
    runNext();
  });
}

function cacheDir(library) {
  return path.join(library, INTERNAL_DIR, 'thumbs');
}

/**
 * Cache key includes mtime and size, so replacing a file with a different one
 * of the same name produces a new thumbnail instead of a stale hit.
 */
function cacheKey(relPath, stat, variant) {
  const material = `${relPath}:${stat.mtimeMs}:${stat.size}:${variant}:v1`;
  return crypto.createHash('sha1').update(material).digest('hex');
}

function cachePath(library, key) {
  return path.join(cacheDir(library), key.slice(0, 2), `${key}.webp`);
}

async function renderImage(absPath, variant) {
  const spec = VARIANTS[variant];
  const pipeline = sharp(absPath, { failOn: 'none', animated: false, limitInputPixels: 0 })
    // .rotate() with no argument applies the EXIF orientation, which is what
    // keeps iPhone portrait shots from showing up sideways.
    .rotate()
    .resize(spec.size, spec.size, {
      fit: spec.fit,
      withoutEnlargement: true,
      position: 'attention', // crop toward the subject, not the geometric centre
    });
  return pipeline.webp({ quality: spec.quality, effort: 4 }).toBuffer();
}

async function renderVideo(absPath, variant) {
  const spec = VARIANTS[variant];
  const meta = await ffmpeg.probe(absPath);
  // 10% in usually clears fade-ins and lens-cap frames; clamp for short clips.
  const seekTo = meta && meta.duration > 4 ? Math.min(meta.duration * 0.1, 10) : 0;

  let frame = await ffmpeg.grabFrame(absPath, seekTo);
  if (!frame && seekTo > 0) frame = await ffmpeg.grabFrame(absPath, 0);
  if (!frame) return null;

  return sharp(frame, { failOn: 'none' })
    .resize(spec.size, spec.size, {
      fit: spec.fit,
      withoutEnlargement: true,
      position: 'attention',
    })
    .webp({ quality: spec.quality, effort: 4 })
    .toBuffer();
}

async function writeAtomic(target, buffer) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, buffer);
  await fsp.rename(tmp, target);
}

/**
 * Return the path to a cached thumbnail, generating it on first request.
 * Resolves to null when the file has no meaningful visual preview.
 */
async function get(library, absPath, relPath, stat, variant = 'grid') {
  if (!VARIANTS[variant]) variant = 'grid';
  const kind = kindOf(absPath);
  if (kind !== 'image' && kind !== 'video') return null;

  const key = cacheKey(relPath, stat, variant);
  const target = cachePath(library, key);

  if (fs.existsSync(target)) return target;
  if (inFlight.has(key)) return inFlight.get(key);

  const work = schedule(async () => {
    // Another request may have finished while we waited in the queue.
    if (fs.existsSync(target)) return target;
    const buffer = kind === 'video'
      ? await renderVideo(absPath, variant)
      : await renderImage(absPath, variant);
    if (!buffer) return null;
    await writeAtomic(target, buffer);
    return target;
  }).catch((err) => {
    // A single unreadable file must not take down the grid.
    console.warn(`[thumb] ${relPath}: ${err.message}`);
    return null;
  }).finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, work);
  return work;
}

/** Best-effort dimensions and duration, used for grid layout and badges. */
async function describe(absPath) {
  const kind = kindOf(absPath);
  try {
    if (kind === 'image') {
      const meta = await sharp(absPath, { failOn: 'none' }).metadata();
      const swap = meta.orientation >= 5 && meta.orientation <= 8;
      return {
        width: swap ? meta.height : meta.width,
        height: swap ? meta.width : meta.height,
        duration: 0,
      };
    }
    if (kind === 'video') {
      const meta = await ffmpeg.probe(absPath);
      if (!meta) return null;
      return { width: meta.width, height: meta.height, duration: meta.duration, codec: meta.codec };
    }
  } catch {
    return null;
  }
  return null;
}

/** Drop cache entries whose source file is gone or changed. */
async function prune(library) {
  const dir = cacheDir(library);
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  const cutoff = Date.now() - 90 * 86400e3;
  for (const bucket of await fsp.readdir(dir)) {
    const bucketPath = path.join(dir, bucket);
    let entries;
    try {
      entries = await fsp.readdir(bucketPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(bucketPath, entry);
      try {
        const stat = await fsp.stat(file);
        if (stat.atimeMs < cutoff) {
          await fsp.unlink(file);
          removed++;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}

module.exports = { get, describe, prune, cacheDir, VARIANTS };
