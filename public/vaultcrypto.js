/* =========================================================================
   Browser-side vault crypto for end-to-end encrypted albums.

   This is a second, independent implementation of the exact same on-disk
   format as lib/crypto/vaultfile.js and lib/crypto/vault.js — written
   against WebCrypto instead of Node's crypto, because for an end-to-end
   vault the server has no key and never will. Files are encrypted here
   before upload and decrypted here after download; the server only ever
   stores and returns opaque bytes.

   Two implementations of one format is a real risk: they can drift, and a
   drift means files that were encrypted on one side can never be read on
   the other. test/e2e-crypto.mjs exists precisely to catch that — it
   encrypts with each implementation and decrypts with the other, in both
   directions, over the byte sizes where the chunking boundaries land.

   Every constant and construction below mirrors lib/crypto/vaultfile.js.
   Change one and you must change the other; the cross-test will tell you if
   you forgot.

   Loaded as a plain script in the browser (window.LanShareVault) and
   required directly by the cross-implementation test in Node, which has the
   same WebCrypto API.
   ========================================================================= */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LanShareVault = api;
}(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const subtle = (globalThis.crypto || {}).subtle;

  const MAGIC = new TextEncoder().encode('LSVAULT1');
  const VERSION = 1;
  const CHUNK_SIZE = 1024 * 1024;
  const TAG_LEN = 16;
  const KEY_LEN = 32;
  const NONCE_PREFIX_LEN = 4;
  const NONCE_LEN = 12;
  const HEADER_LEN_BYTES = 4;
  const TRAILER_LEN = 8 + TAG_LEN;
  const CHECK_VALUE = 'lanshare-vault-check';

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  class VaultCryptoError extends Error {}

  // --- small helpers ------------------------------------------------------

  function concat(...parts) {
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  }

  function equalBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function toBase64(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function fromBase64(text) {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  function toHex(bytes) {
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function fromHex(text) {
    const out = new Uint8Array(text.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(text.substr(i * 2, 2), 16);
    return out;
  }

  function writeU32BE(value) {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, false);
    return out;
  }

  function writeU64BE(value) {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
    return out;
  }

  function readU64BE(bytes) {
    return Number(new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, false));
  }

  async function sha256(bytes) {
    return new Uint8Array(await subtle.digest('SHA-256', bytes));
  }

  async function importAesKey(raw) {
    return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  /**
   * WebCrypto returns ciphertext and tag as one buffer, which happens to be
   * exactly the layout Node's cipher.update()+getAuthTag() produces when
   * concatenated. That is why the two implementations interoperate without
   * either side reshuffling bytes.
   */
  async function gcmEncrypt(key, nonce, aad, plaintext) {
    const params = { name: 'AES-GCM', iv: nonce, tagLength: TAG_LEN * 8 };
    if (aad) params.additionalData = aad;
    return new Uint8Array(await subtle.encrypt(params, key, plaintext));
  }

  async function gcmDecrypt(key, nonce, aad, blob) {
    const params = { name: 'AES-GCM', iv: nonce, tagLength: TAG_LEN * 8 };
    if (aad) params.additionalData = aad;
    try {
      return new Uint8Array(await subtle.decrypt(params, key, blob));
    } catch {
      throw new VaultCryptoError('Decryption failed — wrong key, or the data was altered');
    }
  }

  // --- key derivation and wrapping ---------------------------------------
  // Mirrors lib/crypto/vault.js.

  async function deriveKek(passphrase, salt, iterations) {
    // NFKC so the same typed passphrase derives the same key regardless of
    // how the OS composed its accented characters — matches the Node side.
    const material = await subtle.importKey(
      'raw', encoder.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveBits'],
    );
    const bits = await subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-512' }, material, KEY_LEN * 8,
    );
    return new Uint8Array(bits);
  }

  /** nonce || ciphertext || tag */
  async function unwrap(rawKey, blob, aad) {
    if (blob.length < NONCE_LEN + TAG_LEN) throw new VaultCryptoError('Wrapped key is malformed');
    const key = await importAesKey(rawKey);
    return gcmDecrypt(key, blob.subarray(0, NONCE_LEN), aad, blob.subarray(NONCE_LEN));
  }

  async function wrap(rawKey, plaintext, aad) {
    const key = await importAesKey(rawKey);
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
    return concat(nonce, await gcmEncrypt(key, nonce, aad, plaintext));
  }

  const keyEntryAad = (vaultId, entryId) => encoder.encode(`lanshare-vault:${vaultId}:${entryId}`);
  const checkAad = (vaultId) => encoder.encode(`lanshare-vault-check:${vaultId}`);

  /**
   * Recover a vault's master key from a passphrase, entirely in the browser.
   * Tries every key entry, exactly as the server does, because nothing says
   * in advance which entry a given passphrase belongs to.
   */
  async function unlockVault(metadata, passphrase) {
    if (!metadata?.keys?.length) throw new VaultCryptoError('This vault has no keys');

    for (const entry of metadata.keys) {
      const salt = fromBase64(entry.salt);
      // eslint-disable-next-line no-await-in-loop
      const kek = await deriveKek(passphrase, salt, metadata.kdf.iterations);
      try {
        // eslint-disable-next-line no-await-in-loop
        return await unwrap(kek, fromBase64(entry.wrapped), keyEntryAad(metadata.id, entry.id));
      } catch {
        // Wrong entry for this passphrase; try the next.
      }
    }
    throw new VaultCryptoError('Wrong passphrase');
  }

  /**
   * Confirms a raw master key really belongs to this vault.
   *
   * A failed unwrap here means the wrong key, not tampering, so it is
   * reported with the same wording lib/crypto/vault.js uses rather than the
   * generic decryption error — two implementations of one format should
   * fail the same way, or the same mistake reads as two different problems
   * depending on which side hit it.
   */
  async function verifyMasterKey(metadata, masterKey) {
    if (!metadata?.check) throw new VaultCryptoError('This vault is missing its verification value');
    let value;
    try {
      value = await unwrap(masterKey, fromBase64(metadata.check), checkAad(metadata.id));
    } catch {
      throw new VaultCryptoError('That key does not belong to this vault');
    }
    if (decoder.decode(value) !== CHECK_VALUE) {
      throw new VaultCryptoError('That key does not belong to this vault');
    }
    return true;
  }

  async function newFileKey(masterKey) {
    const fileKey = crypto.getRandomValues(new Uint8Array(KEY_LEN));
    return { fileKey, wrappedKey: await wrap(masterKey, fileKey) };
  }

  const unwrapFileKey = (masterKey, wrappedKey) => unwrap(masterKey, wrappedKey);

  // --- the file format ----------------------------------------------------
  // Mirrors lib/crypto/vaultfile.js.

  function buildHeader({ fileId, wrappedKey, noncePrefix, chunkSize }) {
    const json = JSON.stringify({
      v: VERSION,
      fileId: toHex(fileId),
      wrappedKey: toBase64(wrappedKey),
      noncePrefix: toBase64(noncePrefix),
      chunkSize,
    });
    const jsonBytes = encoder.encode(json);
    return concat(MAGIC, writeU32BE(jsonBytes.length), jsonBytes);
  }

  function parseHeader(bytes) {
    if (bytes.length < MAGIC.length + HEADER_LEN_BYTES) {
      throw new VaultCryptoError('Not a vault file (too short)');
    }
    if (!equalBytes(bytes.subarray(0, MAGIC.length), MAGIC)) {
      throw new VaultCryptoError('Not a vault file (bad magic)');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const jsonLen = view.getUint32(MAGIC.length, false);
    const start = MAGIC.length + HEADER_LEN_BYTES;
    if (bytes.length < start + jsonLen) throw new VaultCryptoError('Vault file header is truncated');

    const headerBytes = bytes.subarray(0, start + jsonLen);
    const parsed = JSON.parse(decoder.decode(bytes.subarray(start, start + jsonLen)));
    if (parsed.v !== VERSION) throw new VaultCryptoError(`Unsupported vault file version: ${parsed.v}`);

    return {
      header: {
        fileId: fromHex(parsed.fileId),
        wrappedKey: fromBase64(parsed.wrappedKey),
        noncePrefix: fromBase64(parsed.noncePrefix),
        chunkSize: parsed.chunkSize,
      },
      headerBytes,
      dataOffset: headerBytes.length,
    };
  }

  function chunkNonce(noncePrefix, index) {
    return concat(noncePrefix.subarray(0, NONCE_PREFIX_LEN), writeU64BE(index));
  }

  function trailerNonce(noncePrefix) {
    // The reserved maximum counter, never reachable by a chunk.
    return concat(noncePrefix.subarray(0, NONCE_PREFIX_LEN), new Uint8Array(8).fill(0xff));
  }

  function chunkAad(hHash, index, isFinal) {
    return concat(hHash, writeU32BE(index), new Uint8Array([isFinal ? 1 : 0]));
  }

  const trailerAad = (hHash) => concat(hHash, encoder.encode('trailer'));

  /**
   * Encrypt a whole file in the browser, producing bytes the server stores
   * untouched and lib/crypto/vaultfile.js can read.
   *
   * Deliberately buffers the result rather than streaming: an end-to-end
   * album is download-only anyway, browsers cannot stream a request body
   * without HTTP/2 duplex, and the files these albums hold are documents
   * rather than 4K video. If that stops being true, this is the place to
   * revisit.
   */
  async function encryptFile(plaintext, masterKey, { chunkSize = CHUNK_SIZE } = {}) {
    const data = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext);
    const { fileKey, wrappedKey } = await newFileKey(masterKey);
    const fileId = crypto.getRandomValues(new Uint8Array(16));
    const noncePrefix = crypto.getRandomValues(new Uint8Array(NONCE_PREFIX_LEN));

    const headerBytes = buildHeader({ fileId, wrappedKey, noncePrefix, chunkSize });
    const hHash = await sha256(headerBytes);
    const key = await importAesKey(fileKey);

    const parts = [headerBytes];
    // Always at least one chunk, even for an empty file, so "truncated to
    // nothing" stays distinguishable from "genuinely empty".
    const chunkCount = data.length === 0 ? 1 : Math.ceil(data.length / chunkSize);
    for (let index = 0; index < chunkCount; index++) {
      const slice = data.subarray(index * chunkSize, Math.min((index + 1) * chunkSize, data.length));
      const isFinal = index === chunkCount - 1;
      // eslint-disable-next-line no-await-in-loop
      parts.push(await gcmEncrypt(key, chunkNonce(noncePrefix, index), chunkAad(hHash, index, isFinal), slice));
    }

    parts.push(await gcmEncrypt(key, trailerNonce(noncePrefix), trailerAad(hHash), writeU64BE(data.length)));
    return concat(...parts);
  }

  /** Decrypt a whole vault file in the browser. */
  async function decryptFile(fileBytes, masterKey) {
    const bytes = fileBytes instanceof Uint8Array ? fileBytes : new Uint8Array(fileBytes);
    const { header, headerBytes, dataOffset } = parseHeader(bytes);
    const hHash = await sha256(headerBytes);

    const fileKey = await unwrapFileKey(masterKey, header.wrappedKey);
    const key = await importAesKey(fileKey);

    if (bytes.length < dataOffset + TRAILER_LEN) {
      throw new VaultCryptoError('Vault file is truncated (no trailer)');
    }

    const trailerBlob = bytes.subarray(bytes.length - TRAILER_LEN);
    const sizeBytes = await gcmDecrypt(key, trailerNonce(header.noncePrefix), trailerAad(hHash), trailerBlob);
    const plaintextSize = readU64BE(sizeBytes);

    const { chunkSize } = header;
    const chunkCount = plaintextSize === 0 ? 1 : Math.ceil(plaintextSize / chunkSize);

    // Same cross-check the Node side makes: a trailer that authenticates but
    // disagrees with the actual file length must not be believed.
    const expected = plaintextSize + chunkCount * TAG_LEN;
    if (bytes.length - dataOffset - TRAILER_LEN !== expected) {
      throw new VaultCryptoError('Vault file length does not match its trailer');
    }

    const out = new Uint8Array(plaintextSize);
    let at = dataOffset;
    let written = 0;
    for (let index = 0; index < chunkCount; index++) {
      const isFinal = index === chunkCount - 1;
      const plainLen = isFinal ? plaintextSize - index * chunkSize : chunkSize;
      const stored = plainLen + TAG_LEN;
      // eslint-disable-next-line no-await-in-loop
      const plain = await gcmDecrypt(
        key, chunkNonce(header.noncePrefix, index), chunkAad(hHash, index, isFinal),
        bytes.subarray(at, at + stored),
      );
      out.set(plain, written);
      written += plain.length;
      at += stored;
    }
    return out;
  }

  return {
    VaultCryptoError,
    CHUNK_SIZE,
    KEY_LEN,
    available: Boolean(subtle),
    unlockVault,
    verifyMasterKey,
    encryptFile,
    decryptFile,
    // exported for the cross-implementation test
    deriveKek,
    newFileKey,
    unwrapFileKey,
    parseHeader,
  };
}));
