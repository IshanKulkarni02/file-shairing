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

// ---------------------------------------------------------------------------
// Thumbnails for vault contents
// ---------------------------------------------------------------------------

/**
 * A thumbnail of an encrypted photo is still a recognisable picture of it.
 * Writing those into the ordinary cache would leave a plaintext gallery of
 * precisely the images the vault exists to protect, sitting in a folder
 * nobody thinks to look at. So vault thumbnails are themselves encrypted,
 * under a key derived from the vault master key.
 *
 * The cache key is salted with the vault id as well, so tiles from two
 * different vaults can never collide.
 */
function thumbKeyFor(masterKey) {
  // A separate key from the one wrapping file keys — same secret, different
  // purpose, so a mistake in one place cannot be replayed in the other.
  return crypto.createHash('sha256').update(masterKey).update('lanshare-thumb-key').digest();
}

async function renderFromDecrypted(plainPath, kind, variant) {
  return kind === 'video'
    ? renderVideo(plainPath, variant)
    : renderImage(plainPath, variant);
}

/**
 * Like get(), but for a file stored inside a vault: decrypts to a temporary
 * file, renders from that, encrypts the resulting tile, and makes sure the
 * plaintext copy is gone before returning — including if rendering threw.
 *
 * sharp and ffmpeg both need a real file they can seek around in, which is
 * why this round-trips through the OS temp directory rather than a pipe.
 * That is the one moment plaintext touches disk, it is outside the library,
 * and it is deleted immediately.
 */
async function getEncrypted(library, absPath, relPath, stat, variant, fileKey, masterKey) {
  // Required lazily: lib/crypto/vaultfile pulls in nothing heavy, but this
  // keeps the non-vault path free of it entirely.
  // eslint-disable-next-line global-require
  const vaultfile = require('./crypto/vaultfile');

  if (!VARIANTS[variant]) variant = 'grid';
  const kind = kindOf(absPath);
  if (kind !== 'image' && kind !== 'video') return null;

  const thumbKey = thumbKeyFor(masterKey);
  const key = crypto.createHash('sha1')
    .update(`${relPath}:${stat.mtimeMs}:${stat.size}:${variant}:vault:v1`)
    .digest('hex');
  const target = cachePath(library, key);

  if (fs.existsSync(target)) return target;
  if (inFlight.has(key)) return inFlight.get(key);

  const work = schedule(async () => {
    if (fs.existsSync(target)) return target;

    const scratch = path.join(
      os.tmpdir(),
      `lanshare-thumb-${process.pid}-${crypto.randomBytes(6).toString('hex')}${path.extname(absPath)}`,
    );

    try {
      const meta = await vaultfile.readMetadata(absPath, fileKey);
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(scratch);
        const plain = vaultfile.createDecryptStream(absPath, fileKey, meta, {});
        plain.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        plain.pipe(out);
      });

      const buffer = await renderFromDecrypted(scratch, kind, variant);
      if (!buffer) return null;

      const sealed = sealThumb(buffer, thumbKey);
      await writeAtomic(target, sealed);
      return target;
    } finally {
      // Always, including on failure — a decrypted photo must not be left
      // lying in the temp directory because a render threw.
      await fsp.rm(scratch, { force: true }).catch(() => {});
    }
  }).catch((err) => {
    console.warn(`[thumb] ${relPath}: ${err.message}`);
    return null;
  }).finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, work);
  return work;
}

const THUMB_NONCE_LEN = 12;
const THUMB_TAG_LEN = 16;

function sealThumb(buffer, thumbKey) {
  const nonce = crypto.randomBytes(THUMB_NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', thumbKey, nonce);
  const body = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

function openThumb(sealed, thumbKey) {
  if (sealed.length < THUMB_NONCE_LEN + THUMB_TAG_LEN) {
    throw new Error('Encrypted thumbnail is malformed');
  }
  const nonce = sealed.subarray(0, THUMB_NONCE_LEN);
  const body = sealed.subarray(THUMB_NONCE_LEN, sealed.length - THUMB_TAG_LEN);
  const tag = sealed.subarray(sealed.length - THUMB_TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', thumbKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** A Readable of the decrypted tile, for piping straight to a response. */
async function openEncryptedThumb(thumbPath, masterKey) {
  const { Readable } = require('stream');
  const sealed = await fsp.readFile(thumbPath);
  const plain = openThumb(sealed, thumbKeyFor(masterKey));
  return Readable.from([plain]);
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

module.exports = {
  get,
  getEncrypted,
  openEncryptedThumb,
  describe,
  prune,
  cacheDir,
  VARIANTS,
  // exported for tests
  sealThumb,
  openThumb,
  thumbKeyFor,
};
