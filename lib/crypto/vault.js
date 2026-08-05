'use strict';

/**
 * Vault keys: deriving them from a passphrase, wrapping them, and sharing
 * them.
 *
 * Envelope encryption, three layers deep:
 *
 *   passphrase --PBKDF2--> key-encryption key --wraps--> vault master key
 *                                             --wraps--> per-file key
 *
 * The point of the middle layer is that the vault master key is never
 * derived from the passphrase — it is random, and the passphrase only ever
 * unwraps it. That is what makes a vault able to hold a *list* of wrapped
 * copies of the same master key, one per passphrase. Adding a second
 * passphrase, or issuing a recovery code, is then just another entry in that
 * list rather than re-encrypting every file in the album. Changing a
 * passphrase is likewise cheap.
 *
 * PBKDF2-HMAC-SHA512 at 600k iterations is the KDF, not scrypt, even though
 * scrypt resists custom hardware better and is what account logins already
 * use. The reason is Phase B's end-to-end vault type: the browser has to
 * derive the *same* key, and WebCrypto has PBKDF2 but no scrypt. One shared
 * derivation both sides can perform is worth more here than the margin, and
 * it avoids shipping a wasm KDF into the client.
 *
 * The threat model is a stolen drive or a stolen cloud copy — someone
 * holding the ciphertext at rest. It is not a defence against someone with
 * live access to the machine while a vault is unlocked.
 */

const crypto = require('crypto');
const { promisify } = require('util');

const pbkdf2 = promisify(crypto.pbkdf2);

const VERSION = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const DEFAULT_ITERATIONS = 600_000;
const KDF_HASH = 'sha512';

const VAULT_TYPES = ['server', 'e2e'];

class VaultError extends Error {}

// ---------------------------------------------------------------------------
// Key derivation and wrapping
// ---------------------------------------------------------------------------

async function deriveKek(passphrase, salt, iterations) {
  if (typeof passphrase !== 'string' || !passphrase) {
    throw new VaultError('A passphrase is required');
  }
  // Normalize so the same typed passphrase derives the same key regardless
  // of how the OS or browser happened to compose its accented characters.
  const normalized = passphrase.normalize('NFKC');
  return pbkdf2(normalized, salt, iterations, KEY_LEN, KDF_HASH);
}

/** nonce || ciphertext || tag, as one opaque blob. */
function wrap(key, plaintext, aad) {
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  if (aad) cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

function unwrap(key, blob, aad) {
  if (!Buffer.isBuffer(blob) || blob.length < NONCE_LEN + TAG_LEN) {
    throw new VaultError('Wrapped key is malformed');
  }
  const nonce = blob.subarray(0, NONCE_LEN);
  const body = blob.subarray(NONCE_LEN, blob.length - TAG_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new VaultError('Wrong passphrase, or this key does not belong to this vault');
  }
}

/**
 * Binds a wrapped master key to the vault it belongs to, so an entry cannot
 * be lifted out of one vault's metadata and pasted into another's to make
 * that passphrase open a vault it was never granted.
 */
function keyEntryAad(vaultId, entryId) {
  return Buffer.from(`lanshare-vault:${vaultId}:${entryId}`, 'utf8');
}

// A known plaintext encrypted under the master key at creation. It is the
// only way to tell a correct recovery code from 32 unrelated random bytes,
// since a recovery code is the master key itself and so unwraps nothing.
const CHECK_VALUE = 'lanshare-vault-check';

function checkAad(vaultId) {
  return Buffer.from(`lanshare-vault-check:${vaultId}`, 'utf8');
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

// Crockford base32: no I, L, O or U, so a handwritten code cannot be misread
// as a different one and there is no case ambiguity.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function toBase32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(text) {
  const clean = String(text || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    // Accept the characters Crockford deliberately excludes, mapped to what
    // the writer almost certainly meant.
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');

  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index === -1) throw new VaultError('That recovery code contains invalid characters');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Grouped into fours purely so a human can read it back accurately. */
function formatRecoveryCode(masterKey) {
  return toBase32(masterKey).match(/.{1,4}/g).join('-');
}

function parseRecoveryCode(code) {
  const key = fromBase32(code);
  if (key.length !== KEY_LEN) {
    throw new VaultError('That recovery code is not the right length');
  }
  return key;
}

// ---------------------------------------------------------------------------
// Vault metadata
// ---------------------------------------------------------------------------

/**
 * Create a new vault. Returns the metadata to persist alongside the album
 * and the master key to use immediately — the master key is never stored,
 * only wrapped copies of it.
 */
async function createVault({ passphrase, type = 'server', label = 'Passphrase', iterations = DEFAULT_ITERATIONS }) {
  if (!VAULT_TYPES.includes(type)) {
    throw new VaultError(`Vault type must be one of: ${VAULT_TYPES.join(', ')}`);
  }
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    // Longer than an account password: this one guards data at rest, where
    // an attacker can grind offline for as long as they like.
    throw new VaultError('A vault passphrase must be at least 8 characters');
  }

  const masterKey = crypto.randomBytes(KEY_LEN);
  const vaultId = crypto.randomBytes(16).toString('hex');

  const metadata = {
    v: VERSION,
    id: vaultId,
    type,
    created: new Date().toISOString(),
    kdf: { name: 'pbkdf2', hash: KDF_HASH, iterations },
    check: wrap(masterKey, Buffer.from(CHECK_VALUE, 'utf8'), checkAad(vaultId)).toString('base64'),
    keys: [],
  };

  await addKey(metadata, masterKey, { passphrase, label });
  return { metadata, masterKey };
}

/**
 * Add another way to unlock an existing vault — a second passphrase, or a
 * shared one for someone else. Requires the master key, so only somebody who
 * can already open the vault can grant access to it.
 */
async function addKey(metadata, masterKey, { passphrase, label = 'Passphrase' }) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== KEY_LEN) {
    throw new VaultError('A valid master key is required to add a passphrase');
  }
  const entryId = crypto.randomBytes(8).toString('hex');
  const salt = crypto.randomBytes(SALT_LEN);
  const kek = await deriveKek(passphrase, salt, metadata.kdf.iterations);

  metadata.keys.push({
    id: entryId,
    label,
    salt: salt.toString('base64'),
    wrapped: wrap(kek, masterKey, keyEntryAad(metadata.id, entryId)).toString('base64'),
    created: new Date().toISOString(),
  });
  return metadata;
}

