'use strict';

/**
 * Talking to another LANShare host as a client.
 *
 * This app is a server; this module is the other half, so a Mac can browse
 * the Windows machine's library and copy in either direction without either
 * one being special.
 *
 * ## The certificate problem, and why it is solved this way
 *
 * Every LANShare host serves HTTPS with a **self-signed** certificate. There
 * is no certificate authority on a home network and never will be, so a
 * remote host's certificate cannot be verified the usual way.
 *
 * The tempting shortcut — `rejectUnauthorized: false` — would accept *any*
 * certificate from *anyone*, which turns the connection into plain HTTP with
 * extra steps: anything on the network could impersonate the host and collect
 * the password sent to it.
 *
 * Instead this pins the certificate, the way SSH pins host keys. The first
 * connection records the certificate's SHA-256 fingerprint; every later
 * connection requires exactly that fingerprint. An impostor fails. A genuine
 * change — the host regenerated its certificate — also fails, loudly, and
 * needs the user to confirm rather than being waved through.
 *
 * That leaves the first connection trusted blindly, which is the same
 * trade-off SSH makes and is worth stating plainly rather than hiding.
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');

class RemoteError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RemoteError';
    this.status = status;
  }
}

/** SHA-256 of a DER certificate, formatted the way OpenSSL prints it. */
function fingerprintOf(der) {
  const hash = crypto.createHash('sha256').update(der).digest('hex').toUpperCase();
  return hash.match(/.{2}/g).join(':');
}

/** The fingerprint of whatever certificate this socket's peer presented. */
function peerFingerprint(socket) {
  const cert = socket?.getPeerCertificate?.();
  if (!cert) return null;
  return cert.fingerprint256 || (cert.raw ? fingerprintOf(cert.raw) : null);
}

function normalizeBase(address, { https: useHttps = true, port } = {}) {
  const trimmed = String(address || '').trim();
  if (!trimmed) throw new RemoteError('Enter the address of the other machine');

  // Accept "192.168.1.20", "192.168.1.20:8443" and a full URL alike, because
  // all three are things a person reasonably types.
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `${useHttps ? 'https' : 'http'}://${trimmed}`);
  } catch {
    throw new RemoteError('That does not look like an address');
  }
  if (port && !url.port) url.port = String(port);
  if (!url.port) url.port = useHttps ? '8443' : '8420';
  url.pathname = '/';
  return url.origin;
}

/**
 * One request to a remote host.
 *
 * Written on node:https directly rather than fetch because the fingerprint
 * check needs the peer certificate, which fetch does not expose.
 */
const WRONG_CERT_MESSAGE = 'This machine is not the one you paired with — its security '
  + 'certificate has changed. That happens if it was reinstalled, but it is also exactly '
  + 'what an impostor looks like. Remove the connection and add it again only if you know '
  + 'why it changed.';

function request(base, path, {
  method = 'GET',
  headers = {},
  body = null,
  cookie = null,
  expectedFingerprint = null,
  timeoutMs = 30000,
  onCertificate = null,
  agent = undefined,
} = {}) {
  const url = new URL(path, base);
  const secure = url.protocol === 'https:';
  const transport = secure ? https : http;

  return new Promise((resolve, reject) => {
    let verified = false;

    const req = transport.request(url, {
      method,
      headers: { ...headers, ...(cookie ? { cookie } : {}) },
      // Verification is by pinned fingerprint below, not by a CA chain, which
      // cannot exist for a self-signed host certificate.
      rejectUnauthorized: false,
      timeout: timeoutMs,
      // Never the global agent. Node pools TLS sockets per agent, and a socket
      // opened for one host — or for a probe with nothing pinned yet — would
      // otherwise be handed to a request with a different expectation, whose
      // handshake then never happens and whose fingerprint is never checked.
      // A pooled socket skipping the check is precisely the hole pinning
      // exists to close.
      agent: agent === undefined ? false : agent,
    }, (res) => {
      // Backstop for a socket that came from a pool without a fresh handshake:
      // if the check below never ran, refuse rather than trust it silently.
      if (secure && expectedFingerprint && !verified) {
        const actual = peerFingerprint(req.socket);
        if (actual !== expectedFingerprint) {
          req.destroy();
          reject(new RemoteError(WRONG_CERT_MESSAGE, 495));
          return;
        }
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
        setCookie: res.headers['set-cookie']?.[0]?.split(';')[0] || null,
        fingerprint: peerFingerprint(req.socket),
      }));
    });

    if (secure) {
      // `once`, and on the socket for this request only — attaching to a
      // shared socket repeatedly is what produced a MaxListeners warning.
      req.once('socket', (socket) => {
        const onSecure = () => {
          const actual = peerFingerprint(socket);

          if (!actual) {
            socket.destroy();
            reject(new RemoteError('The other machine did not present a certificate', 502));
            return;
          }
          onCertificate?.(actual, socket.getPeerCertificate());

          if (expectedFingerprint && actual !== expectedFingerprint) {
            // Destroyed here, during the handshake, so the request — and the
            // password it may carry — is never written to the wrong host.
            socket.destroy();
            reject(new RemoteError(WRONG_CERT_MESSAGE, 495));
            return;
          }
          verified = true;
        };

        if (socket.encrypted && !socket.connecting) onSecure();
        else socket.once('secureConnect', onSecure);
      });
    }

    req.on('timeout', () => {
      req.destroy();
      reject(new RemoteError('The other machine did not answer in time', 504));
    });
    req.on('error', (err) => reject(new RemoteError(
      err.code === 'ECONNREFUSED'
        ? 'Nothing is listening at that address — is LANShare running on it?'
        : `Could not reach that machine: ${err.message}`,
      502,
    )));

    if (body) req.write(body);
    req.end();
  });
}

