'use strict';

/**
 * The on-disk format for a file inside an encrypted vault.
 *
 * Encrypting a file as one AES-GCM blob would be simpler, but it would also
 * break video seeking: you cannot decrypt byte 500 MB into a stream without
 * decrypting everything before it, and iOS Safari will not play a video at
 * all without working range requests. So the plaintext is split into fixed
 * 1 MiB chunks, each encrypted independently. A byte range maps to a chunk
 * range, and only those chunks get decrypted.
 *
 *   "LSVAULT1" | u32 headerLen | header JSON
 *              | chunk 0 | chunk 1 | ... | chunk n
 *              | trailer
 *
 * Each chunk is ciphertext followed by its 16-byte GCM tag. Independent
 * chunks are the whole point, but they are also the danger: without binding
 * each one to its position, an attacker with disk access could reorder them,
 * swap chunk 3 of one file for chunk 3 of another (same key, same nonce
 * counter), or lop off the end of the file, and every remaining chunk would
 * still authenticate perfectly. Three things prevent that, all carried in
 * each chunk's AAD rather than in the encrypted data:
 *
 *   - a hash of the header, which contains a per-file random id, so chunks
 *     are not interchangeable between files even under the same vault key
 *   - the chunk index, so chunks cannot be reordered within a file
 *   - an end-of-file flag, so the last chunk cannot be silently dropped
 *
 * The trailer holds the plaintext length, encrypted and authenticated. It
 * lives at the end rather than in the header because the length is not known
 * until the upload finishes streaming, and the header is already sealed into
 * every chunk's AAD by then. Its presence is mandatory, which is what makes
 * truncating a file down to zero chunks detectable rather than looking like
 * an ordinary empty file.
 *
 * This module deliberately knows nothing about passphrases or vaults. It is
 * handed a raw file key and an opaque already-wrapped copy of that key to
 * embed; lib/crypto/vault.js owns everything to do with deriving and
 * wrapping keys.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const { Transform, Readable } = require('stream');

const MAGIC = Buffer.from('LSVAULT1', 'ascii');
const VERSION = 1;
const CHUNK_SIZE = 1024 * 1024;
const TAG_LEN = 16;
const KEY_LEN = 32;
// 12 bytes total: a 4-byte per-file random prefix plus an 8-byte counter.
// The prefix is belt-and-braces — every file already has its own key, so the
// counter alone would not repeat — but it costs nothing.
const NONCE_PREFIX_LEN = 4;
const NONCE_LEN = 12;
const HEADER_LEN_BYTES = 4;
// Refuse absurd header lengths rather than trying to allocate them; a
// corrupt or hostile file should fail fast, not exhaust memory.
const MAX_HEADER_LEN = 64 * 1024;

class VaultFileError extends Error {}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function buildHeader({ fileId, wrappedKey, noncePrefix, chunkSize = CHUNK_SIZE }) {
  const json = JSON.stringify({
    v: VERSION,
    fileId: fileId.toString('hex'),
    wrappedKey: wrappedKey.toString('base64'),
    noncePrefix: noncePrefix.toString('base64'),
    chunkSize,
  });
  const jsonBytes = Buffer.from(json, 'utf8');
  const lenBytes = Buffer.alloc(HEADER_LEN_BYTES);
  lenBytes.writeUInt32BE(jsonBytes.length, 0);
  return Buffer.concat([MAGIC, lenBytes, jsonBytes]);
}

/**
 * The AAD prefix every chunk and the trailer are bound to. Hashing the whole
 * header means changing any field in it — the wrapped key, the chunk size,
 * the file id — invalidates every chunk in the file rather than going
 * unnoticed.
 */
function headerHash(headerBytes) {
  return crypto.createHash('sha256').update(headerBytes).digest();
}

