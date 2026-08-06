'use strict';

/**
 * Remote hosts you have paired with.
 *
 * A connection records where another LANShare host is, which certificate it
 * presented when you paired, and the username to sign in as. **It never
 * records the password**: that goes to the OS keychain via Electron's
 * safeStorage, and this module only ever sees an opaque encrypted blob it
 * cannot read without the OS agreeing.
 *
 * Storing a password in config.json would put every paired machine's
 * credentials in a plain-text file that gets copied around with the library,
 * synced to a backup drive, and read by anything running as the user.
 */

const crypto = require('crypto');
const remote = require('./remote.js');

class ConnectionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ConnectionError';
    this.status = status;
  }
}

function ensureList(config) {
  if (!Array.isArray(config.connections)) config.connections = [];
  return config.connections;
}

/**
 * A place to keep passwords.
 *
 * Electron's safeStorage is backed by the OS keychain (DPAPI on Windows,
 * Keychain on macOS, libsecret on Linux). Where it is unavailable — the
 * headless server, or a Linux box with no keyring — credentials are simply
 * not stored, and the user is asked each time. That is worse to use and much
 * better than writing passwords to a file that looks harmless.
 */
function makeSecretStore(safeStorage) {
  const usable = Boolean(safeStorage?.isEncryptionAvailable?.());
  return {
    available: usable,
    encrypt(plain) {
      if (!usable) return null;
      return safeStorage.encryptString(plain).toString('base64');
    },
    decrypt(blob) {
      if (!usable || !blob) return null;
      try {
        return safeStorage.decryptString(Buffer.from(blob, 'base64'));
      } catch {
        // Written by a different user or machine, or the keychain was reset.
        return null;
      }
    },
  };
}

function list(config) {
  return ensureList(config).map((connection) => ({
    id: connection.id,
    label: connection.label,
    base: connection.base,
    username: connection.username,
    fingerprint: connection.fingerprint,
    hasSavedPassword: Boolean(connection.secret),
    addedAt: connection.addedAt,
    lastConnected: connection.lastConnected || null,
  }));
}

const find = (config, id) => ensureList(config).find((c) => c.id === id) || null;

/**
 * Pair with a host.
 *
 * The certificate is checked and the credentials proved *before* anything is
 * saved, so a connection in the list is one that is known to work rather than
 * one that merely looked plausible when typed.
 */
async function add(config, { address, username, password, label, remember = true, https: useHttps = true }, { secrets } = {}) {
  if (!username || !password) throw new ConnectionError('Enter the username and password for that machine');

  const probed = await remote.probe(address, { https: useHttps });
  if (!probed.isLanshare) {
    throw new ConnectionError('That address answered, but it is not a LANShare host', 400);
  }

  const existing = ensureList(config);
  if (existing.some((c) => c.base === probed.base && c.username.toLowerCase() === username.toLowerCase())) {
    throw new ConnectionError('You are already connected to that machine as that user', 409);
  }

  // Prove the credentials now rather than saving something that fails later.
  const host = new remote.RemoteHost({ base: probed.base, fingerprint: probed.fingerprint });
  await host.signIn(username, password);
  const me = await host.json('/api/me');
  host.signOut();

  const record = {
    id: crypto.randomBytes(8).toString('hex'),
    label: (label && label.trim()) || probed.base.replace(/^https?:\/\//, ''),
    base: probed.base,
    fingerprint: probed.fingerprint,
    username,
    role: me?.role || null,
    secret: remember && secrets?.available ? secrets.encrypt(password) : null,
    addedAt: new Date().toISOString(),
    lastConnected: new Date().toISOString(),
  };
  existing.push(record);
  return record;
}

function remove(config, id) {
  const all = ensureList(config);
  const index = all.findIndex((c) => c.id === id);
  if (index === -1) throw new ConnectionError('No such connection', 404);
  const [removed] = all.splice(index, 1);
  return removed;
}

/**
 * Open a signed-in connection to a stored host.
 *
 * `password` is only needed when nothing was saved, which is the case on a
 * machine with no keychain.
 */
async function connect(config, id, { password = null, secrets = null } = {}) {
  const record = find(config, id);
  if (!record) throw new ConnectionError('No such connection', 404);

  const secret = password || secrets?.decrypt(record.secret);
  if (!secret) {
    throw new ConnectionError(
      'The password for that machine is not saved on this computer. Enter it to connect.',
      401,
    );
  }

  const host = new remote.RemoteHost({
    base: record.base,
    fingerprint: record.fingerprint,
    label: record.label,
  });
  await host.signIn(record.username, secret);

  record.lastConnected = new Date().toISOString();
  return host;
}

/**
 * Copy files between this library and a remote one.
 *
 * Deliberately one file at a time with a progress callback rather than a
 * parallel free-for-all: the far side is usually a home network or a USB-ish
 * link, and twenty concurrent transfers make the whole thing slower while
 * making a failure much harder to report usefully.
 */
async function copyFiles(host, { direction, remoteDir, localDir, files, fsp, path: pathLib, onProgress }) {
  const results = { copied: [], failed: [], bytes: 0 };

  for (const name of files) {
    try {
      if (direction === 'download') {
        const bytes = await host.download(pathLib.posix.join(remoteDir, name));
        const dest = pathLib.join(localDir, name);
        await fsp.mkdir(pathLib.dirname(dest), { recursive: true });
        // Written beside and renamed, so an interrupted transfer never leaves
        // a half file looking like a real one — same discipline as sync.
        const tmp = `${dest}.lanshare-part`;
        await fsp.writeFile(tmp, bytes);
        await fsp.rename(tmp, dest);
        results.bytes += bytes.length;
      } else {
        const bytes = await fsp.readFile(pathLib.join(localDir, name));
        await host.upload(remoteDir, name, bytes);
        results.bytes += bytes.length;
      }
      results.copied.push(name);
    } catch (err) {
      results.failed.push({ name, error: err.message });
    }
    onProgress?.({
      done: results.copied.length + results.failed.length,
      total: files.length,
      bytes: results.bytes,
      name,
    });
  }
  return results;
}

module.exports = {
  ConnectionError,
  makeSecretStore,
  list,
  find,
  add,
  remove,
  connect,
  copyFiles,
};
