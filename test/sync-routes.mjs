/**
 * Sync targets over HTTP: setting one up, previewing it, running it, and the
 * guards that stop a sync being pointed somewhere it should not go.
 *
 *   node test/sync-routes.mjs <adminPassword> [baseUrl]
 */

import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ADMIN_PASSWORD = process.argv[2];
const BASE = process.argv[3] || 'http://127.0.0.1:8420';

if (!ADMIN_PASSWORD) {
  console.error('Usage: node test/sync-routes.mjs <adminPassword> [baseUrl]');
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
const ALBUM = `SyncMe-${RUN}`;
const DRIVE = path.join('C:', `lanshare-sync-${RUN}`).replace(/\\/g, '/');

let locationId = null;
let targetId = null;

try {
  mkdirSync(DRIVE, { recursive: true });

  let res = await req('/api/login', json({ username: 'admin', password: ADMIN_PASSWORD }));
  check('signed in', res.status === 200, `got ${res.status}`);

  // --- set the scene --------------------------------------------------------

  res = await req('/api/mkdir', json({ path: '/', name: ALBUM }));
  check('created an album to sync', res.status === 200, `got ${res.status}`);

  const form = new FormData();
  form.append('file', new Blob([Buffer.from('the original photo')]), 'photo.txt');
  res = await req(`/api/upload?dir=${q('/' + ALBUM)}&rel=photo.txt`, { method: 'POST', body: form });
  check('put a file in it', res.status === 200, `got ${res.status}`);

  res = await req('/api/locations', json({ label: `SyncDrive${RUN}`, path: DRIVE }));
  const location = await res.json();
  check('registered a drive to sync to', res.status === 200, JSON.stringify(location));
  locationId = location.location?.id;

  // --- creating a target ----------------------------------------------------

  res = await req('/api/sync', json({ album: `/${ALBUM}`, locationId, policy: 'keep-both' }));
  const created = await res.json();
  check('a sync can be set up', res.status === 200, JSON.stringify(created));
  targetId = created.target?.id;
  check('it defaults to running when the drive connects', created.target?.runOnConnect === true);

  res = await req('/api/sync', json({ album: `/${ALBUM}`, locationId }));
  check('the same album cannot be synced to the same drive twice', res.status === 409, `got ${res.status}`);

  res = await req('/api/sync', json({ album: `/${ALBUM}`, locationId, policy: 'whatever' }));
  check('an unknown conflict policy is refused', res.status === 400, `got ${res.status}`);

  res = await req('/api/sync', json({ album: `/${ALBUM}-nope`, locationId }));
  check('syncing an album that does not exist is refused', res.status === 404, `got ${res.status}`);

  res = await req('/api/sync', json({ album: '/../../Windows', locationId }));
  check('a sync cannot be pointed outside the library', res.status === 400 || res.status === 404,
    `got ${res.status}`);

  res = await req('/api/sync');
  const listed = await res.json();
  const mine = listed.targets?.find((t) => t.id === targetId);
  check('it shows up in the list', Boolean(mine), JSON.stringify(listed.targets));
  check('with its drive reported as connected', mine?.location?.attached === true);
  check('and no run recorded yet', mine?.lastRun === null);

  // --- preview changes nothing ---------------------------------------------

  res = await req('/api/sync/run', json({ id: targetId, dryRun: true }));
  const previewed = await res.json();
  check('a preview reports what it would copy',
    previewed.report?.planned?.toTarget === 1, JSON.stringify(previewed.report?.planned));
  check('a preview says it is a first run', previewed.report?.firstRun === true);
  check('and a preview writes nothing to the drive',
    !existsSync(path.join(DRIVE, ALBUM, 'photo.txt')));
  // A dry run that creates a folder is not a dry run. This goes through the
  // target-resolution layer, which the engine's own tests never exercise.
  check('a preview does not even create the destination folder',
    !existsSync(path.join(DRIVE, ALBUM)), readdirSync(DRIVE).join(','));

  // --- running it -----------------------------------------------------------

  res = await req('/api/sync/run', json({ id: targetId }));
  const ran = await res.json();
  check('the sync runs', res.status === 200 && ran.ok === true, JSON.stringify(ran).slice(0, 200));
  check('and the file is on the drive',
    existsSync(path.join(DRIVE, ALBUM, 'photo.txt')));
  check('with its contents intact',
    readFileSync(path.join(DRIVE, ALBUM, 'photo.txt'), 'utf8') === 'the original photo');

  res = await req('/api/sync');
  const afterRun = (await res.json()).targets.find((t) => t.id === targetId);
  check('the run is recorded against the target', afterRun?.lastRun?.copied === 1,
    JSON.stringify(afterRun?.lastRun));

  // --- a change on the drive comes back ------------------------------------

  writeFileSync(path.join(DRIVE, ALBUM, 'from-the-drive.txt'), 'added on the other machine');
  res = await req('/api/sync/run', json({ id: targetId }));
  check('a second run brings back what changed on the drive', res.status === 200);

  res = await req(`/api/file?path=${q(`/${ALBUM}/from-the-drive.txt`)}`);
  check('and the library can read it', (await res.text()) === 'added on the other machine');

  res = await req('/api/sync/run', json({ id: targetId, dryRun: true }));
  const quiet = await res.json();
  check('a run straight after is quiet', quiet.report?.planned?.total === 0,
    JSON.stringify(quiet.report?.planned));

  // --- a deletion propagates and stays gone --------------------------------

  res = await req('/api/delete', json({ paths: [`/${ALBUM}/photo.txt`] }));
  check('deleted a file from the library', res.status === 200, `got ${res.status}`);

  res = await req('/api/sync/run', json({ id: targetId }));
  const deleted = await res.json();
  check('the deletion reaches the drive',
    !existsSync(path.join(DRIVE, ALBUM, 'photo.txt')), 'still on the drive');
  check('and is reported as a removal',
    deleted.report?.planned?.deleteOnTarget === 1, JSON.stringify(deleted.report?.planned));
  check('but is recoverable from the drive\'s trash',
    existsSync(path.join(DRIVE, ALBUM, '.lanshare-sync-trash')));

  res = await req('/api/sync/run', json({ id: targetId, dryRun: true }));
  const notBack = await res.json();
  check('and the next run does not resurrect it',
    notBack.report?.planned?.total === 0, JSON.stringify(notBack.report?.planned));

  // --- permissions ----------------------------------------------------------

  res = await req('/api/accounts', json({
    username: `viewer${RUN}`, password: 'a long enough password', role: 'viewer',
  }));
  check('made a viewer account to test with', res.status === 200, `got ${res.status}`);

  const adminCookie = cookie;
  cookie = '';
  res = await req('/api/login', json({ username: `viewer${RUN}`, password: 'a long enough password' }));
  check('the viewer can sign in', res.status === 200, `got ${res.status}`);

  res = await req('/api/sync');
  check('a viewer cannot see the syncs', res.status === 403, `got ${res.status}`);
  res = await req('/api/sync/run', json({ id: targetId }));
  check('and certainly cannot run one', res.status === 403, `got ${res.status}`);

  cookie = adminCookie;

  // --- removing --------------------------------------------------------------

  res = await req('/api/sync/remove', json({ id: targetId }));
  check('a sync can be removed', res.status === 200, `got ${res.status}`);
  check('and removing it leaves the copied files alone',
    existsSync(path.join(DRIVE, ALBUM, 'from-the-drive.txt')));
  targetId = null;

  res = await req('/api/sync/remove', json({ id: 'nope' }));
  check('removing one that does not exist is a 404', res.status === 404, `got ${res.status}`);
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error -> ${err.stack || err.message}`);
} finally {
  if (targetId) await req('/api/sync/remove', json({ id: targetId })).catch(() => {});
  await req('/api/delete', json({ paths: [`/${ALBUM}`] })).catch(() => {});
  await req('/api/accounts/remove', json({ username: `viewer${RUN}` })).catch(() => {});
  if (locationId) await req('/api/locations/remove', json({ id: locationId })).catch(() => {});
  rmSync(DRIVE, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