function parseHeader(buf) {
  if (buf.length < MAGIC.length + HEADER_LEN_BYTES) {
    throw new VaultFileError('Not a vault file (too short)');
  }
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new VaultFileError('Not a vault file (bad magic)');
  }
  const jsonLen = buf.readUInt32BE(MAGIC.length);
  if (jsonLen === 0 || jsonLen > MAX_HEADER_LEN) {
    throw new VaultFileError('Vault file header is not a plausible size');
  }
  const start = MAGIC.length + HEADER_LEN_BYTES;
  if (buf.length < start + jsonLen) {
    throw new VaultFileError('Vault file header is truncated');
  }

  const headerBytes = buf.subarray(0, start + jsonLen);
  let parsed;
  try {
    parsed = JSON.parse(buf.subarray(start, start + jsonLen).toString('utf8'));
  } catch {
    throw new VaultFileError('Vault file header is not valid JSON');
  }
  if (parsed.v !== VERSION) {
    throw new VaultFileError(`Unsupported vault file version: ${parsed.v}`);
  }

  const chunkSize = Number(parsed.chunkSize);
  if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize > 64 * 1024 * 1024) {
    throw new VaultFileError('Vault file declares an implausible chunk size');
  }

  return {
    header: {
      fileId: Buffer.from(parsed.fileId, 'hex'),
      wrappedKey: Buffer.from(parsed.wrappedKey, 'base64'),
      noncePrefix: Buffer.from(parsed.noncePrefix, 'base64'),
      chunkSize,
    },
    headerBytes,
    dataOffset: headerBytes.length,
  };
}

// ---------------------------------------------------------------------------
// Nonces and AAD
// ---------------------------------------------------------------------------

function chunkNonce(noncePrefix, index) {
  const nonce = Buffer.alloc(NONCE_LEN);
  noncePrefix.copy(nonce, 0, 0, NONCE_PREFIX_LEN);
  // 8-byte big-endian counter. A file would need 2^64 chunks to wrap.
  nonce.writeBigUInt64BE(BigInt(index), NONCE_PREFIX_LEN);
  return nonce;
}

/** The trailer uses the reserved maximum counter, never reachable by a chunk. */
function trailerNonce(noncePrefix) {
  const nonce = Buffer.alloc(NONCE_LEN);
  noncePrefix.copy(nonce, 0, 0, NONCE_PREFIX_LEN);
  nonce.writeBigUInt64BE(0xffffffffffffffffn, NONCE_PREFIX_LEN);
  return nonce;
}

function chunkAad(hHash, index, isFinal) {
  const meta = Buffer.alloc(5);
  meta.writeUInt32BE(index, 0);
  meta.writeUInt8(isFinal ? 1 : 0, 4);
  return Buffer.concat([hHash, meta]);
}

function trailerAad(hHash) {
  return Buffer.concat([hHash, Buffer.from('trailer', 'ascii')]);
}

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

