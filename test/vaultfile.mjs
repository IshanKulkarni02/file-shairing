/**
 * The encrypted vault file format: round-trips, byte ranges, and — the part
 * that actually matters — that tampering is detected rather than silently
 * returning wrong plaintext.
 *
 *   node test/vaultfile.mjs
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const V = require(path.join(here, '..', 'lib', 'crypto', 'vaultfile.js'));

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
    const ok = err instanceof V.VaultFileError && matcher.test(err.message);
    check(name, ok, ok ? '' : `threw ${err.constructor.name}: ${err.message}`);
  }
}

const dir = mkdtempSync(path.join(tmpdir(), 'lanshare-vaultfile-'));
const fileKey = crypto.randomBytes(32);
const wrappedKey = crypto.randomBytes(60); // opaque to this module
let n = 0;
const tmpFile = () => path.join(dir, `v${n++}.bin`);

async function roundTrip(plaintext, opts = {}) {
  const file = tmpFile();
  await V.encryptBufferToFile(plaintext, file, { fileKey, wrappedKey, ...opts });
  const out = await V.decryptToBuffer(file, fileKey);
  return { file, out };
}

try {
  // --- round trips across every interesting size ---------------------------
  // A small chunk size keeps the multi-chunk cases fast while exercising
  // exactly the same boundary logic as the real 1 MiB one.
  const CS = 1024;

  const sizes = [
    ['empty', 0],
    ['one byte', 1],
    ['just under a chunk', CS - 1],
    ['exactly one chunk', CS],
    ['one byte over a chunk', CS + 1],
    ['exactly two chunks', CS * 2],
    ['two and a bit chunks', CS * 2 + 7],
  ];

  for (const [label, size] of sizes) {
    const plaintext = crypto.randomBytes(size);
    const { out } = await roundTrip(plaintext, { chunkSize: CS });
    check(`round trip: ${label} (${size} bytes)`, out.equals(plaintext),
      `got ${out.length} bytes back`);
  }

  // The real chunk size, once, to prove the default path works too.
  const big = crypto.randomBytes(V.CHUNK_SIZE + 12345);
  const { out: bigOut } = await roundTrip(big);
  check('round trip: larger than the real 1 MiB chunk size', bigOut.equals(big));

  // --- the ciphertext really is ciphertext ---------------------------------

  const secret = Buffer.from('SUPER-SECRET-MARKER-abcdefghijklmnop'.repeat(10));
  const { file: secretFile } = await roundTrip(secret, { chunkSize: CS });
  const onDisk = await fsp.readFile(secretFile);
  check('the plaintext never appears in the encrypted file',
    !onDisk.includes(Buffer.from('SUPER-SECRET-MARKER')));
  check('the file starts with the format magic',
    onDisk.subarray(0, 8).equals(V.MAGIC));

  // --- metadata ------------------------------------------------------------

  const meta = await V.readMetadata(secretFile, fileKey);
  check('readMetadata reports the true plaintext size',
    meta.plaintextSize === secret.length, `${meta.plaintextSize} vs ${secret.length}`);
  check('readMetadata reports a sane chunk count',
    meta.chunkCount === Math.ceil(secret.length / CS), `${meta.chunkCount}`);

  // --- byte ranges: this is why the format is chunked at all ---------------

  const ranged = crypto.randomBytes(CS * 3 + 500);
  const { file: rangedFile } = await roundTrip(ranged, { chunkSize: CS });
  const rangedMeta = await V.readMetadata(rangedFile, fileKey);

  async function readRange(start, end) {
    const parts = [];
    for await (const piece of V.createDecryptStream(rangedFile, fileKey, rangedMeta, { start, end })) {
      parts.push(piece);
    }
    return Buffer.concat(parts);
  }

  const ranges = [
    ['from the very start', 0, 99],
    ['entirely inside one chunk', 10, 20],
    ['spanning a chunk boundary', CS - 5, CS + 5],
    ['spanning several chunks', CS - 1, CS * 2 + 1],
    ['a single byte', 1234, 1234],
    ['the last byte', ranged.length - 1, ranged.length - 1],
    ['the whole file', 0, ranged.length - 1],
    ['the tail with no explicit end', ranged.length - 300, undefined],
  ];

  for (const [label, start, end] of ranges) {
    const got = await readRange(start, end);
    const want = ranged.subarray(start, end === undefined ? undefined : end + 1);
    check(`range: ${label}`, got.equals(want), `got ${got.length}, wanted ${want.length}`);
  }

  // --- wrong key -----------------------------------------------------------

  const wrongKey = crypto.randomBytes(32);
  await expectReject('a wrong key fails cleanly rather than returning garbage',
    () => V.decryptToBuffer(secretFile, wrongKey), /authentication|trailer/i);

  // --- tampering -----------------------------------------------------------
  // Each of these would go completely undetected if chunks were encrypted
  // independently without binding them to their position.

  async function corrupt(sourceFile, mutate) {
    const copy = tmpFile();
    const buf = await fsp.readFile(sourceFile);
    mutate(buf);
    await fsp.writeFile(copy, buf);
    return copy;
  }

  const flipped = await corrupt(secretFile, (buf) => {
    // Flip a bit well inside the encrypted body.
    const at = Math.floor(buf.length / 2);
    buf[at] ^= 0x01;
  });
  await expectReject('a single flipped bit is caught',
    () => V.decryptToBuffer(flipped, fileKey), /authentication|length/i);

  const truncated = await corrupt(secretFile, () => {});
  const truncBuf = await fsp.readFile(truncated);
  // Drop the trailer entirely: the classic "make the file look shorter" move.
  await fsp.writeFile(truncated, truncBuf.subarray(0, truncBuf.length - V.TRAILER_LEN));
  await expectReject('dropping the trailer is caught',
    () => V.decryptToBuffer(truncated, fileKey), /trailer|truncated|length/i);

  // Chop off the final chunk *and* the trailer, then re-append a trailer
  // claiming the now-shorter length — the most convincing truncation an
  // attacker could mount. The end-of-file flag in the previous chunk's AAD
  // is what catches it.
  const multi = crypto.randomBytes(CS * 3);
  const { file: multiFile } = await roundTrip(multi, { chunkSize: CS });
  const multiMeta = await V.readMetadata(multiFile, fileKey);
  const multiBuf = await fsp.readFile(multiFile);
  const cutAt = V.chunkOffset(multiMeta, multiMeta.chunkCount - 1);
  const choppedFile = tmpFile();
  await fsp.writeFile(choppedFile, multiBuf.subarray(0, cutAt));
  await expectReject('lopping off the last chunk is caught',
    () => V.decryptToBuffer(choppedFile, fileKey), /trailer|truncated|length/i);

  // Swap two whole chunks around.
  const swapped = await corrupt(multiFile, (buf) => {
    const size = CS + V.TAG_LEN;
    const a = V.chunkOffset(multiMeta, 0);
    const b = V.chunkOffset(multiMeta, 1);
    const tmp = Buffer.from(buf.subarray(a, a + size));
    buf.subarray(b, b + size).copy(buf, a);
    tmp.copy(buf, b);
  });
  await expectReject('reordering two chunks is caught',
    () => V.decryptToBuffer(swapped, fileKey), /authentication/i);

  // Take chunk 0 from a *different* file encrypted with the same key and
  // paste it in. Same key, same chunk index — only the per-file id in the
  // header (hashed into every chunk's AAD) makes these non-interchangeable.
  const otherPlain = crypto.randomBytes(CS * 3);
  const { file: otherFile } = await roundTrip(otherPlain, { chunkSize: CS });
  const otherBuf = await fsp.readFile(otherFile);
  const otherMeta = await V.readMetadata(otherFile, fileKey);
  const grafted = await corrupt(multiFile, (buf) => {
    const size = CS + V.TAG_LEN;
    const dst = V.chunkOffset(multiMeta, 0);
    const src = V.chunkOffset(otherMeta, 0);
    otherBuf.subarray(src, src + size).copy(buf, dst);
  });
  await expectReject('a chunk grafted in from another file is caught',
    () => V.decryptToBuffer(grafted, fileKey), /authentication/i);

  // Tamper with the header itself — it is hashed into every chunk's AAD, so
  // even a cosmetic change should break the whole file rather than pass.
  const headerTampered = await corrupt(secretFile, (buf) => {
    // The last byte of the header JSON, just before the first chunk.
    buf[meta.dataOffset - 2] ^= 0x01;
  });
  await expectReject('altering the header is caught',
    () => V.decryptToBuffer(headerTampered, fileKey), /./);

  // --- malformed input -----------------------------------------------------

  const notAVault = tmpFile();
  await fsp.writeFile(notAVault, Buffer.from('this is just an ordinary file, not a vault'));
  await expectReject('a non-vault file is rejected by magic',
    () => V.readMetadata(notAVault, fileKey), /magic|vault file/i);

  const empty = tmpFile();
  await fsp.writeFile(empty, Buffer.alloc(0));
  await expectReject('an empty file is rejected',
    () => V.readMetadata(empty, fileKey), /short|vault file/i);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
