/**
 * Storage locations over HTTP: registering a drive, moving an album onto it,
 * and — the point of the whole design — that the album keeps working through
 * every existing route while its files live somewhere else entirely.
 *
 *   node test/location-routes.mjs <adminPassword> [baseUrl]
 */

import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const volumes = require(path.join(here, '..', 'lib', 'volumes.js'));

const ADMIN_PASSWORD = process.argv[2];
const BASE = process.argv[3] || 'http://127.0.0.1:8420';

if (!ADMIN_PASSWORD) {
  console.error('Usage: node test/location-routes.mjs <adminPassword> [baseUrl]');
  process.exit(2);
}

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

let cookie = '';
async function req(p, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + p, { ...options, headers, redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return res;
}

const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const q = encodeURIComponent;
const RUN = Date.now().toString(36);
const ALBUM = `Moved-${RUN}`;
const MARKER = `RELOCATION-MARKER-${RUN}`;

/** Prefer a genuinely different volume, so the copy path is real. */
function pickTarget() {
  const all = volumes.list({ fresh: true }).filter((v) => v.id && existsSync(v.mountPoint));
  const libVolume = volumes.identify(process.cwd());
  const other = all.find((v) => v.id !== libVolume?.id);
  const base = other ? path.join(other.mountPoint, `lanshare-loc-${RUN}`) : mkdtempSync(path.join(tmpdir(), 'lanshare-loc-'));
  require('fs').mkdirSync(base, { recursive: true });
  return { base, crossVolume: Boolean(other) };
}

const { base: TARGET, crossVolume } = pickTarget();
let locationId = null;

try {
  console.log(crossVolume
    ? `  NOTE  moving across a real volume boundary: ${TARGET}`
    : '  NOTE  only one volume available — the move runs same-volume');

  let res = await req('/api/login', json({ username: 'admin', password: ADMIN_PASSWORD }));
  check('signed in', res.status === 200, `got ${res.status}`);

  // --- register a drive -----------------------------------------------------

  res = await req('/api/locations', json({ label: `Backup${RUN}`, path: TARGET }));
  const added = await res.json();
  check('a drive can be registered', res.status === 200, JSON.stringify(added));
  locationId = added.location?.id;

  res = await req('/api/locations');
  const listed = await res.json();
  const mine = listed.locations?.find((l) => l.id === locationId);
  check('it appears in the list as connected', mine?.attached === true, JSON.stringify(mine));
  check('and reports no albums on it yet', mine?.albums?.length === 0);

  res = await req('/api/locations', json({ label: `Backup${RUN}`, path: TARGET }));
  check('registering the same name twice is refused', res.status === 409, `got ${res.status}`);

  // --- an album with real content -------------------------------------------

  res = await req('/api/mkdir', json({ path: '/', name: ALBUM }));
  check('created an album to move', res.status === 200);

  const form = new FormData();
  form.append('file', new Blob([Buffer.from(MARKER)]), 'marker.txt');
  res = await req(`/api/upload?dir=${q('/' + ALBUM)}&rel=marker.txt`, { method: 'POST', body: form });
  check('uploaded a file into it', res.status === 200, `got ${res.status}`);

  // --- move it onto the drive ------------------------------------------------

  res = await req('/api/locations/relocate', json({ path: `/${ALBUM}`, locationId }));
  const moved = await res.json();
  check('the album relocates', res.status === 200 && moved.ok === true, JSON.stringify(moved));
  check('its files really are on the other drive',
    existsSync(path.join(TARGET, ALBUM, 'marker.txt')));

  // This is the whole design: nothing about the album's paths changed.
  res = await req(`/api/file?path=${q(`/${ALBUM}/marker.txt`)}`);
  const throughLink = await res.text();
  check('the file still downloads on its original path', res.status === 200, `got ${res.status}`);
  check('and its contents are unchanged', throughLink === MARKER, throughLink.slice(0, 40));

  res = await req(`/api/list?path=${q('/' + ALBUM)}`);
  const inside = await res.json();
  check('the album still lists its contents',
    inside.files?.some((f) => f.name === 'marker.txt'), JSON.stringify(inside.files));

  res = await req('/api/list?path=/');
  const root = await res.json();
  const folder = root.folders?.find((f) => f.name === ALBUM);
  check('the root listing flags where the album lives',
    folder?.storage?.location === `Backup${RUN}`, JSON.stringify(folder));
  check('and reports it as reachable', folder?.storage?.reachable === true);

  // Uploading into a relocated album must land on the other drive.
  const form2 = new FormData();
  form2.append('file', new Blob([Buffer.from('added after the move')]), 'later.txt');
  res = await req(`/api/upload?dir=${q('/' + ALBUM)}&rel=later.txt`, { method: 'POST', body: form2 });
  check('new uploads into a relocated album still work', res.status === 200, `got ${res.status}`);
  check('and land on the other drive, not back in the library',
    existsSync(path.join(TARGET, ALBUM, 'later.txt')));

  res = await req('/api/locations');
  const withAlbum = (await res.json()).locations.find((l) => l.id === locationId);
  check('the drive now reports the album living on it',
    withAlbum?.albums?.includes(ALBUM), JSON.stringify(withAlbum?.albums));

  res = await req('/api/locations/remove', json({ id: locationId }));
  check('a drive still holding albums cannot be removed', res.status === 409, `got ${res.status}`);

  // --- the drive goes away ---------------------------------------------------
  // Renaming the target out from under the link is what an unplugged drive
  // looks like to everything above the filesystem.

  const stash = path.join(TARGET, `${ALBUM}-unplugged`);
  require('fs').renameSync(path.join(TARGET, ALBUM), stash);

  res = await req('/api/list?path=/');
  const gone = (await res.json()).folders?.find((f) => f.name === ALBUM);
  check('a disconnected album is still listed', Boolean(gone), 'it vanished from the listing');
  check('and is marked unreachable rather than empty',
    gone?.storage?.reachable === false, JSON.stringify(gone));

  require('fs').renameSync(stash, path.join(TARGET, ALBUM));

  res = await req('/api/list?path=/');
  const back = (await res.json()).folders?.find((f) => f.name === ALBUM);
  check('reconnecting needs no repair step', back?.storage?.reachable === true, JSON.stringify(back));

  // --- bring it home ---------------------------------------------------------

  res = await req('/api/locations/relocate', json({ path: `/${ALBUM}`, home: true }));
  check('the album comes back', res.status === 200, `got ${res.status}`);
  check('its files are gone from the other drive', !existsSync(path.join(TARGET, ALBUM)));

  res = await req(`/api/file?path=${q(`/${ALBUM}/marker.txt`)}`);
  check('and it still reads correctly from the library', (await res.text()) === MARKER);

  res = await req(`/api/file?path=${q(`/${ALBUM}/later.txt`)}`);
  check('including the file added while it was away',
    (await res.text()) === 'added after the move');

  res = await req('/api/list?path=/');
  const backHome = (await res.json()).folders?.find((f) => f.name === ALBUM);
  check('the root listing no longer flags it as elsewhere', !backHome?.storage, JSON.stringify(backHome));

  // --- deleting an album that lives on another drive -------------------------
  // The ordinary delete would trash only the link, stranding the real files
  // on the drive with nothing pointing at them.

  {
    const DEL = `Deleted-${RUN}`;
    await req('/api/mkdir', json({ path: '/', name: DEL }));
    const delForm = new FormData();
    delForm.append('file', new Blob([Buffer.from('about to be deleted')]), 'doomed.txt');
    await req(`/api/upload?dir=${q('/' + DEL)}&rel=doomed.txt`, { method: 'POST', body: delForm });
    await req('/api/locations/relocate', json({ path: `/${DEL}`, locationId }));
    check('set up a relocated album to delete',
      existsSync(path.join(TARGET, DEL, 'doomed.txt')));

    res = await req('/api/delete', json({ paths: [`/${DEL}`] }));
    check('a relocated album deletes', res.status === 200, `got ${res.status}`);

    res = await req('/api/list?path=/');
    check('and is gone from the library',
      !(await res.json()).folders?.some((f) => f.name === DEL));

    check('nothing is left orphaned on the drive',
      !existsSync(path.join(TARGET, DEL)), 'the album is still on the drive');

    // Recoverable, like every other delete in this app.
    const driveTrash = path.join(TARGET, '.lanshare-trash');
    const stamps = existsSync(driveTrash) ? readdirSync(driveTrash) : [];
    const recovered = stamps
      .map((s) => path.join(driveTrash, s, DEL, 'doomed.txt'))
      .find((p) => existsSync(p));
    check('but it is recoverable from a trash folder on that drive',
      Boolean(recovered), `looked in ${driveTrash}`);
    check('and still readable',
      recovered && readFileSync(recovered, 'utf8') === 'about to be deleted');
  }

  // --- guards ----------------------------------------------------------------

  res = await req('/api/locations/relocate', json({ path: `/${ALBUM}/Sub`, locationId }));
  check('only a top-level album can be relocated', res.status === 400, `got ${res.status}`);

  res = await req('/api/locations/remove', json({ id: locationId }));
  check('an empty drive can now be removed', res.status === 200, `got ${res.status}`);
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error -> ${err.stack || err.message}`);
} finally {
  await req('/api/delete', json({ paths: [`/${ALBUM}`] })).catch(() => {});
  if (locationId) await req('/api/locations/remove', json({ id: locationId })).catch(() => {});
  rmSync(TARGET, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
