'use strict';

/**
 * Turning an album into an encrypted vault, and holding the keys to it while
 * it is unlocked.
 *
 * A vault is just an album with a `.lanshare-vault.json` beside its
 * contents. Keeping the metadata *inside* the album is deliberate: it means
 * a vault survives being moved to another drive, copied to Google Drive, or
 * synced to an external disk (Phases C and D) without anything else having
 * to know it existed. The leading dot keeps it out of the gallery, which
 * already skips dotfiles.
 *
 * Unlocked master keys live in this module's memory and nowhere else. They
 * are never written to disk, never logged, and are dropped on an inactivity
 * timer and whenever the server stops.
 *
 * ---------------------------------------------------------------------------
 * What this protects, and what it does not
 *
 * File *contents* are encrypted. File *names*, folder structure, file sizes
 * and modification times are not — they are ordinary directory entries on
 * disk. Someone holding a stolen drive can see that an album contains
 * "passport-scan.jpg" of 2.4 MB, just not what is in it.
 *
 * That is a real limitation and it is recorded rather than hidden. Fixing it
 * means storing files under opaque ids with an encrypted manifest mapping
 * them back to real names, which touches listing, sorting, thumbnails,
 * rename, move and zip — a bigger change than this one, and worth doing
 * separately rather than half-doing here.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const vault = require('./crypto/vault');
const { INTERNAL_DIR } = require('./paths');

const VAULT_FILE = '.lanshare-vault.json';
const DEFAULT_AUTOLOCK_MINUTES = 60;

class VaultStateError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// vaultId -> { masterKey, lastUsed, autoLockMs }
// Deliberately module-level rather than per-request: a vault stays unlocked
// across requests, which is the entire point, but only in memory.
const unlocked = new Map();

// ---------------------------------------------------------------------------
// Metadata on disk
// ---------------------------------------------------------------------------

function vaultFilePath(absAlbumDir) {
  return path.join(absAlbumDir, VAULT_FILE);
}

function readVaultMeta(absAlbumDir) {
  try {
    const raw = fs.readFileSync(vaultFilePath(absAlbumDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed?.id || !Array.isArray(parsed.keys)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeVaultMeta(absAlbumDir, metadata) {
  const target = vaultFilePath(absAlbumDir);
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(metadata, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, target);
}

/**
 * The vault a path belongs to, or null.
 *
 * Walks up from the path towards the library root, so a file several folders
 * deep inside a vault album is still covered by it. Stops at the library
 * root — a vault cannot be declared on the library itself, because there
 * would be nowhere left to put an unencrypted thing.
 */
