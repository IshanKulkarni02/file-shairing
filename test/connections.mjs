/**
 * Pairing with another machine and copying between the two libraries.
 *
 * Runs a real second server and does real transfers over real HTTPS, because
 * the parts worth checking — that a password never lands in config.json, that
 * pairing proves the credentials before saving, and that a copy lands byte for
 * byte — are all invisible to a mock.
 *
 *   node test/connections.mjs
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

const HOME = mkdtempSync(path.join(tmpdir(), 'lanshare-conn-'));
process.env.LANSHARE_HOME = HOME;

const configLib = require(path.join(here, '..', 'lib', 'config.js'));
const serverApp = require(path.join(here, '..', 'lib', 'server-app.js'));
const connections = require(path.join(here, '..', 'lib', 'connections.js'));

const PASSWORD = 'a properly long remote password';
const HTTPS_PORT = 8542;

/** Stands in for Electron's safeStorage, with the same contract. */
function fakeKeychain({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`),
    decryptString: (buffer) => {
      const text = buffer.toString();
      if (!text.startsWith('enc:')) throw new Error('not ours');
      return text.slice(4);
    },
  };
}

let handle = null;
const localLibrary = path.join(HOME, 'local-library');

try {
  const { config } = configLib.loadOrCreate();
  config.port = 8541;
  config.httpsPort = HTTPS_PORT;
  configLib.save(config);
  configLib.setUser('admin', PASSWORD);

  mkdirSync(path.join(HOME, 'library', 'Trip'), { recursive: true });
  writeFileSync(path.join(HOME, 'library', 'Trip', 'beach.txt'), 'a photo of a beach');
  writeFileSync(path.join(HOME, 'library', 'Trip', 'sunset.txt'), 'a photo of a sunset');
  mkdirSync(path.join(localLibrary, 'Inbox'), { recursive: true });

  handle = await serverApp.start(configLib.load());

  const secrets = connections.makeSecretStore(fakeKeychain());
  const myConfig = {};
  const address = `127.0.0.1:${HTTPS_PORT}`;

  // --- pairing --------------------------------------------------------------

  const added = await connections.add(myConfig, {
    address, username: 'admin', password: PASSWORD, label: 'The Windows box',
  }, { secrets });

  check('a machine can be paired with', Boolean(added.id));
  check('and its certificate is pinned at that moment',
    /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/.test(added.fingerprint || ''), added.fingerprint);
  check('the label is kept', added.label === 'The Windows box');

  // The point of the keychain: the password must not be in the config object
  // that gets written to config.json.
  const serialized = JSON.stringify(myConfig);
  check('the password is nowhere in the saved config',
    !serialized.includes(PASSWORD), serialized.slice(0, 200));
  check('only an opaque blob is stored', added.secret && added.secret !== PASSWORD);

  {
    const wrong = await connections.add(myConfig, {
      address, username: 'admin', password: 'not the password', label: 'nope',
    }, { secrets }).then(() => null, (err) => err);
    check('pairing with a wrong password fails rather than saving something broken',
      wrong !== null, 'it was accepted');
    check('and nothing is added to the list',
      connections.list(myConfig).length === 1, String(connections.list(myConfig).length));
  }

  {
    const duplicate = await connections.add(myConfig, {
      address, username: 'admin', password: PASSWORD,
    }, { secrets }).then(() => null, (err) => err);
    check('the same machine and user cannot be added twice', duplicate?.status === 409);
  }

  {
    const notLanshare = await connections.add(myConfig, {
      address: '127.0.0.1:9', username: 'admin', password: PASSWORD,
    }, { secrets }).then(() => null, (err) => err);
    check('an address with nothing there is refused', notLanshare !== null);
  }

  // --- what the list exposes ------------------------------------------------

  {
    const [entry] = connections.list(myConfig);
    const fields = Object.keys(entry).sort().join(',');
    check('the list never carries the secret itself',
      !fields.includes('secret') && !JSON.stringify(entry).includes(PASSWORD), fields);
    check('but does say whether a password is saved', entry.hasSavedPassword === true);
  }

  // --- connecting -----------------------------------------------------------

  const host = await connections.connect(myConfig, added.id, { secrets });
  check('a saved connection signs in without asking again', Boolean(host.cookie));

  const listing = await host.list('/Trip');
  check('the other library can be browsed',
    listing.files?.length === 2, JSON.stringify(listing.files?.map((f) => f.name)));

  // --- copying, both ways ---------------------------------------------------

  {
    const result = await connections.copyFiles(host, {
      direction: 'download',
      remoteDir: '/Trip',
      localDir: path.join(localLibrary, 'Inbox'),
      files: ['beach.txt', 'sunset.txt'],
      fsp,
      path,
    });

    check('files copy from the other machine', result.copied.length === 2, JSON.stringify(result));
    check('with their contents intact',
      readFileSync(path.join(localLibrary, 'Inbox', 'beach.txt'), 'utf8') === 'a photo of a beach');
    check('and the byte count is reported', result.bytes > 0, String(result.bytes));
    check('leaving no partial files behind',
      !readdirSync(path.join(localLibrary, 'Inbox')).some((n) => n.endsWith('.lanshare-part')),
      readdirSync(path.join(localLibrary, 'Inbox')).join(','));
  }

  {
    writeFileSync(path.join(localLibrary, 'Inbox', 'from-here.txt'), 'sent from the laptop');
    const result = await connections.copyFiles(host, {
      direction: 'upload',
      remoteDir: '/Trip',
      localDir: path.join(localLibrary, 'Inbox'),
      files: ['from-here.txt'],
      fsp,
      path,
    });

    check('files copy to the other machine', result.copied.length === 1, JSON.stringify(result));
    check('and really arrive there',
      readFileSync(path.join(HOME, 'library', 'Trip', 'from-here.txt'), 'utf8') === 'sent from the laptop');
  }

  {
    // One bad file must not abandon the rest of the batch.
    const result = await connections.copyFiles(host, {
      direction: 'download',
      remoteDir: '/Trip',
      localDir: path.join(localLibrary, 'Inbox'),
      files: ['beach.txt', 'does-not-exist.txt', 'sunset.txt'],
      fsp,
      path,
    });
    check('a missing file is reported without stopping the others',
      result.copied.length === 2 && result.failed.length === 1,
      JSON.stringify({ copied: result.copied, failed: result.failed }));
    check('and the failure names the file', result.failed[0].name === 'does-not-exist.txt');
  }

  {
    const seen = [];
    await connections.copyFiles(host, {
      direction: 'download',
      remoteDir: '/Trip',
      localDir: path.join(localLibrary, 'Inbox'),
      files: ['beach.txt', 'sunset.txt'],
      fsp,
      path,
      onProgress: (p) => seen.push(p),
    });
    check('progress is reported per file', seen.length === 2, String(seen.length));
    check('and counts up to the total', seen[1]?.done === 2 && seen[1]?.total === 2);
  }

  // --- a machine with no keychain -------------------------------------------

  {
    const noKeychain = connections.makeSecretStore(fakeKeychain({ available: false }));
    check('a machine without a keychain reports it', noKeychain.available === false);

    const bare = {};
    const record = await connections.add(bare, {
      address, username: 'admin', password: PASSWORD,
    }, { secrets: noKeychain });
    check('pairing still works there', Boolean(record.id));
    check('but no password is written anywhere', record.secret === null);
    check('and nothing resembling it is in the config',
      !JSON.stringify(bare).includes(PASSWORD));

    const refused = await connections.connect(bare, record.id, { secrets: noKeychain })
      .then(() => null, (err) => err);
    check('connecting then asks for the password rather than failing obscurely',
      refused?.status === 401 && /password/i.test(refused.message), refused?.message);

    const withPassword = await connections.connect(bare, record.id, {
      password: PASSWORD, secrets: noKeychain,
    });
    check('and supplying it connects', Boolean(withPassword.cookie));
  }

  // --- a keychain that cannot read its own blob ------------------------------

  {
    // What a restored backup or a different user account looks like: the blob
    // is there but undecryptable. It must ask, not crash.
    const broken = connections.makeSecretStore({
      isEncryptionAvailable: () => true,
      encryptString: (p) => Buffer.from(`enc:${p}`),
      decryptString: () => { throw new Error('keychain says no'); },
    });
    check('an unreadable saved password reads as absent', broken.decrypt('anything') === null);

    const failed = await connections.connect(myConfig, added.id, { secrets: broken })
      .then(() => null, (err) => err);
    check('and connecting asks for it rather than throwing a keychain error',
      failed?.status === 401, failed?.message);
  }

  // --- the same connection, but over the internet --------------------------
  // A relayed host has to behave identically to a direct one, or the Machines
  // screen would need a second code path for "the same thing, further away".

  {
    const tunnel = require(path.join(here, '..', 'lib', 'tunnel.js'));
    const { createRelay } = require(path.join(here, '..', 'relay', 'server.js'));

    const relay = createRelay({ log: () => {} });
    await relay.listen(8544, '127.0.0.1');

    const pairing = tunnel.createPairing();
    const tunnelHost = new tunnel.TunnelHost({
      relayHost: '127.0.0.1',
      relayPort: 8544,
      pairing,
      localPort: 8541,
      log: () => {},
    });
    tunnelHost.start();

    const relayConfig = {};
    const record = await connections.addByCode(relayConfig, {
      code: pairing.code,
      relayHost: '127.0.0.1',
      relayPort: 8544,
      username: 'admin',
      password: PASSWORD,
      label: 'Home machine',
    }, { secrets });

    check('a machine can be paired with over the internet', Boolean(record.id));
    check('and is marked as reached through a relay', record.via === 'relay');
    check('the pairing code is not left in the config either',
      !JSON.stringify(relayConfig).includes(pairing.code.replace(/-/g, '')),
      'the code was stored in the clear');

    const wrongCode = await connections.addByCode(relayConfig, {
      code: tunnel.createPairing().code,
      relayHost: '127.0.0.1',
      relayPort: 8544,
      username: 'admin',
      password: PASSWORD,
    }, { secrets }).then(() => null, (err) => err);
    check('a code nobody is listening for fails rather than hanging', wrongCode !== null,
      'it connected to nothing');

    const relayed = await connections.connect(relayConfig, record.id, { secrets });
    check('a relayed connection signs in', Boolean(relayed.cookie));

    const remoteListing = await relayed.list('/Trip');
    check('and browses the other library exactly like a direct one',
      remoteListing.files?.some((f) => f.name === 'beach.txt'),
      JSON.stringify(remoteListing.files?.map((f) => f.name)));

    // The real proof that it is the same interface: the copy helper is used
    // unchanged, with no idea which kind of connection it holds.
    const copied = await connections.copyFiles(relayed, {
      direction: 'download',
      remoteDir: '/Trip',
      localDir: path.join(localLibrary, 'ViaRelay'),
      files: ['beach.txt'],
      fsp,
      path,
    });
    check('files copy over the internet through the same code path',
      copied.copied.length === 1, JSON.stringify(copied));
    check('with contents intact',
      readFileSync(path.join(localLibrary, 'ViaRelay', 'beach.txt'), 'utf8') === 'a photo of a beach');

    relayed.close?.();
    tunnelHost.stop();
    await relay.close();
  }

  // --- removing --------------------------------------------------------------

  {
    connections.remove(myConfig, added.id);
    check('a connection can be removed', connections.list(myConfig).length === 0);
    check('and the copied files stay where they were',
      existsSync(path.join(localLibrary, 'Inbox', 'beach.txt')));

    let error = null;
    try { connections.remove(myConfig, 'nope'); } catch (err) { error = err; }
    check('removing one that is not there is a clean 404', error?.status === 404);
  }
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error -> ${err.stack || err.message}`);
} finally {
  if (handle) await handle.stop().catch(() => {});
  rmSync(HOME, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
