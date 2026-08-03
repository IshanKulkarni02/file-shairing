/**
 * End-to-end smoke test against a running server.
 *
 *   node server.js                       (in one terminal)
 *   node test/smoke.mjs <password>       (in another)
 *
 * Optionally pass a base URL as the second argument:
 *   node test/smoke.mjs hunter2 http://127.0.0.1:8420
 *
 * Creates and removes its own files under the library root.
 */

const PASSWORD = process.argv[2];
const BASE = process.argv[3] || 'http://127.0.0.1:8420';

if (!PASSWORD) {
  console.error('Usage: node test/smoke.mjs <password> [baseUrl]');
  process.exit(2);
}

let cookie = '';
let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

async function req(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + path, { ...options, headers, redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return res;
}

const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// --- auth -----------------------------------------------------------------

let res = await req('/api/list?path=/');
check('unauthenticated /api/list returns 401', res.status === 401, `got ${res.status}`);

res = await req('/api/login', json({ username: 'admin', password: 'definitely-wrong' }));
check('wrong password returns 401', res.status === 401, `got ${res.status}`);

res = await req('/api/login', json({ username: 'admin', password: PASSWORD }));
check('correct password signs in', res.status === 200, `got ${res.status}`);
check('session cookie was issued', cookie.startsWith('lanshare_sid='), cookie || '(none)');

// --- browsing and path safety ---------------------------------------------

res = await req('/api/list?path=/');
const listing = await res.json();
check('list root returns 200', res.status === 200, `got ${res.status}`);
check('listing has folders and files arrays',
  Array.isArray(listing.folders) && Array.isArray(listing.files));

for (const evil of ['../../Windows', '/../../Windows', '....//....//Windows', '/.lanshare']) {
  res = await req(`/api/list?path=${encodeURIComponent(evil)}`);
  check(`traversal blocked: ${evil}`, res.status === 400 || res.status === 404, `got ${res.status}`);
}

// --- upload ---------------------------------------------------------------

const payload = Buffer.alloc(3 * 1024 * 1024);
for (let i = 0; i < payload.length; i++) payload[i] = i % 251;

const form = new FormData();
form.append('file', new Blob([payload]), 'test-upload.bin');
res = await req('/api/upload?dir=%2F&rel=test-upload.bin', { method: 'POST', body: form });
const uploaded = await res.json();
check('upload returns 200', res.status === 200, `got ${res.status}`);
check('upload saved one file', uploaded.saved?.length === 1, JSON.stringify(uploaded));
check('saved size matches', uploaded.saved?.[0]?.size === payload.length,
  `${uploaded.saved?.[0]?.size} vs ${payload.length}`);

const savedPath = uploaded.saved?.[0]?.path;

const form2 = new FormData();
form2.append('file', new Blob([Buffer.from('nested')]), 'inner.txt');
res = await req(`/api/upload?dir=%2F&rel=${encodeURIComponent('Trip/Day 1/inner.txt')}`,
  { method: 'POST', body: form2 });
const nested = await res.json();
check('nested upload keeps folder structure', nested.saved?.[0]?.path === '/Trip/Day 1/inner.txt',
  JSON.stringify(nested.saved));

// --- download and range requests ------------------------------------------
// iOS Safari refuses to play video unless ranges answer with 206.

res = await req(`/api/file?path=${encodeURIComponent(savedPath)}`);
const got = Buffer.from(await res.arrayBuffer());
check('download returns 200', res.status === 200, `got ${res.status}`);
check('downloaded bytes match upload', got.equals(payload), `${got.length} vs ${payload.length}`);
check('accept-ranges advertised', res.headers.get('accept-ranges') === 'bytes');

res = await req(`/api/file?path=${encodeURIComponent(savedPath)}`,
  { headers: { range: 'bytes=100-199' } });
const slice = Buffer.from(await res.arrayBuffer());
check('range request returns 206', res.status === 206, `got ${res.status}`);
check('range slice is 100 bytes', slice.length === 100, `got ${slice.length}`);
check('range slice content correct', slice.equals(payload.subarray(100, 200)));
check('content-range header correct',
  res.headers.get('content-range') === `bytes 100-199/${payload.length}`,
  res.headers.get('content-range'));

res = await req(`/api/file?path=${encodeURIComponent(savedPath)}`,
  { headers: { range: 'bytes=-50' } });
const tail = Buffer.from(await res.arrayBuffer());
check('suffix range returns the last 50 bytes',
  res.status === 206 && tail.equals(payload.subarray(payload.length - 50)),
  `${res.status} len=${tail.length}`);

res = await req(`/api/file?path=${encodeURIComponent(savedPath)}`,
  { headers: { range: 'bytes=99999999-' } });
check('out-of-bounds range returns 416', res.status === 416, `got ${res.status}`);

// --- management -----------------------------------------------------------

res = await req('/api/mkdir', json({ path: '/', name: 'Holiday' }));
check('mkdir returns 200', res.status === 200, `got ${res.status}`);

res = await req('/api/rename', json({ path: '/Holiday', name: 'Holiday 2026' }));
check('rename returns 200', res.status === 200, `got ${res.status}`);

res = await req('/api/mkdir', json({ path: '/', name: '../escape' }));
check('mkdir rejects an unsafe name', res.status === 400, `got ${res.status}`);

res = await req('/api/delete', json({ paths: ['/Holiday 2026'] }));
const deleted = await res.json();
check('delete moves to trash', deleted.ok === true, JSON.stringify(deleted));

res = await req('/api/list?path=/');
const after = await res.json();
check('deleted album is gone from the listing',
  !after.folders.some((f) => f.name === 'Holiday 2026'));
check('internal .lanshare folder stays hidden',
  !after.folders.some((f) => f.name === '.lanshare'));

// --- zip ------------------------------------------------------------------

res = await req('/api/zip-prepare', json({ paths: [savedPath, '/Trip'] }));
const zipJob = await res.json();
check('zip-prepare returns an id', Boolean(zipJob.id), JSON.stringify(zipJob));

res = await req(zipJob.url);
const zipBytes = Buffer.from(await res.arrayBuffer());
check('zip downloads', res.status === 200 && zipBytes.length > 0, `got ${res.status}`);
check('zip has the PK signature', zipBytes.subarray(0, 2).toString() === 'PK');

res = await req(zipJob.url);
check('zip link is single-use', res.status === 404, `got ${res.status}`);

// --- cleanup, then confirm the session can be dropped ---------------------

await req('/api/delete', json({ paths: [savedPath, '/Trip'] }));

await req('/api/logout', { method: 'POST' });
cookie = '';
res = await req(`/api/file?path=${encodeURIComponent(savedPath)}`);
check('after logout, file access is 401', res.status === 401, `got ${res.status}`);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