function findVault(library, relPath) {
  const base = path.resolve(library);
  const segments = String(relPath || '/').split('/').filter(Boolean);

  // Longest prefix first: a nested vault inside a vault is governed by the
  // innermost one.
  for (let depth = segments.length; depth >= 1; depth--) {
    const albumRel = `/${segments.slice(0, depth).join('/')}`;
    const absDir = path.join(base, ...segments.slice(0, depth));
    let stat;
    try {
      stat = fs.statSync(absDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const metadata = readVaultMeta(absDir);
    if (metadata) return { albumRel, absDir, metadata };
  }
  return null;
}

/** True if this exact folder is a vault (not merely inside one). */
function isVaultRoot(absDir) {
  return fs.existsSync(vaultFilePath(absDir));
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

async function createVault(absAlbumDir, { passphrase, type = 'server', label = 'Passphrase' }) {
  if (!fs.existsSync(absAlbumDir) || !fs.statSync(absAlbumDir).isDirectory()) {
    throw new VaultStateError('That album does not exist', 404);
  }
  if (isVaultRoot(absAlbumDir)) {
    throw new VaultStateError('That album is already a vault', 409);
  }

  // Refuse to encrypt an album that already has files in it. Encrypting them
  // in place is a bulk rewrite with real failure modes (partial conversion,
  // running out of space halfway) and belongs in its own deliberate
  // operation, not as a side effect of ticking a box.
  const entries = (await fsp.readdir(absAlbumDir)).filter((name) => !name.startsWith('.'));
  if (entries.length) {
    throw new VaultStateError(
      'Only an empty album can be turned into a vault. Create a new album, make it a vault, then move files into it.',
      409,
    );
  }

  let created;
  try {
    created = await vault.createVault({ passphrase, type, label });
  } catch (err) {
    throw new VaultStateError(err.message);
  }

  await writeVaultMeta(absAlbumDir, created.metadata);
  // A freshly created vault starts unlocked — the person who just set the
  // passphrase obviously has it, and making them immediately type it again
  // would be pure ceremony.
  rememberKey(created.metadata.id, created.masterKey);
  return created.metadata;
}

// ---------------------------------------------------------------------------
// Unlocked-key state
// ---------------------------------------------------------------------------

function rememberKey(vaultId, masterKey, autoLockMinutes = DEFAULT_AUTOLOCK_MINUTES) {
  unlocked.set(vaultId, {
    masterKey,
    lastUsed: Date.now(),
    autoLockMs: Math.max(1, autoLockMinutes) * 60_000,
  });
}

/**
 * The master key for an unlocked vault, or null.
 * Touching it resets the inactivity timer, so a vault in active use does not
 * lock underneath someone mid-browse.
 */
function masterKeyFor(vaultId) {
  const entry = unlocked.get(vaultId);
  if (!entry) return null;
  if (Date.now() - entry.lastUsed > entry.autoLockMs) {
    unlocked.delete(vaultId);
    return null;
  }
  entry.lastUsed = Date.now();
  return entry.masterKey;
}

function isUnlocked(vaultId) {
  return masterKeyFor(vaultId) !== null;
}

async function unlockVault(metadata, passphrase, autoLockMinutes = DEFAULT_AUTOLOCK_MINUTES) {
  let masterKey;
  try {
    masterKey = await vault.unlock(metadata, passphrase);
  } catch (err) {
    throw new VaultStateError(err.message, 401);
  }
  rememberKey(metadata.id, masterKey, autoLockMinutes);
  return true;
}

function unlockWithRecoveryCode(metadata, code, autoLockMinutes = DEFAULT_AUTOLOCK_MINUTES) {
  let masterKey;
  try {
    masterKey = vault.unlockWithRecoveryCode(metadata, code);
  } catch (err) {
    throw new VaultStateError(err.message, 401);
  }
  rememberKey(metadata.id, masterKey, autoLockMinutes);
  return true;
}

function lockVault(vaultId) {
  return unlocked.delete(vaultId);
}

/**
 * Test-only: backdate a vault's last-used time so the inactivity auto-lock
 * can be exercised without waiting out a real timeout. Exported explicitly
 * rather than reaching into module internals from a test, so it is obvious
 * this exists and why.
 */
function _expire(vaultId) {
  const entry = unlocked.get(vaultId);
  if (entry) entry.lastUsed = 0;
}

/** Drop every key. Called when the server stops. */
function lockAll() {
  unlocked.clear();
}

// Sweep expired keys even when nothing is touching them, so a vault left
// idle actually locks rather than only appearing locked on next access.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [vaultId, entry] of unlocked) {
    if (now - entry.lastUsed > entry.autoLockMs) unlocked.delete(vaultId);
  }
}, 60_000);
sweeper.unref();

// ---------------------------------------------------------------------------
// Per-file keys, resolved through whichever vault owns the path
// ---------------------------------------------------------------------------

/**
 * What a route needs to know about a path: which vault governs it, whether
 * that vault is open, and the master key if so.
 *
 * Returns null when the path is not in a vault at all, which is the ordinary
 * case and means "handle this as a normal file".
 */
function contextFor(library, relPath) {
  const found = findVault(library, relPath);
  if (!found) return null;
  const masterKey = masterKeyFor(found.metadata.id);
  return {
    ...found,
    unlocked: masterKey !== null,
    masterKey,
    type: found.metadata.type,
  };
}

function newFileKey(masterKey) {
  return vault.createFileKey(masterKey);
}

function fileKeyFrom(masterKey, wrappedKey) {
  try {
    return vault.unwrapFileKey(masterKey, wrappedKey);
  } catch (err) {
    throw new VaultStateError(`Could not unwrap this file's key: ${err.message}`, 500);
  }
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/** Every vault in the library, with its current lock state. */
async function listVaults(library) {
  const base = path.resolve(library);
  const out = [];

  async function walk(dir, rel) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === INTERNAL_DIR || entry.name.startsWith('.')) continue;
      const childAbs = path.join(dir, entry.name);
      const childRel = `${rel === '/' ? '' : rel}/${entry.name}`;
      const metadata = readVaultMeta(childAbs);
      if (metadata) {
        out.push({
          path: childRel,
          name: entry.name,
          id: metadata.id,
          type: metadata.type,
          created: metadata.created,
          keyCount: metadata.keys.length,
          unlocked: isUnlocked(metadata.id),
        });
      }
      await walk(childAbs, childRel);
    }
  }

  await walk(base, '/');
  return out;
}

module.exports = {
  VaultStateError,
  VAULT_FILE,
  DEFAULT_AUTOLOCK_MINUTES,
  findVault,
  isVaultRoot,
  readVaultMeta,
  writeVaultMeta,
  createVault,
  unlockVault,
  unlockWithRecoveryCode,
  lockVault,
  lockAll,
  _expire,
  isUnlocked,
  masterKeyFor,
  contextFor,
  newFileKey,
  fileKeyFrom,
  listVaults,
};
