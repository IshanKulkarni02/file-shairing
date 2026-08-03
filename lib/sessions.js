'use strict';

/**
 * Revocable session records, one per signed-in device.
 *
 * The session cookie (lib/auth.js) is a signed token and would keep verifying
 * on its own for up to `sessionDays` even if the account were disabled or the
 * device lost — that is exactly why a record backs it here. Revoking a
 * session, or disabling the account it belongs to, is checked on every
 * request; deleting the record is what actually signs a device out.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const configLib = require('./config');

const FILE_NAME = 'sessions.json';
// Persisted at most this often for a plain "still active" touch; a login,
// logout or revoke always flushes immediately regardless of this timer.
const FLUSH_INTERVAL_MS = 30_000;

let cache = null; // Map<id, record>
let dirty = false;

function filePath() {
  return path.join(configLib.serverStateDir(), FILE_NAME);
}

function readFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}

function writeToDisk(map) {
  const obj = Object.fromEntries(map);
  const tmp = `${filePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath());
}

function pruneExpired(map) {
  const now = Date.now();
  let removed = false;
  for (const [id, record] of map) {
    if (record.exp < now) {
      map.delete(id);
      removed = true;
    }
  }
  return removed;
}

function ensureLoaded() {
  if (cache) return cache;
  cache = readFromDisk();
  if (pruneExpired(cache)) writeToDisk(cache);
  return cache;
}

function flush() {
  if (!dirty) return;
  writeToDisk(cache);
  dirty = false;
}

// A periodic flush is enough for lastSeen freshness; losing the last <30s of
// it on a crash only affects what the Devices screen displays, not security.
setInterval(flush, FLUSH_INTERVAL_MS).unref();

function create({ username, ip, userAgent, days }) {
  const map = ensureLoaded();
  const id = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const record = {
    id,
    username,
    ip: ip || null,
    userAgent: userAgent || null,
    created: now,
    lastSeen: now,
    exp: now + days * 86400e3,
  };
  map.set(id, record);
  dirty = true;
  flush(); // A login is rare and matters; do not risk losing it to a crash.
  return record;
}

/** Returns the record if it exists and has not expired, otherwise null. */
function find(id) {
  const map = ensureLoaded();
  const record = map.get(id);
  if (!record) return null;
  if (record.exp < Date.now()) {
    map.delete(id);
    dirty = true;
    return null;
  }
  return record;
}

function touch(id) {
  const map = ensureLoaded();
  const record = map.get(id);
  if (!record) return;
  record.lastSeen = Date.now();
  dirty = true;
}

function revoke(id) {
  const map = ensureLoaded();
  const existed = map.delete(id);
  if (existed) { dirty = true; flush(); }
  return existed;
}

/** Revoke every session for a user. Used when an account is deleted. */
function revokeAllForUser(username, exceptId = null) {
  const map = ensureLoaded();
  let changed = false;
  for (const [id, record] of map) {
    if (record.username === username && id !== exceptId) {
      map.delete(id);
      changed = true;
    }
  }
  if (changed) { dirty = true; flush(); }
}

/** All sessions, or just one user's, newest first. */
function list(username = null) {
  const map = ensureLoaded();
  const all = [...map.values()];
  const filtered = username ? all.filter((r) => r.username === username) : all;
  return filtered.sort((a, b) => b.lastSeen - a.lastSeen);
}

/** Test-only: force a reload from disk on the next call. */
function _resetCache() {
  cache = null;
  dirty = false;
}

module.exports = { create, find, touch, revoke, revokeAllForUser, list, _resetCache };