/**
 * Unlock a vault with a passphrase.
 *
 * Tries every key entry, because there is no way to know in advance which
 * one a given passphrase belongs to — and deliberately no per-entry hint
 * that would let someone narrow it down offline. Each attempt costs a full
 * PBKDF2 derivation, which is why vaults are expected to hold a handful of
 * entries, not hundreds.
 */
async function unlock(metadata, passphrase) {
  if (!metadata?.keys?.length) throw new VaultError('This vault has no keys');

  for (const entry of metadata.keys) {
    const salt = Buffer.from(entry.salt, 'base64');
    // eslint-disable-next-line no-await-in-loop
    const kek = await deriveKek(passphrase, salt, metadata.kdf.iterations);
    try {
      return unwrap(kek, Buffer.from(entry.wrapped, 'base64'), keyEntryAad(metadata.id, entry.id));
    } catch {
      // Wrong entry for this passphrase; try the next.
    }
  }
  throw new VaultError('Wrong passphrase');
}

/**
 * Unlock with an exported recovery code instead of a passphrase.
 *
 * A recovery code *is* the master key, so there is nothing to unwrap to
 * prove it. That is exactly why the vault stores a `check` blob — a known
 * value encrypted under the master key at creation. Without it, any 32
 * random bytes would appear to "unlock" the vault and then fail
 * incomprehensibly on the first file instead of saying the code is wrong.
 */
function unlockWithRecoveryCode(metadata, code) {
  const masterKey = parseRecoveryCode(code);
  verifyMasterKey(metadata, masterKey);
  return masterKey;
}

/** Throws unless `masterKey` really is this vault's master key. */
function verifyMasterKey(metadata, masterKey) {
  if (!metadata?.check) {
    throw new VaultError('This vault is missing its verification value');
  }
  try {
    const value = unwrap(masterKey, Buffer.from(metadata.check, 'base64'), checkAad(metadata.id));
    if (value.toString('utf8') !== CHECK_VALUE) throw new Error('mismatch');
  } catch {
    throw new VaultError('That key does not belong to this vault');
  }
}

function removeKey(metadata, entryId) {
  const index = metadata.keys.findIndex((k) => k.id === entryId);
  if (index < 0) throw new VaultError('No such key');
  if (metadata.keys.length <= 1) {
    // Removing the only way in would make the album permanently unreadable,
    // which is a far worse outcome than refusing.
    throw new VaultError('Cannot remove the only way to unlock this vault — add another passphrase first');
  }
  metadata.keys.splice(index, 1);
  return metadata;
}

// ---------------------------------------------------------------------------
// Per-file keys
// ---------------------------------------------------------------------------

/**
 * A fresh random key for one file, plus that key wrapped under the vault
 * master key for storage in the file's own header. Per-file keys mean the
 * chunk nonce counter restarts safely for every file.
 */
function createFileKey(masterKey) {
  const fileKey = crypto.randomBytes(KEY_LEN);
  return { fileKey, wrappedKey: wrap(masterKey, fileKey) };
}

function unwrapFileKey(masterKey, wrappedKey) {
  const fileKey = unwrap(masterKey, wrappedKey);
  if (fileKey.length !== KEY_LEN) throw new VaultError('Unwrapped file key is the wrong size');
  return fileKey;
}

module.exports = {
  VaultError,
  VAULT_TYPES,
  KEY_LEN,
  DEFAULT_ITERATIONS,
  createVault,
  unlock,
  unlockWithRecoveryCode,
  verifyMasterKey,
  addKey,
  removeKey,
  createFileKey,
  unwrapFileKey,
  formatRecoveryCode,
  parseRecoveryCode,
  // exported for tests
  deriveKek,
  wrap,
  unwrap,
  toBase32,
  fromBase32,
};