/**
 * Fetch a host's certificate fingerprint without logging in.
 *
 * Used when adding a connection, so the fingerprint can be shown and agreed
 * to before any password is sent to it.
 */
async function probe(address, options = {}) {
  const base = normalizeBase(address, options);
  let seen = null;
  const res = await request(base, '/api/ping', {
    onCertificate: (fingerprint) => { seen = fingerprint; },
    timeoutMs: options.timeoutMs || 8000,
  });

  return {
    base,
    fingerprint: seen,
    reachable: res.status < 500,
    // /api/ping is unauthenticated on a LANShare host; a 404 means we reached
    // something that is not one.
    isLanshare: res.status !== 404,
  };
}

/**
 * A live connection to a remote host.
 *
 * Holds the session cookie in memory only. The password is never stored here
 * — the caller gets it from the OS keychain when a connection is made and
 * this object forgets it immediately.
 */
class RemoteHost {
  constructor({ base, fingerprint = null, label = null }) {
    this.base = base;
    this.fingerprint = fingerprint;
    this.label = label || base;
    this.cookie = null;
  }

  async call(path, options = {}) {
    const res = await request(this.base, path, {
      ...options,
      cookie: options.cookie ?? this.cookie,
      expectedFingerprint: this.fingerprint,
    });
    if (res.setCookie) this.cookie = res.setCookie;
    return res;
  }

  async json(path, options = {}) {
    const res = await this.call(path, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      body: options.json ? JSON.stringify(options.json) : options.body,
    });

    if (res.status === 401) throw new RemoteError('Signed out by the other machine', 401);
    if (res.status === 403) throw new RemoteError('That account is not allowed to do this there', 403);

    let parsed = null;
    try { parsed = JSON.parse(res.body.toString('utf8')); } catch { /* not JSON */ }

    if (res.status >= 400) {
      throw new RemoteError(parsed?.error || `The other machine refused that (${res.status})`, res.status);
    }
    return parsed;
  }

  async signIn(username, password) {
    await this.json('/api/login', { method: 'POST', json: { username, password } });
    if (!this.cookie) throw new RemoteError('That machine did not return a session', 502);
    return true;
  }

  signOut() {
    this.cookie = null;
  }

  list(remotePath = '/') {
    return this.json(`/api/list?path=${encodeURIComponent(remotePath)}`);
  }

  /** A file's bytes. Used for copying, so it returns a Buffer, not a stream. */
  async download(remotePath) {
    const res = await this.call(`/api/file?path=${encodeURIComponent(remotePath)}`);
    if (res.status !== 200) {
      throw new RemoteError(`Could not download ${remotePath} (${res.status})`, res.status);
    }
    return res.body;
  }

  /** Upload one file's bytes into a remote folder. */
  async upload(remoteDir, name, bytes) {
    const boundary = `----lanshare${crypto.randomBytes(12).toString('hex')}`;
    const head = Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="file"; filename="${name.replace(/"/g, '')}"\r\n`
      + 'Content-Type: application/octet-stream\r\n\r\n',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, bytes, tail]);

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
  }
}

module.exports = {
  RemoteError,
  RemoteHost,
  probe,
  normalizeBase,
  fingerprintOf,
  request,
};
