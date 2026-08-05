/**
 * Album vaults: creating them, finding which vault owns a path, and the
 * in-memory lock state.
 *
 *   node test/vaults.mjs
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const vaults = require(path.join(here, '..', 'lib', 'vaults.js'));
const vaultCrypto = require(path.join(here, '..', 'lib', 'crypto', 'vault.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

async function expectReject(name, fn, matcher = /./) {
  try {
    await fn();
    check(name, false, 'expected it to throw, but it resolved');
  } catch (err) {
    const ok = matcher.test(err.message);
    check(name, ok, ok ? '' : `threw: ${err.message}`);
  }
}

const library = mkdtempSync(path.join(tmpdir(), 'lanshare-vaults-'));
const PASSPHRASE = 'a good long passphrase';

try {
  const albumAbs = path.join(library, 'Private');
  mkdirSync(albumAbs, { recursive: true });

  // --- creating -------------------------------------------------------------

  const metadata = await vaults.createVault(albumAbs, { passphrase: PASSPHRASE });
  check('creating a vault writes its metadata into the album',
    existsSync(path.join(albumAbs, vaults.VAULT_FILE)));
  check('the metadata carries an id and one key', Boolean(metadata.id) && metadata.keys.length === 1);
  check('a freshly created vault starts unlocked', vaults.isUnlocked(metadata.id));

  const onDisk = JSON.parse(readFileSync(path.join(albumAbs, vaults.VAULT_FILE), 'utf8'));
  const masterKey = vaults.masterKeyFor(metadata.id);
  check('the master key is not written to disk',
    !JSON.stringify(onDisk).includes(masterKey.toString('base64'))
    && !JSON.stringify(onDisk).includes(masterKey.toString('hex')));
  check('the passphrase is not written to disk',
    !JSON.stringify(onDisk).includes(PASSPHRASE));

  await expectReject('making the same album a vault twice is refused',
    () => vaults.createVault(albumAbs, { passphrase: PASSPHRASE }), /already a vault/i);

  await expectReject('a vault on a non-existent album is refused',
    () => vaults.createVault(path.join(library, 'Nope'), { passphrase: PASSPHRASE }), /does not exist/i);

  // Encrypting an album that already has files in it is a bulk rewrite with
  // real failure modes, so it is refused rather than half-done.
  const occupied = path.join(library, 'Holiday');
  mkdirSync(occupied, { recursive: true });
  writeFileSync(path.join(occupied, 'beach.jpg'), 'not really a jpeg');
  await expectReject('turning a non-empty album into a vault is refused',
    () => vaults.createVault(occupied, { passphrase: PASSPHRASE }), /empty album/i);

  // --- which vault owns a path ---------------------------------------------

  mkdirSync(path.join(albumAbs, 'Sub', 'Deeper'), { recursive: true });

  const direct = vaults.findVault(library, '/Private');
  check('a vault album finds itself', direct?.metadata.id === metadata.id);

  const nested = vaults.findVault(library, '/Private/Sub/Deeper/photo.jpg');
  check('a file deep inside a vault is covered by it', nested?.metadata.id === metadata.id);
  check('the covering vault reports its own album path', nested?.albumRel === '/Private');

  check('a path outside any vault finds nothing',
    vaults.findVault(library, '/Holiday/beach.jpg') === null);
  check('the library root itself is not a vault',
    vaults.findVault(library, '/') === null);

  // An inner vault governs its own contents, not the outer one.
  const innerAbs = path.join(albumAbs, 'Sub', 'Inner');
  mkdirSync(innerAbs, { recursive: true });
  const innerMeta = await vaults.createVault(innerAbs, { passphrase: 'another long passphrase' });
  const innerFound = vaults.findVault(library, '/Private/Sub/Inner/thing.png');
  check('a vault nested inside a vault governs its own contents',
    innerFound?.metadata.id === innerMeta.id, innerFound?.albumRel);
  check('the outer vault still governs paths outside the inner one',
    vaults.findVault(library, '/Private/Sub/other.png')?.metadata.id === metadata.id);

  // --- lock and unlock ------------------------------------------------------

  vaults.lockVault(metadata.id);
  check('locking drops the key', !vaults.isUnlocked(metadata.id));
  check('a locked vault has no master key', vaults.masterKeyFor(metadata.id) === null);

  await expectReject('a wrong passphrase does not unlock',
    () => vaults.unlockVault(metadata, 'not the passphrase'), /wrong passphrase/i);
  check('it is still locked after a failed attempt', !vaults.isUnlocked(metadata.id));

  await vaults.unlockVault(metadata, PASSPHRASE);
  check('the right passphrase unlocks it', vaults.isUnlocked(metadata.id));
  check('the recovered key matches the original',
    vaults.masterKeyFor(metadata.id).equals(masterKey));

  // --- auto-lock ------------------------------------------------------------

  await vaults.unlockVault(metadata, PASSPHRASE, 60);
  check('a vault is unlocked immediately after unlocking', vaults.isUnlocked(metadata.id));

  // Backdate rather than waiting out a real hour.
  vaults._expire(metadata.id);
  check('a vault past its inactivity window reports locked', !vaults.isUnlocked(metadata.id));
  check('and hands back no key once expired', vaults.masterKeyFor(metadata.id) === null);

  // Activity must push the window out, or a vault would lock mid-browse.
  await vaults.unlockVault(metadata, PASSPHRASE, 60);
  vaults.masterKeyFor(metadata.id); // a read counts as activity
  check('using a vault keeps it unlocked', vaults.isUnlocked(metadata.id));

  // --- context for a path ---------------------------------------------------

  const ctx = vaults.contextFor(library, '/Private/Sub/Deeper/photo.jpg');
  check('contextFor reports the governing vault', ctx?.albumRel === '/Private');
  check('contextFor reports it as unlocked', ctx?.unlocked === true);
  check('contextFor hands back a usable master key', Buffer.isBuffer(ctx?.masterKey));
  check('contextFor reports the vault type', ctx?.type === 'server');

  vaults.lockVault(metadata.id);
  const lockedCtx = vaults.contextFor(library, '/Private/Sub/Deeper/photo.jpg');
  check('a locked vault still reports itself as governing the path', lockedCtx?.albumRel === '/Private');
  check('a locked vault reports unlocked: false', lockedCtx?.unlocked === false);
  check('a locked vault hands back no key', lockedCtx?.masterKey === null);

  check('a path outside any vault has no context',
    vaults.contextFor(library, '/Holiday/beach.jpg') === null);

  // --- per-file keys through the vault --------------------------------------

  await vaults.unlockVault(metadata, PASSPHRASE);
  const live = vaults.masterKeyFor(metadata.id);
  const { fileKey, wrappedKey } = vaults.newFileKey(live);
  check('a per-file key round-trips through the vault master key',
    vaults.fileKeyFrom(live, wrappedKey).equals(fileKey));

  // --- listing --------------------------------------------------------------

  const list = await vaults.listVaults(library);
  const paths = list.map((v) => v.path).sort();
  check('listVaults finds both vaults', paths.length === 2, JSON.stringify(paths));
  check('listVaults finds the nested one too', paths.includes('/Private/Sub/Inner'), JSON.stringify(paths));
  check('listVaults reports lock state',
    list.find((v) => v.path === '/Private')?.unlocked === true);
  check('listVaults never leaks key material',
    !JSON.stringify(list).includes(live.toString('base64')));

  // --- lockAll --------------------------------------------------------------

  vaults.lockAll();
  check('lockAll drops every key',
    !vaults.isUnlocked(metadata.id) && !vaults.isUnlocked(innerMeta.id));

  // --- recovery code path ---------------------------------------------------

  const code = vaultCrypto.formatRecoveryCode(masterKey);
  vaults.unlockWithRecoveryCode(metadata, code);
  check('a recovery code unlocks the vault', vaults.isUnlocked(metadata.id));

  vaults.lockAll();
  await expectReject('an unrelated recovery code is refused',
    async () => vaults.unlockWithRecoveryCode(metadata, vaultCrypto.formatRecoveryCode(Buffer.alloc(32, 7))),
    /does not belong/i);
} finally {
  vaults.lockAll();
  rmSync(library, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
