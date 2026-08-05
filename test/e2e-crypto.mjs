/**
 * Cross-implementation test for end-to-end vaults.
 *
 * public/vaultcrypto.js (WebCrypto, runs in the browser) and
 * lib/crypto/vaultfile.js + lib/crypto/vault.js (Node crypto, runs on the
 * server) are two independent implementations of one on-disk format. That is
 * unavoidable — for an end-to-end vault the server has no key, so the
 * browser must do its own crypto — but it means the two can drift, and a
 * drift means files encrypted on one side become unreadable on the other.
 *
 * So this does not test either implementation against itself. It encrypts
 * with each and decrypts with the *other*, in both directions, at the sizes
 * where chunk boundaries land.
 *
 * Node exposes the same WebCrypto API the browser does, so the browser
 * module runs here unmodified.
 *
 *   node test/e2e-crypto.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const browser = require(path.join(here, '..', 'public', 'vaultcrypto.js'));
const vaultfile = require(path.join(here, '..', 'lib', 'crypto', 'vaultfile.js'));
const vault = require(path.join(here, '..', 'lib', 'crypto', 'vault.js'));

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
    check(name, matcher.test(err.message), `threw: ${err.message}`);
  }
}

const dir = mkdtempSync(path.join(tmpdir(), 'lanshare-e2e-'));
// Real iteration counts make PBKDF2 slow; the count is a stored parameter, so
// a low one exercises identical code paths on both sides.
const FAST = 1000;
const PASSPHRASE = 'a properly long passphrase';
let n = 0;
const tmpFile = () => path.join(dir, `x${n++}.enc`);

try {
  check('WebCrypto is available to the browser module', browser.available === true);

  // --- the same passphrase derives the same key on both sides -------------
  // If this diverges nothing else can possibly work.

  const salt = crypto.randomBytes(16);
  const nodeKek = await vault.deriveKek(PASSPHRASE, salt, FAST);
  const browserKek = await browser.deriveKek(PASSPHRASE, new Uint8Array(salt), FAST);
  check('PBKDF2 derives an identical key in Node and WebCrypto',
    Buffer.from(browserKek).equals(nodeKek),
    `${Buffer.from(browserKek).toString('hex').slice(0, 16)} vs ${nodeKek.toString('hex').slice(0, 16)}`);

  // --- a vault created server-side unlocks in the browser -----------------

  const { metadata, masterKey } = await vault.createVault({
    passphrase: PASSPHRASE, type: 'e2e', iterations: FAST,
  });
  check('a vault can be created with type e2e', metadata.type === 'e2e');

  const browserMaster = await browser.unlockVault(metadata, PASSPHRASE);
  check('the browser unlocks a vault the server created',
    Buffer.from(browserMaster).equals(masterKey));

  await expectReject('the browser refuses a wrong passphrase',
    () => browser.unlockVault(metadata, 'not the passphrase'), /wrong passphrase/i);

  check('the browser can verify a master key belongs to the vault',
    await browser.verifyMasterKey(metadata, browserMaster) === true);

  await expectReject('the browser refuses an unrelated master key',
    () => browser.verifyMasterKey(metadata, crypto.randomBytes(32)), /does not belong/i);

  // --- file keys interoperate ---------------------------------------------

  const browserFileKey = await browser.newFileKey(browserMaster);
  const unwrappedInNode = vault.unwrapFileKey(masterKey, Buffer.from(browserFileKey.wrappedKey));
  check('a file key wrapped in the browser unwraps in Node',
    unwrappedInNode.equals(Buffer.from(browserFileKey.fileKey)));

  const nodeFileKey = vault.createFileKey(masterKey);
  const unwrappedInBrowser = await browser.unwrapFileKey(
    browserMaster, new Uint8Array(nodeFileKey.wrappedKey),
  );
  check('a file key wrapped in Node unwraps in the browser',
    Buffer.from(unwrappedInBrowser).equals(nodeFileKey.fileKey));

  // --- whole files, both directions, across the interesting sizes ---------
  // A small chunk size exercises the same boundary logic as the real 1 MiB
  // one without moving megabytes around.

  const CS = 1024;
  const sizes = [
    ['empty', 0],
    ['one byte', 1],
    ['just under a chunk', CS - 1],
    ['exactly one chunk', CS],
    ['one byte over', CS + 1],
    ['exactly two chunks', CS * 2],
    ['two and a bit', CS * 2 + 7],
  ];

  for (const [label, size] of sizes) {
    const plaintext = crypto.randomBytes(size);

    // Browser encrypts -> Node decrypts. This is the upload path.
    const encrypted = await browser.encryptFile(new Uint8Array(plaintext), browserMaster, { chunkSize: CS });
    const file = tmpFile();
    require('fs').writeFileSync(file, Buffer.from(encrypted));

    const { header } = await vaultfile.readHeader(file);
    const fileKey = vault.unwrapFileKey(masterKey, header.wrappedKey);
    const backInNode = await vaultfile.decryptToBuffer(file, fileKey);
    check(`browser -> Node: ${label} (${size} bytes)`,
      backInNode.equals(plaintext), `got ${backInNode.length}`);

    // Node encrypts -> browser decrypts. This is the download path.
    const nodeFile = tmpFile();
    const nk = vault.createFileKey(masterKey);
    await vaultfile.encryptBufferToFile(plaintext, nodeFile, {
      fileKey: nk.fileKey, wrappedKey: nk.wrappedKey, chunkSize: CS,
    });
    const nodeBytes = require('fs').readFileSync(nodeFile);
    const backInBrowser = await browser.decryptFile(new Uint8Array(nodeBytes), browserMaster);
    check(`Node -> browser: ${label} (${size} bytes)`,
      Buffer.from(backInBrowser).equals(plaintext), `got ${backInBrowser.length}`);
  }

  // Once at the real chunk size, to prove the default path is not special.
  const big = crypto.randomBytes(vaultfile.CHUNK_SIZE + 4321);
  const bigEncrypted = await browser.encryptFile(new Uint8Array(big), browserMaster);
  const bigFile = tmpFile();
  require('fs').writeFileSync(bigFile, Buffer.from(bigEncrypted));
  const bigHeader = (await vaultfile.readHeader(bigFile)).header;
  const bigKey = vault.unwrapFileKey(masterKey, bigHeader.wrappedKey);
  check('browser -> Node at the real 1 MiB chunk size',
    (await vaultfile.decryptToBuffer(bigFile, bigKey)).equals(big));

  // --- a ranged read of browser-written ciphertext -------------------------
  // The server still serves ranges over end-to-end files (it is just moving
  // opaque bytes), so the chunking must line up exactly.

  const rangeSource = crypto.randomBytes(CS * 3 + 100);
  const rangeEncrypted = await browser.encryptFile(new Uint8Array(rangeSource), browserMaster, { chunkSize: CS });
  const rangeFile = tmpFile();
  require('fs').writeFileSync(rangeFile, Buffer.from(rangeEncrypted));
  const rangeHeader = (await vaultfile.readHeader(rangeFile)).header;
  const rangeKey = vault.unwrapFileKey(masterKey, rangeHeader.wrappedKey);
  const rangeMeta = await vaultfile.readMetadata(rangeFile, rangeKey);
  check('Node reads the true plaintext size from browser-written ciphertext',
    rangeMeta.plaintextSize === rangeSource.length,
    `${rangeMeta.plaintextSize} vs ${rangeSource.length}`);

  const parts = [];
  for await (const piece of vaultfile.createDecryptStream(
    rangeFile, rangeKey, rangeMeta, { start: CS - 5, end: CS + 5 })) {
    parts.push(piece);
  }
  check('a range across a chunk boundary of browser ciphertext is correct',
    Buffer.concat(parts).equals(rangeSource.subarray(CS - 5, CS + 6)));

  // --- tamper detection holds in the browser implementation too -----------

  const victim = await browser.encryptFile(new Uint8Array(crypto.randomBytes(CS * 2)), browserMaster, { chunkSize: CS });

  const flipped = victim.slice();
  flipped[Math.floor(flipped.length / 2)] ^= 0x01;
  await expectReject('the browser catches a flipped bit',
    () => browser.decryptFile(flipped, browserMaster), /failed|altered|length/i);

  await expectReject('the browser catches a dropped trailer',
    () => browser.decryptFile(victim.slice(0, victim.length - 24), browserMaster),
    /trailer|truncated|length|failed/i);

  await expectReject('the browser refuses a wrong master key',
    () => browser.decryptFile(victim, crypto.randomBytes(32)), /failed|altered/i);

  await expectReject('the browser refuses a file that is not a vault file',
    () => browser.decryptFile(new Uint8Array(Buffer.from('just an ordinary file here')), browserMaster),
    /magic|vault file/i);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
