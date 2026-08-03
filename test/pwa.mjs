/**
 * Checks the HTTPS listener and the assets a browser needs before it will
 * offer to install the app.
 *
 *   node test/pwa.mjs <password> [host]
 */

// The certificate is self-signed on purpose. Accept it for this test process
// only; a real device trusts it once instead. Must be set before the first
// TLS connection is made.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PASSWORD = process.argv[2];
const HOST = process.argv[3] || '127.0.0.1';
const HTTPS_BASE = `https://${HOST}:8443`;
const HTTP_BASE = `http://${HOST}:8420`;

if (!PASSWORD) {
  console.error('Usage: node test/pwa.mjs <password> [host]');
  process.exit(2);
}

let pass = 0;
let fail = 0;
let cookie = '';

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

async function get(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(url, { ...options, headers, redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return res;
}

// --- the secure listener works at all ------------------------------------

let res = await get(`${HTTPS_BASE}/login`);
check('HTTPS listener serves the login page', res.status === 200, `got ${res.status}`);
await res.text();

res = await get(`${HTTPS_BASE}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: PASSWORD }),
});
check('sign-in works over HTTPS', res.status === 200, `got ${res.status}`);

res = await get(`${HTTPS_BASE}/api/list?path=/`);
check('the API works over HTTPS', res.status === 200, `got ${res.status}`);
await res.json();

// --- installability -------------------------------------------------------
// Chrome needs a manifest with a name, a start_url, display standalone, and
// at least one icon of 192px or larger before it offers to install.

res = await get(`${HTTPS_BASE}/manifest.webmanifest`);
const manifest = await res.json();
check('manifest is served', res.status === 200, `got ${res.status}`);
check('manifest has a name', Boolean(manifest.name && manifest.short_name));
check('manifest display is standalone', manifest.display === 'standalone', manifest.display);
check('manifest has a start_url', manifest.start_url === '/', manifest.start_url);
check('manifest declares a maskable icon',
  manifest.icons.some((i) => i.purpose === 'maskable'));
check('manifest has an icon of at least 192px',
  manifest.icons.some((i) => parseInt(i.sizes, 10) >= 192));

for (const icon of manifest.icons) {
  const iconRes = await get(HTTPS_BASE + icon.src);
  const bytes = Buffer.from(await iconRes.arrayBuffer());
  const isPng = bytes.subarray(1, 4).toString() === 'PNG';
  check(`icon exists: ${icon.src}`,
    iconRes.status === 200 && isPng && bytes.length > 200,
    `status ${iconRes.status}, ${bytes.length} bytes`);
}

res = await get(`${HTTPS_BASE}/assets/icons/apple-touch-icon.png`);
const appleIcon = Buffer.from(await res.arrayBuffer());
check('apple-touch-icon exists (iOS ignores the manifest)',
  res.status === 200 && appleIcon.subarray(1, 4).toString() === 'PNG',
  `got ${res.status}`);

// --- service worker -------------------------------------------------------

res = await get(`${HTTPS_BASE}/sw.js`);
const swText = await res.text();
check('service worker is served', res.status === 200, `got ${res.status}`);
check('service worker is not cached by the browser',
  (res.headers.get('cache-control') || '').includes('no-cache'),
  res.headers.get('cache-control'));
check('service worker caches thumbnails', swText.includes('/api/thumb'));
check('service worker leaves the rest of the API uncached',
  swText.includes("url.pathname.startsWith('/api/')"));

// --- certificate download -------------------------------------------------
// Devices need this over plain HTTP: they cannot reach HTTPS until they
// already trust the certificate it serves.

res = await get(`${HTTP_BASE}/cert`);
const pem = await res.text();
check('certificate downloads over plain HTTP', res.status === 200, `got ${res.status}`);
check('certificate is a PEM', pem.includes('BEGIN CERTIFICATE'));
check('certificate is offered as a file',
  (res.headers.get('content-disposition') || '').includes('.crt'),
  res.headers.get('content-disposition'));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