function encryptChunk(fileKey, noncePrefix, hHash, index, isFinal, plaintext) {
  const cipher = crypto.createCipheriv('aes-256-gcm', fileKey, chunkNonce(noncePrefix, index));
  cipher.setAAD(chunkAad(hHash, index, isFinal));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

function encryptTrailer(fileKey, noncePrefix, hHash, plaintextSize) {
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(plaintextSize));
  const cipher = crypto.createCipheriv('aes-256-gcm', fileKey, trailerNonce(noncePrefix));
  cipher.setAAD(trailerAad(hHash));
  const body = Buffer.concat([cipher.update(size), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

const TRAILER_LEN = 8 + TAG_LEN;

/**
 * A Transform that takes plaintext in and emits a complete vault file.
 *
 * Chunks are held back by one: a chunk is only emitted once we know whether
 * more data follows it, because that determines the end-of-file flag baked
 * into its AAD. The cost is one chunk of buffering.
 */
function createEncryptStream({ fileKey, wrappedKey, chunkSize = CHUNK_SIZE }) {
  if (!Buffer.isBuffer(fileKey) || fileKey.length !== KEY_LEN) {
    throw new VaultFileError('fileKey must be 32 bytes');
  }

  const fileId = crypto.randomBytes(16);
  const noncePrefix = crypto.randomBytes(NONCE_PREFIX_LEN);
  const headerBytes = buildHeader({ fileId, wrappedKey, noncePrefix, chunkSize });
  const hHash = headerHash(headerBytes);

  let pending = Buffer.alloc(0);
  let index = 0;
  let plaintextSize = 0;
  let headerWritten = false;

  return new Transform({
    transform(piece, _enc, done) {
      try {
        if (!headerWritten) { this.push(headerBytes); headerWritten = true; }
        plaintextSize += piece.length;
        pending = pending.length ? Buffer.concat([pending, piece]) : piece;

        // Strictly greater: a buffer of exactly chunkSize might still be the
        // final chunk, and we cannot know until more data arrives or the
        // stream ends.
        while (pending.length > chunkSize) {
          this.push(encryptChunk(fileKey, noncePrefix, hHash, index, false, pending.subarray(0, chunkSize)));
          pending = pending.subarray(chunkSize);
          index++;
        }
        done();
      } catch (err) {
        done(err);
      }
    },

    flush(done) {
      try {
        if (!headerWritten) { this.push(headerBytes); headerWritten = true; }
        // Always emit at least one chunk, even for an empty file, so a file
        // is never zero chunks — that keeps "truncated to nothing" and
        // "genuinely empty" distinguishable.
        this.push(encryptChunk(fileKey, noncePrefix, hHash, index, true, pending));
        this.push(encryptTrailer(fileKey, noncePrefix, hHash, plaintextSize));
        done();
      } catch (err) {
        done(err);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Decryption
// ---------------------------------------------------------------------------

function chunkCountFor(plaintextSize, chunkSize) {
  return plaintextSize === 0 ? 1 : Math.ceil(plaintextSize / chunkSize);
}

function decryptChunk(fileKey, noncePrefix, hHash, index, isFinal, blob) {
  if (blob.length < TAG_LEN) throw new VaultFileError('Vault chunk is truncated');
  const body = blob.subarray(0, blob.length - TAG_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', fileKey, chunkNonce(noncePrefix, index));
  decipher.setAAD(chunkAad(hHash, index, isFinal));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    // Deliberately vague: a caller cannot tell a wrong key from a tampered
    // chunk, and does not need to.
    throw new VaultFileError(`Vault chunk ${index} failed authentication`);
  }
}

/**
 * Read just the header, which needs no key.
 *
 * This is how a caller gets at the wrapped file key in order to unwrap it
 * and then call readMetadata properly. The header is not secret — it holds
 * the wrapped key, a random file id and the chunk size, none of which reveal
 * anything about the contents — but it *is* authenticated, because its hash
 * is baked into every chunk's AAD, so tampering with it invalidates the
 * whole file.
 */
async function readHeader(filePath) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const probe = Buffer.alloc(Math.min(MAX_HEADER_LEN, size));
    await fh.read(probe, 0, probe.length, 0);
    return parseHeader(probe);
  } finally {
    await fh.close();
  }
}

/** True if this file looks like a vault file at all (cheap magic check). */
async function isVaultFile(filePath) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const probe = Buffer.alloc(MAGIC.length);
    const { bytesRead } = await fh.read(probe, 0, MAGIC.length, 0);
    return bytesRead === MAGIC.length && probe.equals(MAGIC);
  } catch {
    return false;
  } finally {
    await fh.close();
  }
}

/**
 * Read and verify a vault file's header and trailer.
 * Returns everything a ranged read needs, without decrypting any content.
 */
async function readMetadata(filePath, fileKey) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const { size: fileSize } = await fh.stat();

    // The header is small but variable-length; one generous read covers it.
    const probe = Buffer.alloc(Math.min(MAX_HEADER_LEN, fileSize));
    await fh.read(probe, 0, probe.length, 0);
    const { header, headerBytes, dataOffset } = parseHeader(probe);
    const hHash = headerHash(headerBytes);

    if (fileSize < dataOffset + TRAILER_LEN) {
      throw new VaultFileError('Vault file is truncated (no trailer)');
    }

    const trailerBlob = Buffer.alloc(TRAILER_LEN);
    await fh.read(trailerBlob, 0, TRAILER_LEN, fileSize - TRAILER_LEN);

    const body = trailerBlob.subarray(0, 8);
    const tag = trailerBlob.subarray(8);
    const decipher = crypto.createDecipheriv('aes-256-gcm', fileKey, trailerNonce(header.noncePrefix));
    decipher.setAAD(trailerAad(hHash));
    decipher.setAuthTag(tag);
    let sizeBytes;
    try {
      sizeBytes = Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      throw new VaultFileError('Vault file trailer failed authentication');
    }

    const plaintextSize = Number(sizeBytes.readBigUInt64BE());
    const chunkCount = chunkCountFor(plaintextSize, header.chunkSize);

    // Cross-check the declared size against the actual encrypted length, so a
    // trailer that authenticates but disagrees with the file cannot slip past.
    const expectedData = plaintextSize + chunkCount * TAG_LEN;
    if (fileSize - dataOffset - TRAILER_LEN !== expectedData) {
      throw new VaultFileError('Vault file length does not match its trailer');
    }

    return { header, headerBytes, hHash, dataOffset, plaintextSize, chunkCount, fileSize };
  } finally {
    await fh.close();
  }
}

/** Byte offset of chunk `index` within the file. */
function chunkOffset(meta, index) {
  return meta.dataOffset + index * (meta.header.chunkSize + TAG_LEN);
}

/** Encrypted length of chunk `index` (plaintext bytes plus its tag). */
function chunkStoredLength(meta, index) {
  const { chunkSize } = meta.header;
  const isLast = index === meta.chunkCount - 1;
  if (!isLast) return chunkSize + TAG_LEN;
  const remainder = meta.plaintextSize - (meta.chunkCount - 1) * chunkSize;
  return remainder + TAG_LEN;
}

/**
 * A Readable of decrypted plaintext for the byte range [start, end]
 * inclusive, decrypting only the chunks that range actually touches.
 *
 * `meta` comes from readMetadata(); passing it in rather than re-reading it
 * keeps a range request to a single extra open.
 */
function createDecryptStream(filePath, fileKey, meta, { start = 0, end } = {}) {
  const last = end === undefined ? meta.plaintextSize - 1 : end;

  if (meta.plaintextSize === 0 || start > last || start < 0) {
    return Readable.from([]);
  }

  const { chunkSize } = meta.header;
  const firstChunk = Math.floor(start / chunkSize);
  const lastChunk = Math.min(Math.floor(last / chunkSize), meta.chunkCount - 1);

  async function* generate() {
    const fh = await fsp.open(filePath, 'r');
    try {
      for (let index = firstChunk; index <= lastChunk; index++) {
        const stored = chunkStoredLength(meta, index);
        const blob = Buffer.alloc(stored);
        await fh.read(blob, 0, stored, chunkOffset(meta, index));

        const isFinal = index === meta.chunkCount - 1;
        const plain = decryptChunk(fileKey, meta.header.noncePrefix, meta.hHash, index, isFinal, blob);

        // Trim the first and last chunks down to the requested range.
        const chunkStart = index * chunkSize;
        const from = Math.max(0, start - chunkStart);
        const to = Math.min(plain.length, last - chunkStart + 1);
        yield plain.subarray(from, to);
      }
    } finally {
      await fh.close();
    }
  }

  return Readable.from(generate());
}

/** Convenience for small files and tests: decrypt the whole thing to a Buffer. */
async function decryptToBuffer(filePath, fileKey) {
  const meta = await readMetadata(filePath, fileKey);
  const parts = [];
  for await (const piece of createDecryptStream(filePath, fileKey, meta)) parts.push(piece);
  return Buffer.concat(parts);
}

/** Convenience for tests: encrypt a Buffer straight to a file. */
async function encryptBufferToFile(plaintext, filePath, { fileKey, wrappedKey, chunkSize }) {
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(filePath);
    const enc = createEncryptStream({ fileKey, wrappedKey, chunkSize });
    enc.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    enc.pipe(out);
    enc.end(plaintext);
  });
}

module.exports = {
  VaultFileError,
  CHUNK_SIZE,
  KEY_LEN,
  TAG_LEN,
  TRAILER_LEN,
  MAGIC,
  createEncryptStream,
  createDecryptStream,
  readHeader,
  isVaultFile,
  readMetadata,
  decryptToBuffer,
  encryptBufferToFile,
  // exported for tests
  parseHeader,
  buildHeader,
  headerHash,
  chunkOffset,
  chunkStoredLength,
};
