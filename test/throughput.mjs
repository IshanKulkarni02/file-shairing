/**
 * Large-file round trip.
 *
 * Node kills any request older than 5 minutes by default, which silently
 * truncates big uploads. server.js sets requestTimeout to 0; this is the test
 * that would catch a regression of that.
 *
 *   node test/throughput.mjs <password> [sizeMB] [baseUrl]
 */

import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const PASSWORD = process.argv[2];
const SIZE_MB = Number(process.argv[3] || 1024);
const BASE = process.argv[4] || 'http://127.0.0.1:8420';

if (!PASSWORD) {
  console.error('Usage: node test/throughput.mjs <password> [sizeMB] [baseUrl]');
  process.exit(2);
}

const TOTAL = SIZE_MB * 1024 * 1024;
const CHUNK = 4 * 1024 * 1024;
let cookie = '';
let failures = 0;

function rate(bytes, ms) {
  const mbps = (bytes / 1048576) / (ms / 1000);
  return `${mbps.toFixed(0)} MB/s`;
}

async function req(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + path, { ...options, headers, redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return res;
}

let res = await req('/api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: PASSWORD }),
});
if (res.status !== 200) {
  console.error(`  Could not sign in (${res.status})`);
  process.exit(1);
}

// Generate the body on the fly rather than holding a gigabyte in memory, and
// hash it as it goes so the download can be compared without a second copy.
const pattern = crypto.randomBytes(CHUNK);
const uploadHash = crypto.createHash('sha256');
let produced = 0;

const body = Readable.toWeb(new Readable({
  read() {
    if (produced >= TOTAL) return this.push(null);
    const size = Math.min(CHUNK, TOTAL - produced);
    const slice = size === CHUNK ? pattern : pattern.subarray(0, size);
    produced += size;
    uploadHash.update(slice);
    return this.push(slice);
  },
}));

const boundary = `----lanshare${crypto.randomBytes(8).toString('hex')}`;
const head = Buffer.from(
  `--${boundary}\r\nContent-Disposition: form-data; name="file"; ` +
  `filename="throughput.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
const tail = Buffer.from(`\r\n--${boundary}--\r\n`);

// Wrap the generated stream in a multipart envelope by hand; FormData would
// require materialising the whole payload.
const multipart = new ReadableStream({
  async start(controller) {
    controller.enqueue(head);
    const reader = body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      controller.enqueue(value);
    }
    controller.enqueue(tail);
    controller.close();
  },
});

console.log(`\n  Uploading ${SIZE_MB} MB...`);
let started = Date.now();
res = await fetch(`${BASE}/api/upload?dir=%2F&rel=throughput.bin`, {
  method: 'POST',
  headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
  body: multipart,
  duplex: 'half',
});
const uploadMs = Date.now() - started;
const uploaded = await res.json();

if (res.status !== 200 || uploaded.saved?.[0]?.size !== TOTAL) {
  console.log(`  FAIL  upload -> status ${res.status}, size ${uploaded.saved?.[0]?.size} vs ${TOTAL}`);
  failures++;
} else {
  console.log(`  PASS  uploaded ${SIZE_MB} MB in ${(uploadMs / 1000).toFixed(1)}s  (${rate(TOTAL, uploadMs)})`);
}

const savedPath = uploaded.saved?.[0]?.path;

if (savedPath) {
  console.log(`  Downloading ${SIZE_MB} MB...`);
  started = Date.now();
  res = await req(`/api/file?path=${encodeURIComponent(savedPath)}`);

  const downloadHash = crypto.createHash('sha256');
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    downloadHash.update(value);
    received += value.length;
  }
  const downloadMs = Date.now() - started;

  if (received !== TOTAL) {
    console.log(`  FAIL  download -> ${received} bytes, expected ${TOTAL}`);
    failures++;
  } else {
    console.log(`  PASS  downloaded ${SIZE_MB} MB in ${(downloadMs / 1000).toFixed(1)}s  (${rate(TOTAL, downloadMs)})`);
  }

  const a = uploadHash.digest('hex');
  const b = downloadHash.digest('hex');
  if (a === b) console.log('  PASS  checksum matches end to end');
  else { console.log(`  FAIL  checksum mismatch\n        up   ${a}\n        down ${b}`); failures++; }

  await req('/api/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: [savedPath] }),
  });
}

console.log(failures ? `\n  ${failures} failed\n` : '\n  All good\n');
process.exit(failures ? 1 : 0);
