/**
 * The search index through the HTTP API: text, structured and GPS filters,
 * and — the part most worth getting right — that a restricted account and a
 * locked vault never leak a path through search that /api/list would not
 * also show them.
 *
 * The index itself has no notion of accounts; every scoping guarantee here
 * is enforced by the route, so this suite exists specifically to prove that
 * boundary rather than just exercising the happy path.
 *
 *   node test/search-routes.mjs <adminPassword> [baseUrl]
 */

import { realisticJpeg } from './helpers/exif-fixture.mjs';

const ADMIN_PASSWORD = process.argv[2];
const BASE = process.argv[3] || 'http://127.0.0.1:8420';

if (!ADMIN_PASSWORD) {
  console.error('Usage: node test/search-routes.mjs <adminPassword> [baseUrl]');
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
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const login = (req, username, password) => req('/api/login', json({ username, password }));
const q = encodeURIComponent;

async function uploadFile(req, dir, name, buffer) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), name);
  return req(`/api/upload?dir=${q(dir)}&rel=${q(name)}`, { method: 'POST', body: form });
}

async function search(req, params) {
  const res = await req(`/api/search?${new URLSearchParams(params)}`);
  const body = await res.json();
  return { status: res.status, body };
}

/** Polls /api/index/status until a scan is not in progress. */
async function waitForIdle(req, deadlineMs = 30000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const res = await req('/api/index/status');
    const body = await res.json();
    if (!body.scanning) return body;
    if (Date.now() > deadline) throw new Error('index scan did not finish in time');
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Forces a scan that is guaranteed to start after everything uploaded so
 * far — a rebuild call that lands while some other scan (e.g. the one fired
 * at server startup) is still running just joins it instead of starting a
 * fresh one, and that earlier scan could have begun before this test's
 * fixtures were written. Rebuilding twice when that happens guarantees the
 * second one starts clean.
 */
async function rebuildAndWait(req) {
  let res = await req('/api/index/rebuild', { method: 'POST' });
  let body = await res.json();
  if (body.alreadyRunning) {
    await waitForIdle(req);
    res = await req('/api/index/rebuild', { method: 'POST' });
    body = await res.json();
  }
  await waitForIdle(req);
}

const RUN = Date.now().toString(36);
const familyAlbum = `/SearchFamily-${RUN}`;
const privateAlbum = `/SearchPrivate-${RUN}`;
const vaultAlbum = `/SearchVault-${RUN}`;
const TOKEN = `zzsearch${RUN}`;
const familyName = `${TOKEN}-family.jpg`;
const privateName = `${TOKEN}-private.jpg`;
const vaultedName = `zzvault${RUN}-item.jpg`;

// Paris, roughly — a real GPS fixture for the near/radius search.
const PARIS = { lat: 48.8566, lon: 2.3522 };
const NEW_YORK = { lat: 40.7128, lon: -74.006 };

const familyJpeg = realisticJpeg({
  make: 'DJI', model: 'FC3582',
  dateTimeOriginal: '2026:03:15 10:30:00',
  lat: PARIS.lat, latRef: 'N', lon: PARIS.lon, lonRef: 'E',
  pixelWidth: 4000, pixelHeight: 3000,
});
const privateJpeg = realisticJpeg({ make: 'DJI', model: 'FC3582' });
const vaultedJpeg = realisticJpeg({ make: 'Canon', model: 'EOS R5' });

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

  // --- fixtures ---------------------------------------------------------

  for (const name of [`SearchFamily-${RUN}`, `SearchPrivate-${RUN}`, `SearchVault-${RUN}`]) {
    res = await admin('/api/mkdir', json({ path: '/', name }));
    if (res.status === 200) albumsCreated.push(`/${name}`);
  }
  check('fixture albums created', albumsCreated.length === 3, JSON.stringify(albumsCreated));

  res = await uploadFile(admin, familyAlbum, familyName, familyJpeg);
  check('uploaded the family photo', res.status === 200, `got ${res.status}`);
  res = await uploadFile(admin, privateAlbum, privateName, privateJpeg);
  check('uploaded the private photo', res.status === 200, `got ${res.status}`);

  res = await admin('/api/vaults/create', json({ path: vaultAlbum, passphrase: 'a properly long passphrase' }));
  check('created the vault album', res.status === 200, `got ${res.status}`);
  res = await uploadFile(admin, vaultAlbum, vaultedName, vaultedJpeg);
  check('uploaded into the vault', res.status === 200, `got ${res.status}`);

  await rebuildAndWait(admin);

  // --- text and structured search, as admin ------------------------------

  let { status, body } = await search(admin, { q: TOKEN });
  check('admin text search finds both photos', status === 200
    && body.results?.length === 2, JSON.stringify(body));

  ({ status, body } = await search(admin, { q: TOKEN, kind: 'image' }));
  check('kind=image filter still finds both', body.results?.length === 2, JSON.stringify(body));

  ({ status, body } = await search(admin, { q: TOKEN, kind: 'video' }));
  check('kind=video filter finds neither (they are images)', body.results?.length === 0, JSON.stringify(body));

  ({ status, body } = await search(admin, { q: TOKEN, camera: 'DJI' }));
  check('camera=DJI filter finds both', body.results?.length === 2, JSON.stringify(body));

  ({ status, body } = await search(admin, { q: familyName }));
  check('an exact filename search finds just that file',
    body.results?.length === 1 && body.results[0].path === `${familyAlbum}/${familyName}`,
    JSON.stringify(body));
  const familyResult = body.results[0];
  check('EXIF make/model were extracted and returned',
    familyResult.cameraMake === 'DJI' && familyResult.cameraModel === 'FC3582', JSON.stringify(familyResult));
  check('EXIF pixel dimensions were extracted',
    familyResult.width === 4000 && familyResult.height === 3000, JSON.stringify(familyResult));

  // --- date range ---------------------------------------------------------

  ({ status, body } = await search(admin, { q: familyName, from: '2026-01-01', to: '2026-12-31' }));
  check('a date range bracketing the capture date matches', body.results?.length === 1, JSON.stringify(body));

  ({ status, body } = await search(admin, { q: familyName, from: '2026-04-01' }));
  check('a date range after the capture date excludes it', body.results?.length === 0, JSON.stringify(body));

  // --- GPS radius -----------------------------------------------------------

  ({ status, body } = await search(admin, {
    q: familyName, near_lat: String(PARIS.lat), near_lon: String(PARIS.lon), radius_km: '5',
  }));
  check('a GPS search centered on the photo finds it',
    body.results?.length === 1 && typeof body.results[0].distanceKm === 'number', JSON.stringify(body));

  ({ status, body } = await search(admin, {
    q: familyName, near_lat: String(NEW_YORK.lat), near_lon: String(NEW_YORK.lon), radius_km: '5',
  }));
  check('a GPS search far from the photo excludes it', body.results?.length === 0, JSON.stringify(body));

  // --- account scoping: the security-critical case -------------------------

  res = await createAccount(`searchscoped-${RUN}`, 'viewer', [familyAlbum]);
  check('created an account scoped to the family album only', res.status === 200, `got ${res.status}`);

  const scoped = client();
  await login(scoped, `searchscoped-${RUN}`, 'Testpass123');

  ({ status, body } = await search(scoped, { q: TOKEN }));
  check('scoped account searching a token common to both photos gets only its own',
    status === 200 && body.results?.length === 1
    && body.results[0].path === `${familyAlbum}/${familyName}`, JSON.stringify(body));

  ({ status, body } = await search(scoped, { q: privateName }));
  check('scoped account searching the private photo by exact name finds nothing',
    body.results?.length === 0, JSON.stringify(body));

  // A plain viewer is allowed to search at all — /api/search carries no
  // explicit role gate, same as /api/list.
  check('search itself is available to a viewer-level account (not admin-gated)', status === 200);

  // --- vault lock state, checked live at request time -----------------------

  ({ status, body } = await search(admin, { q: vaultedName }));
  check('an unlocked vault file is found by search', body.results?.length === 1, JSON.stringify(body));

  res = await admin('/api/vaults/lock', json({ path: vaultAlbum }));
  check('locked the vault', res.status === 200, `got ${res.status}`);

  ({ status, body } = await search(admin, { q: vaultedName }));
  check('the same file disappears from search once its vault is locked — not even the name leaks',
    body.results?.length === 0, JSON.stringify(body));

  res = await admin('/api/vaults/unlock', json({ path: vaultAlbum, passphrase: 'a properly long passphrase' }));
  check('unlocked the vault again', res.status === 200, `got ${res.status}`);

  ({ status, body } = await search(admin, { q: vaultedName }));
  check('it reappears once unlocked again, with no rescan needed',
    body.results?.length === 1, JSON.stringify(body));

  // --- index management routes are admin-only --------------------------------

  res = await scoped('/api/index/rebuild', { method: 'POST' });
  check('a viewer cannot trigger a rebuild', res.status === 403, `got ${res.status}`);

  res = await scoped('/api/index/status');
  check('a viewer cannot read index status', res.status === 403, `got ${res.status}`);

  res = await admin('/api/index/status');
  const statusBody = await res.json();
  check('admin can read index status', res.status === 200 && typeof statusBody.count === 'number',
    JSON.stringify(statusBody));
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error during the test run -> ${err.stack || err.message}`);
} finally {
  for (const username of accountsCreated) {
    await admin(`/api/accounts/${encodeURIComponent(username)}`, { method: 'DELETE' }).catch(() => {});
  }
  // The vault must be open for its files to be deletable; re-lock is not
  // this cleanup's job, only leaving the library in a normal state is.
  await admin('/api/vaults/unlock', json({ path: vaultAlbum, passphrase: 'a properly long passphrase' })).catch(() => {});
  for (const albumPath of albumsCreated) {
    await admin('/api/delete', json({ paths: [albumPath] })).catch(() => {});
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
