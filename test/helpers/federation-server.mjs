/**
 * Starts one real LANShare server for test/federation-routes.mjs, with an
 * optional peer connection already configured — something server.js itself
 * has no way to do, since it never threads a secrets store into start() at
 * all. This exists so that gap can be worked around in a test without
 * adding test-only plumbing to the real CLI entry point.
 *
 * The "encryption" below is a stand-in for Electron's OS-keychain-backed
 * safeStorage — reversible, not secret, and used only so this script and
 * lib/connections.js exercise the exact same code real callers do. No
 * product code ever sees or uses this implementation.
 *
 * Env vars: LANSHARE_HOME, PORT, ADMIN_PASSWORD, and optionally PEER_JSON —
 * a JSON connection record (id, label, base, username, password) to add to
 * config.connections before the server starts.
 *
 *   LANSHARE_HOME=... PORT=... ADMIN_PASSWORD=... [PEER_JSON=...] \
 *     node test/helpers/federation-server.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const configLib = require(path.join(root, 'lib', 'config.js'));
const serverApp = require(path.join(root, 'lib', 'server-app.js'));

function fakeSecretStore() {
  return {
    available: true,
    encrypt: (plain) => Buffer.from(plain, 'utf8').toString('base64'),
    decrypt: (blob) => (blob ? Buffer.from(blob, 'base64').toString('utf8') : null),
  };
}

const { config: initial } = configLib.loadOrCreate();
initial.port = Number(process.env.PORT);
initial.httpsPort = Number(process.env.PORT) + 1;
configLib.save(initial);
// setUser() reloads its own copy from disk, mutates and saves that — not
// `initial` — so the object actually handed to serverApp.start() has to be
// its return value, or the running server never sees the password just set.
const config = configLib.setUser('admin', process.env.ADMIN_PASSWORD);

const secrets = fakeSecretStore();

if (process.env.PEER_JSON) {
  const peer = JSON.parse(process.env.PEER_JSON);
  config.connections = [{
    id: peer.id,
    label: peer.label,
    base: peer.base,
    fingerprint: null,
    username: peer.username,
    secret: secrets.encrypt(peer.password),
    addedAt: new Date().toISOString(),
    lastConnected: new Date().toISOString(),
  }];
  configLib.save(config);
}

await serverApp.start(config, { secrets });
console.log(`federation-server ready on ${config.port}`);
