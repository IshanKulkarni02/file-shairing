/**
 * Being a client of another LANShare host.
 *
 * Runs a real second server on this machine and talks to it over real HTTPS
 * with a real self-signed certificate, because the interesting part is
 * exactly the certificate handling that a mocked transport would skip.
 *
 *   node test/remote.mjs
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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

// The remote host needs its own LANSHARE_HOME, set before lib/config loads.
const HOME = mkdtempSync(path.join(tmpdir(), 'lanshare-remote-'));
process.env.LANSHARE_HOME = HOME;

const configLib = require(path.join(here, '..', 'lib', 'config.js'));
const serverApp = require(path.join(here, '..', 'lib', 'server-app.js'));
const remote = require(path.join(here, '..', 'lib', 'remote.js'));

const PASSWORD = 'a properly long remote password';
const HTTP_PORT = 8531;
const HTTPS_PORT = 8532;

let handle = null;

try {
  const { config } = configLib.loadOrCreate();
  config.port = HTTP_PORT;
  config.httpsPort = HTTPS_PORT;
  configLib.save(config);
  configLib.setUser('admin', PASSWORD);

  mkdirSync(path.join(HOME, 'library', 'Shared'), { recursive: true });
  writeFileSync(path.join(HOME, 'library', 'Shared', 'holiday.txt'), 'a photo from the other machine');

  handle = await serverApp.start(configLib.load());
  check('the other host is running', Boolean(handle));

  // --- addresses people actually type --------------------------------------

  check('a bare address gets a scheme and the default secure port',
    remote.normalizeBase('192.168.1.20') === 'https://192.168.1.20:8443',
    remote.normalizeBase('192.168.1.20'));
  check('an address with a port keeps it',
    remote.normalizeBase('192.168.1.20:9000') === 'https://192.168.1.20:9000');
  check('a full URL is accepted as given',
    remote.normalizeBase('http://box.local:8420') === 'http://box.local:8420');
  check('an empty address is refused', (() => {
    try { remote.normalizeBase('   '); return false; } catch { return true; }
  })());

  // --- identifying a host before trusting it with a password ---------------

  const probed = await remote.probe(`127.0.0.1:${HTTPS_PORT}`);
  check('a host can be identified before signing in', probed.isLanshare === true);
  check('and its certificate fingerprint is reported',
    /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/.test(probed.fingerprint || ''), probed.fingerprint);

  // --- the pinning that makes self-signed HTTPS worth anything -------------

  {
    const host = new remote.RemoteHost({ base: probed.base, fingerprint: probed.fingerprint });
    await host.signIn('admin', PASSWORD);
    check('signing in with the right fingerprint works', Boolean(host.cookie));

    const listing = await host.list('/Shared');
    check('the remote library can be listed',
      listing.files?.some((f) => f.name === 'holiday.txt'), JSON.stringify(listing.files));

    const bytes = await host.download('/Shared/holiday.txt');
    check('and a file downloaded from it',
      bytes.toString('utf8') === 'a photo from the other machine', bytes.toString('utf8'));
  }

  {
    // The whole point: a different certificate must be refused, because that
    // is what an impostor on the network looks like.
    const wrong = 'AA:'.repeat(31) + 'AA';
    const host = new remote.RemoteHost({ base: probed.base, fingerprint: wrong });

    // Deliberately the *correct* password, so that if the request went out at
    // all the remote host would accept it and record a session. That is the
    // property worth proving: refusing after leaking the password would be
    // no protection at all.
    const sessions = require(path.join(here, '..', 'lib', 'sessions.js'));
    const before = sessions.list('admin').length;

    let error = null;
    try { await host.signIn('admin', PASSWORD); } catch (err) { error = err; }
    check('a host presenting a different certificate is refused', error !== null);
    check('and the message explains what that means rather than saying "TLS error"',
      /impostor|certificate has\s+changed/i.test(error?.message || ''), error?.message);
    check('no session is established with the wrong host', host.cookie === null);

    const after = sessions.list('admin').length;
    check('and the password was never sent to it at all',
      after === before, `sessions went ${before} -> ${after}, so the login was delivered`);
  }

  {
    // Pinning must not be optional-by-accident: with no fingerprint recorded
    // yet the first connection is allowed, which is the documented trade-off.
    const host = new remote.RemoteHost({ base: probed.base, fingerprint: null });
    await host.signIn('admin', PASSWORD);
    check('a first connection with nothing pinned yet is allowed', Boolean(host.cookie));
  }

  // --- credentials and sessions --------------------------------------------

  {
    const host = new remote.RemoteHost({ base: probed.base, fingerprint: probed.fingerprint });
    let error = null;
    try { await host.signIn('admin', 'the wrong password'); } catch (err) { error = err; }
    check('a wrong password is refused', error !== null, 'it signed in anyway');
    check('and does not leave a session behind', host.cookie === null);

    await host.signIn('admin', PASSWORD);
    host.signOut();
    check('signing out forgets the session', host.cookie === null);

    let listError = null;
    try { await host.list('/'); } catch (err) { listError = err; }
    check('and listing afterwards is refused', listError?.status === 401, listError?.message);
  }

  // --- uploading to the other machine --------------------------------------

  {
    const host = new remote.RemoteHost({ base: probed.base, fingerprint: probed.fingerprint });
    await host.signIn('admin', PASSWORD);

    const payload = Buffer.from('sent from the laptop');
    await host.upload('/Shared', 'from-laptop.txt', payload);

    const landed = readFileSync(path.join(HOME, 'library', 'Shared', 'from-laptop.txt'), 'utf8');
    check('a file can be uploaded to the other machine', landed === 'sent from the laptop', landed);

    const back = await host.download('/Shared/from-laptop.txt');
    check('and read back from it byte for byte', back.equals(payload));
  }

  {
    // Binary must survive the multipart encoding, not just ASCII.
    const host = new remote.RemoteHost({ base: probed.base, fingerprint: probed.fingerprint });
    await host.signIn('admin', PASSWORD);

    const binary = Buffer.alloc(200_000);
    for (let i = 0; i < binary.length; i++) binary[i] = (i * 37) % 256;
    await host.upload('/Shared', 'binary.bin', binary);

    const back = await host.download('/Shared/binary.bin');
    check('binary content survives the round trip unchanged',
      back.equals(binary), `${back.length} bytes vs ${binary.length}`);
  }

  // --- failures that should read as English --------------------------------

  {
    let error = null;
    try { await remote.probe('127.0.0.1:9', { timeoutMs: 3000 }); } catch (err) { error = err; }
    check('an address with nothing listening says so plainly',
      /nothing is listening/i.test(error?.message || ''), error?.message);
  }

  {
    const host = new remote.RemoteHost({ base: probed.base, fingerprint: probed.fingerprint });
    await host.signIn('admin', PASSWORD);
    let error = null;
    try { await host.download('/Shared/not-there.txt'); } catch (err) { error = err; }
    check('downloading a file that is not there fails cleanly',
      error !== null && error.status === 404, `${error?.status}: ${error?.message}`);
  }

  // --- plain HTTP still works, without pretending to be verified -----------

  {
    const host = new remote.RemoteHost({ base: `http://127.0.0.1:${HTTP_PORT}` });
    await host.signIn('admin', PASSWORD);
    const listing = await host.list('/Shared');
    check('a host reached over plain HTTP also works',
      listing.files?.some((f) => f.name === 'holiday.txt'));
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
