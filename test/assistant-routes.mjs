/**
 * Phase O3's assistant chat routes over the HTTP API: the model picker,
 * and a real conversation turn — plus that every one of these routes is
 * admin-only.
 *
 * No real local model is expected to be running wherever this suite runs
 * (the same assumption test/sort-rules-routes.mjs's draft-route test
 * already makes), so what /api/assistant/message actually proves here is
 * that the route reports that honestly — a clear 400, never a hang or a
 * 500 — rather than that a real conversation works end to end.
 *
 *   node test/assistant-routes.mjs <adminPassword> [baseUrl]
 */

const ADMIN_PASSWORD = process.argv[2];
const BASE = process.argv[3] || 'http://127.0.0.1:8420';

if (!ADMIN_PASSWORD) {
  console.error('Usage: node test/assistant-routes.mjs <adminPassword> [baseUrl]');
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

const RUN = Date.now().toString(36);
const admin = client();
const accountsCreated = [];

try {
  let res = await login(admin, 'admin', ADMIN_PASSWORD);
  check('admin signs in', res.status === 200, `got ${res.status}`);

  // --- model picker ------------------------------------------------------

  res = await admin('/api/assistant/models');
  let body = await res.json();
  check('the model picker reports a shape, whether or not Ollama is actually reachable here',
    res.status === 200 && Array.isArray(body.installed) && typeof body.selected === 'string'
    && typeof body.reachable === 'boolean', JSON.stringify(body));
  check('the default model is Hermes 3, per plan.md\'s stated choice', body.selected === 'hermes3:8b', body.selected);

  res = await admin('/api/assistant/model', json({ model: 'hermes3:8b' }));
  body = await res.json();
  check('setting a model succeeds', res.status === 200 && body.selected === 'hermes3:8b', JSON.stringify(body));

  res = await admin('/api/assistant/model', json({ model: '' }));
  body = await res.json();
  check('an empty model name is refused', res.status === 400 && typeof body.error === 'string', JSON.stringify(body));

  // --- a conversation turn ------------------------------------------------

  res = await admin('/api/assistant/message', json({ message: 'How many files do I have?' }));
  body = await res.json();
  check('a message without a reachable local model fails clearly rather than hanging or crashing',
    res.status === 400 && typeof body.error === 'string', JSON.stringify(body));

  res = await admin('/api/assistant/message', json({ message: '   ' }));
  body = await res.json();
  check('an empty message is refused before ever reaching the model', res.status === 400 && typeof body.error === 'string');

  res = await admin('/api/assistant/message', json({}));
  body = await res.json();
  check('a missing message is refused the same way', res.status === 400 && typeof body.error === 'string');

  // --- admin-only, every route -------------------------------------------------

  await admin('/api/accounts', json({ username: `viewer-${RUN}`, password: 'Testpass123', role: 'viewer', roots: ['/'] }));
  accountsCreated.push(`viewer-${RUN}`);
  const viewer = client();
  await login(viewer, `viewer-${RUN}`, 'Testpass123');

  for (const [method, path] of [
    ['GET', '/api/assistant/models'],
    ['POST', '/api/assistant/model'],
    ['POST', '/api/assistant/message'],
  ]) {
    res = await viewer(path, method === 'POST' ? json({ model: 'x', message: 'x' }) : {});
    check(`a non-admin is refused on ${method} ${path}`, res.status === 403, `got ${res.status}`);
  }
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error during the test run -> ${err.stack || err.message}`);
} finally {
  for (const username of accountsCreated) {
    await admin(`/api/accounts/${encodeURIComponent(username)}`, { method: 'DELETE' }).catch(() => {});
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
