/**
 * Content search over the HTTP API, end to end, against the real local
 * model — building the index for real, then confirming a plain-English
 * query actually ranks a matching photo first, through the exact same
 * route a browser would call.
 *
 * Deliberately separate from search-routes.mjs's content-search section:
 * that file proves route shape and gating fast and without a model: this
 * one pays the real cost (a model load, real inference, real per-image
 * compute) to prove the whole thing actually works end to end — the same
 * "slow but real" tradition test/media.mjs and test/clip.mjs already
 * follow. Registered with slow:true so `--quick` skips it.
 *
 *   node test/content-search-routes.mjs <adminPassword> [baseUrl]
 */

import sharp from 'sharp';

const ADMIN_PASSWORD = process.argv[2];
const BASE = process.argv[3] || 'http://127.0.0.1:8420';

if (!ADMIN_PASSWORD) {
  console.error('Usage: node test/content-search-routes.mjs <adminPassword> [baseUrl]');
  process.exit(2);
}

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

function client() {
  let cookie = '';
  return async (path, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(BASE + path, { ...options, headers, redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return res;
  };
}

const json = (body) => ({
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const login = (req, username, password) => req('/api/login', json({ username, password }));
const q = encodeURIComponent;

async function uploadFile(req, dir, name, buffer) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), name);
  return req(`/api/upload?dir=${q(dir)}&rel=${q(name)}`, { method: 'POST', body: form });
}

async function waitForIndexIdle(req, deadlineMs = 30000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const body = await (await req('/api/index/status')).json();
    if (!body.scanning) return body;
    if (Date.now() > deadline) throw new Error('metadata index scan did not finish in time');
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function rebuildAndWait(req) {
  let body = await (await req('/api/index/rebuild', { method: 'POST' })).json();
  if (body.alreadyRunning) {
    await waitForIndexIdle(req);
    await req('/api/index/rebuild', { method: 'POST' });
  }
  await waitForIndexIdle(req);
}

/**
 * A cold model download plus real inference over a handful of images —
 * generous, because how long this takes depends on network speed, not on
 * anything this test controls.
 */
async function waitForContentBuild(req, deadlineMs = 300000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const body = await (await req('/api/content-index/status')).json();
    if (!body.building) return body;
    if (Date.now() > deadline) throw new Error('content index build did not finish in time');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function solidJpeg(r, g, b) {
  return sharp({
    create: {
      width: 256, height: 256, channels: 3, background: { r, g, b },
    },
  }).jpeg().toBuffer();
}

const RUN = Date.now().toString(36);
const contentAlbum = `/ContentSearch-${RUN}`;
const vaultAlbum = `/ContentSearchVault-${RUN}`;
const redName = `red-${RUN}.jpg`;
const blueName = `blue-${RUN}.jpg`;
const vaultedName = `vaulted-${RUN}.jpg`;

const accountsCreated = [];
const albumsCreated = [];
const admin = client();

async function createAccount(username, role, roots) {
  const r = await admin('/api/accounts', json({ username, password: 'Testpass123', role, roots }));
  if (r.status === 200) accountsCreated.push(username);
  return r;
}

try {
  let res = await login(admin, 'admin', ADMIN_PASSWORD);
  check('admin signs in', res.status === 200, `got ${res.status}`);

  for (const name of [`ContentSearch-${RUN}`, `ContentSearchVault-${RUN}`]) {
    res = await admin('/api/mkdir', json({ path: '/', name }));
    if (res.status === 200) albumsCreated.push(`/${name}`);
  }
  check('fixture albums created', albumsCreated.length === 2, JSON.stringify(albumsCreated));

  res = await uploadFile(admin, contentAlbum, redName, await solidJpeg(220, 20, 20));
  check('uploaded a red photo', res.status === 200, `got ${res.status}`);
  res = await uploadFile(admin, contentAlbum, blueName, await solidJpeg(20, 20, 220));
  check('uploaded a blue photo', res.status === 200, `got ${res.status}`);
  await rebuildAndWait(admin);

  // The shared test server this suite runs against also carries whatever
  // make-samples.mjs seeded for the media suite's benefit, so "embeddable"
  // is never asserted as an absolute number below — only as a delta before
  // and after the vault upload, which is robust regardless of what else is
  // already in the library.
  let body = await (await admin('/api/content-index/status')).json();
  check('before any build, nothing is embedded yet', body.embedded === 0, JSON.stringify(body));
  const embeddableBeforeVault = body.embeddable;

  res = await admin('/api/vaults/create', json({ path: vaultAlbum, passphrase: 'a properly long passphrase' }));
  check('created the vault album', res.status === 200, `got ${res.status}`);
  res = await uploadFile(admin, vaultAlbum, vaultedName, await solidJpeg(20, 220, 20));
  check('uploaded a photo into the vault', res.status === 200, `got ${res.status}`);
  await rebuildAndWait(admin);

  body = await (await admin('/api/content-index/status')).json();
  check('the vault upload did not change how many files are embeddable — it is never counted',
    body.embeddable === embeddableBeforeVault, `before=${embeddableBeforeVault} after=${body.embeddable}`);

  // --- the real build ----------------------------------------------------

  res = await admin('/api/content-index/build', { method: 'POST' });
  body = await res.json();
  check('the build starts', res.status === 200 && body.started === true, JSON.stringify(body));

  const finalStatus = await waitForContentBuild(admin);
  check('once finished, everything embeddable has been embedded (and no more)',
    finalStatus.embedded === finalStatus.embeddable && finalStatus.embedded === embeddableBeforeVault,
    JSON.stringify(finalStatus));
  check('the model reports as cached now that it has actually loaded', finalStatus.modelCached === true);

  // --- a real, ranked, content-based result -------------------------------

  res = await admin('/api/search/content?q=a+photo+of+the+color+red');
  body = await res.json();
  check('content search is now available', body.available === true, JSON.stringify(body));
  check('a search for "red" finds the red photo', body.results?.some((r) => r.path === `${contentAlbum}/${redName}`),
    JSON.stringify(body.results?.map((r) => r.path)));
  check('every result carries a similarity score', body.results?.every((r) => typeof r.score === 'number'));

  const topResult = body.results?.[0];
  check('the red photo ranks above the blue one for a "red" query',
    topResult?.path === `${contentAlbum}/${redName}`, JSON.stringify(topResult));

  res = await admin('/api/search/content?q=a+photo+of+the+color+blue');
  body = await res.json();
  check('a search for "blue" ranks the blue photo first',
    body.results?.[0]?.path === `${contentAlbum}/${blueName}`, JSON.stringify(body.results?.[0]));

  check('the vault photo never appears in content search results, unlocked or not',
    !body.results?.some((r) => r.path === `${vaultAlbum}/${vaultedName}`));

  // --- /api/me reflects real availability ---------------------------------

  res = await admin('/api/me');
  body = await res.json();
  check('/api/me now reports content search as available', body.contentSearchAvailable === true, JSON.stringify(body));

  // --- root-scoping, the same security property /api/search itself has ----

  res = await createAccount(`contentscoped-${RUN}`, 'viewer', [vaultAlbum]);
  check('created an account scoped away from the content-search album', res.status === 200, `got ${res.status}`);
  const scoped = client();
  await login(scoped, `contentscoped-${RUN}`, 'Testpass123');

  res = await scoped('/api/search/content?q=a+photo+of+the+color+red');
  body = await res.json();
  check('an account scoped to a different album gets no results from content search',
    res.status === 200 && (body.results?.length ?? 0) === 0, JSON.stringify(body));
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error during the test run -> ${err.stack || err.message}`);
} finally {
  for (const username of accountsCreated) {
    await admin(`/api/accounts/${encodeURIComponent(username)}`, { method: 'DELETE' }).catch(() => {});
  }
  await admin('/api/vaults/unlock', json({ path: vaultAlbum, passphrase: 'a properly long passphrase' })).catch(() => {});
  for (const albumPath of albumsCreated) {
    await admin('/api/delete', json({ paths: [albumPath] })).catch(() => {});
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
