/**
 * Phase O2's trust/audit-log routes over the HTTP API: reading and setting
 * trust levels, reading the audit log, and reverting an approved proposal
 * — plus that every one of these routes is admin-only.
 *
 *   node test/trust-routes.mjs <adminPassword> [baseUrl]
 */

const ADMIN_PASSWORD = process.argv[2];
const BASE = process.argv[3] || 'http://127.0.0.1:8420';

if (!ADMIN_PASSWORD) {
  console.error('Usage: node test/trust-routes.mjs <adminPassword> [baseUrl]');
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

  // --- reading trust levels ----------------------------------------------

  res = await admin('/api/trust');
  let body = await res.json();
  check('every known action type is listed',
    res.status === 200 && body.actionTypes.some((a) => a.actionType === 'trip_cluster')
    && body.actionTypes.some((a) => a.actionType === 'camera_correction'), JSON.stringify(body));
  check('each entry reports its current level and promotion evidence',
    body.actionTypes.every((a) => typeof a.level === 'string' && a.evidence), JSON.stringify(body));

  // --- setting a trust level ----------------------------------------------

  res = await admin('/api/trust/trip_cluster', json({ level: 'ghost' }));
  body = await res.json();
  check('setting a valid level succeeds', res.status === 200 && body.level === 'ghost', JSON.stringify(body));

  res = await admin('/api/trust');
  body = await res.json();
  check('the change is reflected on the next read',
    body.actionTypes.find((a) => a.actionType === 'trip_cluster')?.level === 'ghost', JSON.stringify(body));

  res = await admin('/api/trust/trip_cluster', json({ level: 'not-a-real-level' }));
  body = await res.json();
  check('an invalid level is refused with a clear 400', res.status === 400 && typeof body.error === 'string', JSON.stringify(body));

  // Reset for a clean state for the rest of the run and any suite after this one.
  await admin('/api/trust/trip_cluster', json({ level: 'ask' }));

  // --- the audit log --------------------------------------------------------

  res = await admin('/api/audit-log');
  body = await res.json();
  check('the audit log is readable and shaped as expected',
    res.status === 200 && Array.isArray(body.entries), JSON.stringify(body));

  res = await admin('/api/audit-log?actionType=trip_cluster');
  body = await res.json();
  check('the audit log is filterable by action type', res.status === 200 && Array.isArray(body.entries), JSON.stringify(body));

  // --- reverting a proposal that does not exist fails clearly ----------------

  res = await admin('/api/pattern-engine/proposals/does-not-exist/revert', { method: 'POST' });
  body = await res.json();
  check('reverting an unknown proposal id is refused with a clear 400',
    res.status === 400 && typeof body.error === 'string', JSON.stringify(body));

  // --- admin-only, every route -------------------------------------------------

  await admin('/api/accounts', json({ username: `viewer-${RUN}`, password: 'Testpass123', role: 'viewer', roots: ['/'] }));
  accountsCreated.push(`viewer-${RUN}`);
  const viewer = client();
  await login(viewer, `viewer-${RUN}`, 'Testpass123');

  for (const [method, path] of [
    ['GET', '/api/trust'],
    ['POST', '/api/trust/trip_cluster'],
    ['GET', '/api/audit-log'],
    ['POST', '/api/pattern-engine/proposals/x/revert'],
  ]) {
    res = await viewer(path, method === 'POST' ? json({ level: 'ask' }) : {});
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
