/**
 * Vaults end to end through the HTTP API: creating one, uploading into it,
 * reading it back, byte ranges over encrypted files, and that a locked vault
 * genuinely gives nothing away.
 *
 *   node test/vault-routes.mjs <adminPassword> [baseUrl]
 */

const ADMIN_PASSWORD = process.argv[2];
const BASE = process.argv[3] || 'http://127.0.0.1:8420';

if (!ADMIN_PASSWORD) {
  console.error('Usage: node test/vault-routes.mjs <adminPassword> [baseUrl]');
  process.exit(2);
}

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

let cookie = '';
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

const RUN = Date.now().toString(36);
const ALBUM = `/Vault-${RUN}`;
const PASSPHRASE = 'a properly long passphrase';
const q = encodeURIComponent;

try {
  let res = await req('/api/login', json({ username: 'admin', password: ADMIN_PASSWORD }));
  check('signed in', res.status === 200, `got ${res.status}`);

  // --- create ---------------------------------------------------------------

  res = await req('/api/mkdir', json({ path: '/', name: `Vault-${RUN}` }));
  check('created an album to encrypt', res.status === 200, `got ${res.status}`);

  res = await req('/api/vaults/create', json({ path: ALBUM, passphrase: PASSPHRASE }));
  const created = await res.json();
  check('turned the album into a vault', res.status === 200, JSON.stringify(created));

  res = await req('/api/vaults/create', json({ path: ALBUM, passphrase: PASSPHRASE }));
  check('turning the same album into a vault twice is refused', res.status === 409, `got ${res.status}`);

  // --- upload into it -------------------------------------------------------
  // Deliberately larger than one 1 MiB chunk so ranges cross a boundary.

  const payload = Buffer.alloc(1024 * 1024 + 5000);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) % 251;

  const form = new FormData();
  form.append('file', new Blob([payload]), 'secret.bin');
  res = await req(`/api/upload?dir=${q(ALBUM)}&rel=secret.bin`, { method: 'POST', body: form });
  const uploaded = await res.json();
  check('uploaded a file into the vault', res.status === 200, JSON.stringify(uploaded));
  check('the upload is reported as encrypted', uploaded.saved?.[0]?.encrypted === true);

  const filePath = uploaded.saved?.[0]?.path;

  // --- read it back ---------------------------------------------------------

  res = await req(`/api/file?path=${q(filePath)}`);
  const got = Buffer.from(await res.arrayBuffer());
  check('the file downloads', res.status === 200, `got ${res.status}`);
  check('it decrypts back to exactly the bytes uploaded',
    got.equals(payload), `${got.length} vs ${payload.length}`);

  // --- ranges over an encrypted file ---------------------------------------
  // This is the whole reason the format is chunked: video seeking.

  res = await req(`/api/file?path=${q(filePath)}`, { headers: { range: 'bytes=100-199' } });
  const slice = Buffer.from(await res.arrayBuffer());
  check('a range request over an encrypted file returns 206', res.status === 206, `got ${res.status}`);
  check('the range holds the right plaintext bytes', slice.equals(payload.subarray(100, 200)));
  check('content-range is stated in plaintext offsets',
    res.headers.get('content-range') === `bytes 100-199/${payload.length}`,
    res.headers.get('content-range'));

  const boundary = 1024 * 1024;
  res = await req(`/api/file?path=${q(filePath)}`,
    { headers: { range: `bytes=${boundary - 10}-${boundary + 10}` } });
  const across = Buffer.from(await res.arrayBuffer());
  check('a range spanning a chunk boundary is correct',
    across.equals(payload.subarray(boundary - 10, boundary + 11)), `${across.length}`);

  res = await req(`/api/file?path=${q(filePath)}`, { headers: { range: 'bytes=-50' } });
  const tail = Buffer.from(await res.arrayBuffer());
  check('a suffix range returns the last 50 plaintext bytes',
    res.status === 206 && tail.equals(payload.subarray(payload.length - 50)), `${tail.length}`);

  // --- the bytes on disk really are encrypted -------------------------------

  res = await req('/api/list?path=' + q(ALBUM));
  const listing = await res.json();
  check('an unlocked vault lists its contents', listing.files?.length === 1, JSON.stringify(listing.files));
  check('the listing marks the album as a vault', listing.vault?.locked === false, JSON.stringify(listing.vault));
  check('the stored size differs from the plaintext size (it has an envelope)',
    listing.files?.[0]?.size !== payload.length,
    `${listing.files?.[0]?.size} vs ${payload.length}`);

  // --- locking --------------------------------------------------------------

  res = await req('/api/vaults/lock', json({ path: ALBUM }));
  check('the vault locks', res.status === 200, `got ${res.status}`);

  res = await req('/api/list?path=' + q(ALBUM));
  const locked = await res.json();
  check('a locked vault lists nothing at all',
    locked.files?.length === 0 && locked.folders?.length === 0, JSON.stringify(locked));
  check('a locked vault says so', locked.vault?.locked === true, JSON.stringify(locked.vault));

  res = await req(`/api/file?path=${q(filePath)}`);
  check('a locked vault refuses to serve its files', res.status === 423, `got ${res.status}`);

  res = await req(`/api/thumb?path=${q(filePath)}`);
  check('a locked vault refuses thumbnails too', res.status === 423, `got ${res.status}`);

  const lockedForm = new FormData();
  lockedForm.append('file', new Blob([Buffer.from('nope')]), 'nope.txt');
  res = await req(`/api/upload?dir=${q(ALBUM)}&rel=nope.txt`, { method: 'POST', body: lockedForm });
  const blocked = await res.json();
  check('uploading into a locked vault fails',
    res.status !== 200 || blocked.saved?.length === 0, JSON.stringify(blocked));

  // --- unlocking ------------------------------------------------------------

  res = await req('/api/vaults/unlock', json({ path: ALBUM, passphrase: 'wrong one entirely' }));
  check('a wrong passphrase does not unlock', res.status === 401, `got ${res.status}`);

  res = await req(`/api/file?path=${q(filePath)}`);
  check('still locked after a failed attempt', res.status === 423, `got ${res.status}`);

  res = await req('/api/vaults/unlock', json({ path: ALBUM, passphrase: PASSPHRASE }));
  check('the right passphrase unlocks it', res.status === 200, `got ${res.status}`);

  res = await req(`/api/file?path=${q(filePath)}`);
  const afterUnlock = Buffer.from(await res.arrayBuffer());
  check('files read correctly again after unlocking', afterUnlock.equals(payload));

  // --- vault listing --------------------------------------------------------

  res = await req('/api/vaults');
  const vaultList = await res.json();
  const mine = vaultList.vaults?.find((v) => v.path === ALBUM);
  check('the vault appears in the vault list', Boolean(mine), JSON.stringify(vaultList));
  check('the vault list reports it unlocked', mine?.unlocked === true);
  check('the vault list never carries key material',
    !JSON.stringify(vaultList).toLowerCase().includes('masterkey')
    && !JSON.stringify(vaultList).includes(PASSPHRASE));

  // --- ordinary albums are untouched ---------------------------------------

  res = await req('/api/mkdir', json({ path: '/', name: `Plain-${RUN}` }));
  check('created a normal album', res.status === 200);
  const plainForm = new FormData();
  plainForm.append('file', new Blob([Buffer.from('just a normal file')]), 'plain.txt');
  res = await req(`/api/upload?dir=${q(`/Plain-${RUN}`)}&rel=plain.txt`, { method: 'POST', body: plainForm });
  const plainUp = await res.json();
  check('a normal upload is not marked encrypted',
    plainUp.saved?.[0]?.encrypted !== true, JSON.stringify(plainUp.saved?.[0]));

  res = await req(`/api/file?path=${q(`/Plain-${RUN}/plain.txt`)}`);
  const plainBack = await res.text();
  check('normal files still work exactly as before', plainBack === 'just a normal file', plainBack);
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error -> ${err.stack || err.message}`);
} finally {
  // Locked vaults cannot be deleted through the API by design, so unlock
  // first, then clean up both albums.
  await req('/api/vaults/unlock', json({ path: ALBUM, passphrase: PASSPHRASE })).catch(() => {});
  await req('/api/delete', json({ paths: [ALBUM, `/Plain-${RUN}`] })).catch(() => {});
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
