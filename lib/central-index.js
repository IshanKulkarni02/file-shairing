'use strict';

/**
 * The shape and the encryption of "a central index every device can
 * reach" (Phase J) — deliberately independent of where a sealed blob
 * actually gets stored. lib/federation.js (Phase I) taught the search route
 * to ask a live peer; this teaches it to also ask a place that is always up
 * even when every peer is asleep. The relay (relay/server.js) is the
 * transport this ships with, chosen because it needs no new external
 * account or repository — but nothing in this file knows that. A blob built
 * here decrypts the same way regardless of which "shelf" it was fetched
 * from, so a GitHub-backed transport could be added later without touching
 * this module at all.
 *
 * ## Two keys, one passphrase, deliberately not the same key
 *
 * A passphrase shared between every device (typed once per device, the same
 * "choose a passphrase" UX a vault already uses) derives two independent
 * 32-byte keys via PBKDF2, at two different fixed, public salts:
 *
 *   - a **lookup key**, which HMACs into the opaque storage key each device
 *     publishes under, and into a shared "roster" key naming which devices
 *     currently publish at all;
 *   - an **encryption key**, which seals the actual index contents with
 *     AES-256-GCM (via lib/crypto/vault.js, unchanged).
 *
 * They must be independent so that a leak of the storage location (the
 * relay operator can see *that* a key was requested, and roughly how often)
 * never helps recover the key that would let it be read.
 *
 * ## Why the salts are fixed instead of random
 *
 * A random per-installation salt is the normal PBKDF2 advice, but it comes
 * with a place to *store* that salt — and the entire problem this module
 * exists to solve is "how do several devices, with no prior shared state
 * beyond a passphrase typed into each of them, agree on where to look."
 * A fixed, purpose-specific salt is what makes the derivation reproducible
 * with no coordination at all: every device that was given the same
 * passphrase lands on the same two keys, unassisted. The passphrase itself
 * carries all the entropy — the same trade this app already makes for a
 * vault passphrase, just without a per-vault salt to lean on here.
 *
 * ## One storage slot per device, not one shared blob everyone edits
 *
 * If every device wrote into the same blob, two publishing around the same
 * time would race — whichever finishes last silently erases the other's
 * contribution, since the relay's PUT has no compare-and-swap. Instead each
 * device gets its own slot (`deviceSlotKey`), so a publish is always a
 * whole, independent write with nothing to lose to a race. A second, small
 * "roster" blob just lists which device slots currently exist, so fetching
 * knows what to ask for without guessing device ids — it is the one place
 * two publishes still *could* race, but losing that race only means a
 * device's roster entry is briefly stale until its own next publish
 * corrects it, never any loss of the index data itself.
 */

const crypto = require('crypto');
const zlib = require('zlib');
const os = require('os');
const vault = require('./crypto/vault.js');

const SALT_ENCRYPT = Buffer.from('lanshare-central-index-encrypt-v1', 'utf8');
const SALT_LOOKUP = Buffer.from('lanshare-central-index-lookup-v1', 'utf8');

// Same cost as a vault passphrase — this guards the same kind of secret
// (something typed by a human, worth resisting offline guessing on).
const ITERATIONS = vault.DEFAULT_ITERATIONS;

const FORMAT_VERSION = 1;

class CentralIndexError extends Error {}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/** One passphrase in, two independent 32-byte keys out. */
async function deriveKeys(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new CentralIndexError('A central index passphrase must be at least 8 characters');
  }
  const [encryptionKey, lookupKey] = await Promise.all([
    vault.deriveKek(passphrase, SALT_ENCRYPT, ITERATIONS),
    vault.deriveKek(passphrase, SALT_LOOKUP, ITERATIONS),
  ]);
  return { encryptionKey, lookupKey };
}

function slotKey(lookupKey, purpose) {
  return crypto.createHmac('sha256', lookupKey).update(purpose, 'utf8').digest('hex');
}

/** Where one specific device's index is stored. */
function deviceSlotKey(lookupKey, deviceId) {
  return slotKey(lookupKey, `device:${deviceId}`);
}

/** Where the list of currently-publishing devices is stored. */
function rosterSlotKey(lookupKey) {
  return slotKey(lookupKey, 'roster');
}

// ---------------------------------------------------------------------------
// Sealing and opening blobs
//
// AAD binds a blob to the specific slot it was sealed for, the same
// reasoning lib/crypto/vault.js already applies to a wrapped vault key: a
// relay operator (or anyone else who can write to the store) can copy
// device A's ciphertext into device B's slot, but cannot make it decrypt
// there — a swapped blob fails its authenticity check instead of silently
// being accepted as if it were legitimate.
// ---------------------------------------------------------------------------

function deviceAad(deviceId) {
  return Buffer.from(`lanshare-central-index:device:${deviceId}`, 'utf8');
}

const ROSTER_AAD = Buffer.from('lanshare-central-index:roster', 'utf8');

function seal(encryptionKey, aad, payloadObject) {
  const json = Buffer.from(JSON.stringify(payloadObject), 'utf8');
  const compressed = zlib.gzipSync(json);
  return vault.wrap(encryptionKey, compressed, aad);
}

function open(encryptionKey, aad, blobBuffer) {
  const compressed = vault.unwrap(encryptionKey, blobBuffer, aad);
  let json;
  try {
    json = zlib.gunzipSync(compressed);
  } catch {
    throw new CentralIndexError('Central index blob decrypted but was not valid compressed data');
  }
  try {
    return JSON.parse(json.toString('utf8'));
  } catch {
    throw new CentralIndexError('Central index blob decompressed but was not valid JSON');
  }
}

// ---------------------------------------------------------------------------
// The two blob shapes
// ---------------------------------------------------------------------------

/** One device's full published index. */
function buildDeviceBlob({ deviceId, label, entries }) {
  return {
    v: FORMAT_VERSION,
    deviceId,
    label,
    publishedAt: new Date().toISOString(),
    entries,
  };
}

/**
 * Add or refresh one device's entry in the roster, preserving every other
 * device's entry untouched. `existing` is whatever the roster decrypted to
 * last time it was fetched — null on a device's very first publish ever.
 */
function mergeRoster(existing, deviceId, label) {
  const devices = (existing?.devices || []).filter((d) => d.deviceId !== deviceId);
  devices.push({ deviceId, label, lastPublished: new Date().toISOString() });
  return { v: FORMAT_VERSION, devices };
}

// ---------------------------------------------------------------------------
// Device identity — persisted in config.json, same pattern config.secret
// already uses: generated once, on first need, never regenerated after.
// ---------------------------------------------------------------------------

function ensureDeviceId(config, configLib) {
  if (!config.deviceId) {
    config.deviceId = crypto.randomBytes(8).toString('hex');
    configLib.save(config);
  }
  return config.deviceId;
}

function deviceLabel(config) {
  return config.centralIndex?.label || os.hostname() || 'This machine';
}

module.exports = {
  CentralIndexError,
  deriveKeys,
  deviceSlotKey,
  rosterSlotKey,
  deviceAad,
  ROSTER_AAD,
  seal,
  open,
  buildDeviceBlob,
  mergeRoster,
  ensureDeviceId,
  deviceLabel,
};
