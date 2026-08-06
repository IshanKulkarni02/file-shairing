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
const tunnel = require('./tunnel.js');

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
    // 'lan' reaches the machine directly; 'relay' goes over the internet
    // through a relay. Worth showing, because one is fast and private to the
    // network and the other is neither.
    via: connection.via || 'lan',
    relay: connection.relay || null,
    addedAt: connection.addedAt,
    lastConnected: connection.lastConnected || null,
  }));
}

/**
 * Pair with a machine over the internet, using a code it showed you.
 *
 * No probing first: there is nothing to probe until the relay has introduced
 * the two ends, and the certificate is irrelevant here — the tunnel's own
 * encryption is what protects the connection, keyed by the code itself.
 */
async function addByCode(config, { code, relayHost, relayPort, username, password, label, remember = true }, { secrets } = {}) {
  if (!username || !password) throw new ConnectionError('Enter the username and password for that machine');
  if (!relayHost) throw new ConnectionError('Enter the address of the relay both machines use');

  const pairing = tunnel.parsePairing(code);
  const existing = ensureList(config);
  if (existing.some((c) => c.relay?.room === pairing.room && c.username.toLowerCase() === username.toLowerCase())) {
    throw new ConnectionError('You are already connected to that machine as that user', 409);
  }

  // Prove it works now rather than saving something that fails later.
  const client = new tunnel.TunnelClient({
    relayHost,
    relayPort: relayPort || 8460,
    pairing,
  });
  await client.connect();

  try {
    const login = await client.call('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (login.status !== 200) {
      throw new ConnectionError('That machine refused those credentials', 401);
    }
  } finally {
    client.close();
  }

  const record = {
    id: crypto.randomBytes(8).toString('hex'),
    label: (label && label.trim()) || `${username}'s machine (over the internet)`,
    via: 'relay',
    relay: {
      host: relayHost,
      port: relayPort || 8460,
      room: pairing.room,
      // The code *is* the key. It lives in the keychain with the password,
      // never in config.json, for exactly the same reason.
      secret: secrets?.available ? secrets.encrypt(pairing.code) : null,
    },
    username,
    secret: remember && secrets?.available ? secrets.encrypt(password) : null,
    addedAt: new Date().toISOString(),
    lastConnected: new Date().toISOString(),
  };
  existing.push(record);
  return record;
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
async function connect(config, id, { password = null, secrets = null, code = null } = {}) {
  const record = find(config, id);
  if (!record) throw new ConnectionError('No such connection', 404);

  const secret = password || secrets?.decrypt(record.secret);
  if (!secret) {
    throw new ConnectionError(
      'The password for that machine is not saved on this computer. Enter it to connect.',
      401,
    );
  }

  const host = record.via === 'relay'
    ? await openOverRelay(record, { secrets, code })
    : new remote.RemoteHost({
      base: record.base,
      fingerprint: record.fingerprint,
      label: record.label,
    });

  await host.signIn(record.username, secret);
  record.lastConnected = new Date().toISOString();
  return host;
}

/**
 * A relayed connection wearing the same interface as a direct one.
 *
 * Everything above — browsing, copying, the Machines screen — then works
 * without knowing or caring which it has, which is the point: a second code
 * path for "the same thing but over the internet" is a second place for every
 * one of those behaviours to drift.
 */
async function openOverRelay(record, { secrets, code }) {
  const pairingCode = code || secrets?.decrypt(record.relay?.secret);
  if (!pairingCode) {
    throw new ConnectionError(
      'The pairing code for that machine is not saved on this computer. Enter it to connect.',
      401,
    );
  }

  const client = new tunnel.TunnelClient({
    relayHost: record.relay.host,
    relayPort: record.relay.port,
    pairing: tunnel.parsePairing(pairingCode),
  });
  await client.connect();

  return {
    base: `relay:${record.relay.host}`,
    label: record.label,
    get cookie() { return client.cookie; },
    set cookie(value) { client.cookie = value; },

    call: (p, options = {}) => client.call(p, options),

    async json(p, options = {}) {
      const res = await client.call(p, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options.headers || {}) },
        body: options.json ? JSON.stringify(options.json) : options.body,
      });

      if (res.status === 401) throw new ConnectionError('Signed out by the other machine', 401);
      if (res.status === 403) throw new ConnectionError('That account is not allowed to do this there', 403);

      let parsed = null;
      try { parsed = JSON.parse(res.body.toString('utf8')); } catch { /* not JSON */ }
      if (res.status >= 400) {
        throw new ConnectionError(parsed?.error || `The other machine refused that (${res.status})`, res.status);
      }
      return parsed;
    },

    async signIn(username, secret) {
      await this.json('/api/login', { method: 'POST', json: { username, password: secret } });
      if (!client.cookie) throw new ConnectionError('That machine did not return a session', 502);
      return true;
    },

    signOut() { client.cookie = null; },

    list(remotePath = '/') {
      return this.json(`/api/list?path=${encodeURIComponent(remotePath)}`);
    },

    async download(remotePath) {
      const res = await client.call(`/api/file?path=${encodeURIComponent(remotePath)}`);
      if (res.status !== 200) {
        throw new ConnectionError(`Could not download ${remotePath} (${res.status})`, res.status);
      }
      return res.body;
    },

    upload(remoteDir, name, bytes) {
      // The same multipart body a direct upload sends; only the transport
      // underneath differs.
      const boundary = `----lanshare${crypto.randomBytes(12).toString('hex')}`;
      const head = Buffer.from(
        `--${boundary}\r\n`
        + `Content-Disposition: form-data; name="file"; filename="${name.replace(/"/g, '')}"\r\n`
        + 'Content-Type: application/octet-stream\r\n\r\n',
      );
      const body = Buffer.concat([head, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);

      return this.json(
        `/api/upload?dir=${encodeURIComponent(remoteDir)}&rel=${encodeURIComponent(name)}`,
        {
          method: 'POST',
          headers: {
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'content-length': String(body.length),
          },
          body,
        },
      );
    },

    close() { client.close(); },
  };
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
  addByCode,
  remove,
  connect,
  copyFiles,
};
