/**
 * Starts one real LANShare server with a working (if fake) secrets store —
 * something server.js itself can never provide, since it never threads one
 * into start() at all; only the desktop app does, via Electron's
 * safeStorage. Generic version of test/helpers/federation-server.mjs's own
 * fakeSecretStore, for any test that needs secretsStore.available to be
 * true without needing federation's peer-specific setup.
 *
 * The "encryption" below is a stand-in for the real OS-keychain-backed
 * safeStorage — reversible, not secret, and used only so this script and
 * whatever it starts exercise the exact same code real callers do. No
 * product code ever sees or uses this implementation.
 *
 * Env vars: LANSHARE_HOME, PORT, ADMIN_PASSWORD.
 *
 *   LANSHARE_HOME=... PORT=... ADMIN_PASSWORD=... node test/helpers/secrets-server.mjs
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
// setUser() reloads its own copy from disk and returns that, not `initial`
// — the object actually handed to serverApp.start() has to be its return
// value, or the running server never sees the password just set.
const config = configLib.setUser('admin', process.env.ADMIN_PASSWORD);

await serverApp.start(config, { secrets: fakeSecretStore() });
console.log(`secrets-server ready on ${config.port}`);
