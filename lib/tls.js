'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const selfsigned = require('selfsigned');

const { INTERNAL_DIR } = require('./paths');
const { lanAddresses, mdnsHost } = require('./net');

const VALID_DAYS = 825; // Apple refuses to trust certificates valid for longer.
const RENEW_BEFORE_DAYS = 30;

function tlsDir(library) {
  return path.join(library, INTERNAL_DIR, 'tls');
}

/**
 * Names and addresses this certificate must cover. A browser checks the
 * address you typed against the SAN list, so every way of reaching the
 * server needs to be in here or it will warn even after being trusted.
 */
function subjectNames() {
  const host = os.hostname().split('.')[0];
  const dns = ['localhost', host, host.toLowerCase(), mdnsHost()];
  const ips = ['127.0.0.1', ...lanAddresses().map((a) => a.address)];

  const altNames = [];
  for (const name of new Set(dns)) altNames.push({ type: 2, value: name }); // dNSName
  for (const ip of new Set(ips)) altNames.push({ type: 7, ip });            // iPAddress
  return { altNames, ips: [...new Set(ips)] };
}

function readExisting(dir) {
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  const metaPath = path.join(dir, 'meta.json');
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return null;

  try {
    const meta = fs.existsSync(metaPath)
      ? JSON.parse(fs.readFileSync(metaPath, 'utf8'))
      : {};
    return {
      cert: fs.readFileSync(certPath, 'utf8'),
      key: fs.readFileSync(keyPath, 'utf8'),
      meta,
    };
  } catch {
    return null;
  }
}

/**
 * A cached certificate is reusable only while it is still valid and still
 * covers the machine's current addresses. A DHCP lease change would otherwise
 * produce warnings on every device.
 */
function isStillGood(existing, ips) {
  if (!existing || !existing.meta.expires) return false;
  const expiresIn = new Date(existing.meta.expires).getTime() - Date.now();
  if (expiresIn < RENEW_BEFORE_DAYS * 86400e3) return false;

  const covered = new Set(existing.meta.ips || []);
  return ips.every((ip) => covered.has(ip));
}

/**
 * Return { key, cert } for the HTTPS listener, generating and caching a
 * self-signed certificate when needed. Returns null if generation fails,
 * so the HTTP listener can still come up on its own.
 */
async function ensureCertificate(library) {
  const dir = tlsDir(library);
  const { altNames, ips } = subjectNames();

  const existing = readExisting(dir);
  if (isStillGood(existing, ips)) {
    return { key: existing.key, cert: existing.cert, reused: true };
  }

  try {
    const attributes = [
      { name: 'commonName', value: os.hostname().split('.')[0] },
      { name: 'organizationName', value: 'LANShare' },
    ];

    // selfsigned v5 resolves a promise; earlier versions returned the pems
    // directly, and awaiting a plain object is harmless either way.
    const pems = await selfsigned.generate(attributes, {
      days: VALID_DAYS,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: true },
        {
          name: 'keyUsage',
          keyCertSign: true,
          digitalSignature: true,
          keyEncipherment: true,
        },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames },
      ],
    });

    // Read the expiry off the certificate rather than assuming it matches the
    // days we asked for — the generator may honour a different value, and a
    // wrong date here means the renewal check misses the real expiry.
    const expires = new crypto.X509Certificate(pems.cert).validTo;

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cert.pem'), pems.cert);
    fs.writeFileSync(path.join(dir, 'key.pem'), pems.private, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      created: new Date().toISOString(),
      expires: new Date(expires).toISOString(),
      ips,
      names: altNames.filter((n) => n.type === 2).map((n) => n.value),
    }, null, 2));

    return { key: pems.private, cert: pems.cert, reused: false };
  } catch (err) {
    console.warn(`[tls] could not create a certificate: ${err.message}`);
    return null;
  }
}

module.exports = { ensureCertificate, tlsDir };
