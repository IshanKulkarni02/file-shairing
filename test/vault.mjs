/**
 * Vault key management: envelope encryption, multiple passphrases, recovery
 * codes, and end-to-end integration with the file format.
 *
 *   node test/vault.mjs
 */

import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const vault = require(path.join(here, '..', 'lib', 'crypto', 'vault.js'));
const vaultfile = require(path.join(here, '..', 'lib', 'crypto', 'vaultfile.js'));

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
    const ok = err instanceof vault.VaultError && matcher.test(err.message);
    check(name, ok, ok ? '' : `threw ${err.constructor.name}: ${err.message}`);
  }
}

// 600k PBKDF2 iterations is right for production and far too slow to run
// dozens of times in a test. The iteration count is a stored parameter, so
// exercising the logic at a low count tests exactly the same code paths.
const FAST = 1000;
const dir = mkdtempSync(path.join(tmpdir(), 'lanshare-vault-'));

try {
  // --- creating and unlocking ----------------------------------------------

  const { metadata, masterKey } = await vault.createVault({
    passphrase: 'correct horse battery',
    label: 'My passphrase',
    iterations: FAST,
  });

  check('a new vault has one key entry', metadata.keys.length === 1);
  check('the master key is 32 bytes', masterKey.length === 32);
  check('the vault defaults to the server-unlock type', metadata.type === 'server');
  check('the master key itself is never stored in the metadata',
    !JSON.stringify(metadata).includes(masterKey.toString('base64'))
    && !JSON.stringify(metadata).includes(masterKey.toString('hex')));

  const unlocked = await vault.unlock(metadata, 'correct horse battery');
  check('the right passphrase recovers the exact master key', unlocked.equals(masterKey));

  await expectReject('a wrong passphrase is refused',
    () => vault.unlock(metadata, 'wrong passphrase'), /wrong passphrase/i);

  await expectReject('a too-short passphrase is refused at creation',
    () => vault.createVault({ passphrase: 'short', iterations: FAST }), /at least 8/i);

  await expectReject('an unknown vault type is refused',
    () => vault.createVault({ passphrase: 'long enough passphrase', type: 'nonsense', iterations: FAST }),
    /type must be/i);

  // --- multiple passphrases: the whole reason for the envelope layer -------

  await vault.addKey(metadata, masterKey, { passphrase: 'second passphrase here', label: 'Laptop' });
  check('a second passphrase can be added', metadata.keys.length === 2);

  const viaFirst = await vault.unlock(metadata, 'correct horse battery');
  const viaSecond = await vault.unlock(metadata, 'second passphrase here');
  check('both passphrases unwrap the same master key',
    viaFirst.equals(masterKey) && viaSecond.equals(masterKey));

  check('each entry has its own salt',
    metadata.keys[0].salt !== metadata.keys[1].salt);

  await expectReject('adding a passphrase without the master key is refused',
    () => vault.addKey(metadata, Buffer.alloc(5), { passphrase: 'irrelevant here' }),
    /valid master key/i);

  // --- a key entry cannot be transplanted between vaults --------------------

  const other = await vault.createVault({ passphrase: 'a totally different one', iterations: FAST });
  const stolen = JSON.parse(JSON.stringify(metadata));
  stolen.keys.push(JSON.parse(JSON.stringify(other.metadata.keys[0])));
  await expectReject('a key entry copied in from another vault does not unlock this one',
    () => vault.unlock(stolen, 'a totally different one'), /wrong passphrase/i);

  // --- removing keys --------------------------------------------------------

  vault.removeKey(metadata, metadata.keys[1].id);
  check('a key entry can be removed', metadata.keys.length === 1);
  await expectReject('removing the last way in is refused',
    async () => vault.removeKey(metadata, metadata.keys[0].id), /only way to unlock/i);

  // --- recovery codes -------------------------------------------------------

  const code = vault.formatRecoveryCode(masterKey);
  check('a recovery code is grouped for readability', /^[0-9A-Z]{4}(-[0-9A-Z]{1,4})+$/.test(code), code);
  check('a recovery code round-trips back to the master key',
    vault.parseRecoveryCode(code).equals(masterKey));

  const recovered = vault.unlockWithRecoveryCode(metadata, code);
  check('a recovery code unlocks the vault', recovered.equals(masterKey));

  check('a recovery code survives lowercase and lost dashes',
    vault.parseRecoveryCode(code.toLowerCase().replace(/-/g, '')).equals(masterKey));

  // Crockford leaves out I, L, O and U precisely because they get misread.
  const confusable = vault.formatRecoveryCode(Buffer.alloc(32, 0));
  check('the alphabet omits the characters that get misread',
    !/[ILOU]/.test(confusable), confusable);

  // This is the case that caught a real flaw while writing this module: an
  // earlier version "verified" a recovery code by wrapping and unwrapping
  // with the same key, which always succeeds and so proved nothing. Any 32
  // random bytes would have appeared to unlock the vault.
  const bogusCode = vault.formatRecoveryCode(crypto.randomBytes(32));
  await expectReject('an unrelated recovery code is refused, not silently accepted',
    async () => vault.unlockWithRecoveryCode(metadata, bogusCode), /does not belong/i);

  await expectReject('a malformed recovery code is refused',
    async () => vault.unlockWithRecoveryCode(metadata, 'not-a-real-code'), /length|invalid/i);

  // --- per-file keys --------------------------------------------------------

  const a = vault.createFileKey(masterKey);
  const b = vault.createFileKey(masterKey);
  check('every file gets a distinct key', !a.fileKey.equals(b.fileKey));
  check('a file key round-trips through its wrapper',
    vault.unwrapFileKey(masterKey, a.wrappedKey).equals(a.fileKey));

  await expectReject('a file key does not unwrap under the wrong master key',
    async () => vault.unwrapFileKey(crypto.randomBytes(32), a.wrappedKey), /wrong passphrase|does not belong/i);

  // --- end to end with the file format --------------------------------------
  // The real shape of things: unlock a vault, mint a file key, encrypt a
  // file, then get back in with only a passphrase and read it.

  const plaintext = crypto.randomBytes(vaultfile.CHUNK_SIZE + 4321);
  const target = path.join(dir, 'photo.enc');
  const { fileKey, wrappedKey } = vault.createFileKey(masterKey);
  await vaultfile.encryptBufferToFile(plaintext, target, { fileKey, wrappedKey });

  // Everything below starts from the passphrase alone — nothing held over.
  const reopened = await vault.unlock(metadata, 'correct horse battery');
  const meta = await vaultfile.readMetadata(target, fileKey);
  const recoveredFileKey = vault.unwrapFileKey(reopened, meta.header.wrappedKey);
  check('the file key stored in the header unwraps with only the passphrase',
    recoveredFileKey.equals(fileKey));

  const readBack = await vaultfile.decryptToBuffer(target, recoveredFileKey);
  check('a file encrypted in a vault reads back byte for byte',
    readBack.equals(plaintext), `${readBack.length} vs ${plaintext.length}`);

  // And a ranged read, still starting from just the passphrase.
  const parts = [];
  const start = vaultfile.CHUNK_SIZE - 10;
  const end = vaultfile.CHUNK_SIZE + 10;
  for await (const piece of vaultfile.createDecryptStream(target, recoveredFileKey, meta, { start, end })) {
    parts.push(piece);
  }
  check('a byte range across a chunk boundary reads correctly through the vault',
    Buffer.concat(parts).equals(plaintext.subarray(start, end + 1)));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
