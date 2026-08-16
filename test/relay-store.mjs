/**
 * The relay's blob store: PUT and GET, independent of the pairing pipe it
 * sits beside. Talks to a real relay over a real socket — no mocking, since
 * what matters here (a bad key never touching the filesystem, a blob over
 * the cap being refused before anything is written, a crash-mid-write never
 * leaving a half blob visible) is exactly the kind of thing a mock would
 * paper over.
 *
 *   node test/relay-store.mjs
 */

import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { createRelay, STORE_KEY_PATTERN, MAX_BLOB_BYTES } = require(path.join(here, '..', 'relay', 'server.js'));
const { FrameReader, encodeFrame } = require(path.join(here, '..', 'lib', 'frames.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

const PORT = 8580;
const STORE_DIR = mkdtempSync(path.join(tmpdir(), 'lanshare-relay-store-'));

/** One request, one response, then the socket closes — matches the protocol. */
function storeRequest(message, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PORT, '127.0.0.1');
    const reader = new FrameReader();
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timed out')); }, timeoutMs);

    socket.on('connect', () => socket.write(encodeFrame(JSON.stringify(message))));
    socket.on('data', (chunk) => {
      const frames = reader.push(chunk);
      if (frames.length) {
        clearTimeout(timer);
        try { resolve(JSON.parse(frames[0].toString('utf8'))); } catch (err) { reject(err); }
        socket.destroy();
      }
    });
    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

const KEY_A = 'a'.repeat(32);
const KEY_B = 'b'.repeat(32);

let relay = null;

try {
  relay = createRelay({ log: () => {}, storeDir: STORE_DIR });
  await relay.listen(PORT);

  // --- basic put/get ----------------------------------------------------

  let res = await storeRequest({ type: 'store', action: 'get', key: KEY_A });
  check('getting a key nobody has stored succeeds with a null blob, not an error',
    res.ok === true && res.blob === null, JSON.stringify(res));

  const payload = Buffer.from('this is definitely ciphertext, promise').toString('base64');
  res = await storeRequest({ type: 'store', action: 'put', key: KEY_A, blob: payload });
  check('a well-formed put succeeds', res.ok === true, JSON.stringify(res));

  res = await storeRequest({ type: 'store', action: 'get', key: KEY_A });
  check('a get right after returns exactly what was put', res.blob === payload, JSON.stringify(res));
  check('and says when it was stored', typeof res.storedAt === 'string' && !Number.isNaN(Date.parse(res.storedAt)));

  // --- overwrite ----------------------------------------------------------

  const updated = Buffer.from('a newer version of the same ciphertext').toString('base64');
  res = await storeRequest({ type: 'store', action: 'put', key: KEY_A, blob: updated });
  check('putting the same key again succeeds (an update, not a duplicate)', res.ok === true);
  res = await storeRequest({ type: 'store', action: 'get', key: KEY_A });
  check('a get after an update returns the new value, not the old one', res.blob === updated, JSON.stringify(res));

  // --- a second, independent key -------------------------------------------

  const payloadB = Buffer.from('unrelated ciphertext for a different key').toString('base64');
  await storeRequest({ type: 'store', action: 'put', key: KEY_B, blob: payloadB });
  res = await storeRequest({ type: 'store', action: 'get', key: KEY_A });
  check('a second key does not disturb the first', res.blob === updated, JSON.stringify(res));
  res = await storeRequest({ type: 'store', action: 'get', key: KEY_B });
  check('and reads back correctly on its own', res.blob === payloadB, JSON.stringify(res));

  // --- validation -----------------------------------------------------------

  check('the key pattern rejects something room-id-shaped but too short',
    !STORE_KEY_PATTERN.test('short'));

  res = await storeRequest({ type: 'store', action: 'put', key: 'too-short', blob: payload });
  check('a malformed key is refused before it ever reaches the filesystem',
    res.ok === false, JSON.stringify(res));
  check('and nothing was written for it', !existsSync(path.join(STORE_DIR, 'too-short.blob')));

  res = await storeRequest({ type: 'store', action: 'get', key: '../../etc/passwd'.padEnd(32, '_') });
  check('a path-traversal-shaped key never reaches the filesystem — the pattern check rejects it outright',
    res.ok === false, JSON.stringify(res));

  // Buffer.from(str, 'base64') never throws on malformed input — it just
  // decodes what it can — and the relay has no reason to police that any
  // more strictly: the content is opaque either way, and a caller who sends
  // nonsense only ever wastes its own slot.
  res = await storeRequest({ type: 'store', action: 'put', key: KEY_A, blob: 'not valid base64!!! @@@' });
  check('malformed base64 is still accepted rather than crashing the relay', res.ok === true, JSON.stringify(res));

  const tooLarge = Buffer.alloc(MAX_BLOB_BYTES + 1024).toString('base64');
  res = await storeRequest({ type: 'store', action: 'put', key: KEY_B, blob: tooLarge });
  check('a blob over the size cap is refused', res.ok === false, JSON.stringify(res));
  res = await storeRequest({ type: 'store', action: 'get', key: KEY_B });
  check('and the previous, smaller value for that key is untouched', res.blob === payloadB, JSON.stringify(res));

  res = await storeRequest({ type: 'store', action: 'nonsense', key: KEY_A });
  check('an unknown action is refused', res.ok === false);

  // --- no half-written blobs on disk -----------------------------------------

  const filesOnDisk = readdirSync(STORE_DIR).filter((f) => f.endsWith('.blob'));
  check('only whole, renamed blobs are ever left on disk (no .part- temp files)',
    filesOnDisk.length === 2 && !readdirSync(STORE_DIR).some((f) => f.includes('.part-')),
    JSON.stringify(readdirSync(STORE_DIR)));

  // --- the pairing pipe still works exactly as before ------------------------

  res = await storeRequest({ room: 'x'.repeat(20), role: 'host' });
  check('an ordinary pairing hello (no `type`) is still handled the old way, not refused as a bad store request',
    res.ok === true && res.paired === false, JSON.stringify(res));
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error during the test run -> ${err.stack || err.message}`);
} finally {
  if (relay) await relay.close();
  rmSync(STORE_DIR, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
