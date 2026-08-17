/**
 * Roles, album scoping, and session/account revocation.
 *
 * Signs in as an existing admin, creates temporary test accounts and albums,
 * exercises every boundary, then cleans up after itself — in a `finally`, so
 * a failing assertion or an unexpected exception never leaves throwaway
 * accounts or albums behind in a real installation.
 *
 *   node test/permissions.mjs <adminPassword> [baseUrl]
 */

const ADMIN_PASSWORD = process.argv[2];
const BASE = process.argv[3] || 'http://127.0.0.1:8420';

if (!ADMIN_PASSWORD) {
  console.error('Usage: node test/permissions.mjs <adminPassword> [baseUrl]');
  process.exit(2);
}

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

/** Each account gets its own cookie jar so sessions don't cross-contaminate. */
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

const uploadForm = () => {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('hello')]), 'note.txt');
  return form;
};

const RUN = Date.now().toString(36);
const familyAlbum = `/Family-${RUN}`;
const privateAlbum = `/Private-${RUN}`;

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

  // --- fixtures: two albums, one accessible, one not -----------------------

  for (const name of [`Family-${RUN}`, `Private-${RUN}`]) {
    res = await admin('/api/mkdir', json({ path: '/', name }));
    if (res.status === 200) albumsCreated.push(`/${name}`);
  }
  check('fixture albums created', albumsCreated.length === 2, JSON.stringify(albumsCreated));

  res = await createAccount(`viewer-${RUN}`, 'viewer', ['/']);
  check('create viewer account', res.status === 200, `got ${res.status}`);
  res = await createAccount(`contrib-${RUN}`, 'contributor', ['/']);
  check('create contributor account', res.status === 200, `got ${res.status}`);
  res = await createAccount(`manager-${RUN}`, 'manager', ['/']);
  check('create manager account', res.status === 200, `got ${res.status}`);
  res = await createAccount(`scoped-${RUN}`, 'contributor', [familyAlbum]);
  check('create album-scoped account', res.status === 200, `got ${res.status}`);

  res = await admin('/api/accounts', { method: 'POST' });
  check('creating an account with no body fails cleanly', res.status === 400, `got ${res.status}`);

  // --- role ceilings --------------------------------------------------------

  const viewer = client();
  await login(viewer, `viewer-${RUN}`, 'Testpass123');

  res = await viewer('/api/list?path=/');
  check('viewer can list', res.status === 200, `got ${res.status}`);
  res = await viewer('/api/mkdir', json({ path: '/', name: `nope-${RUN}` }));
  check('viewer cannot create an album', res.status === 403, `got ${res.status}`);
  res = await viewer('/api/delete', json({ paths: [familyAlbum] }));
  check('viewer cannot delete', res.status === 403, `got ${res.status}`);
  res = await viewer('/api/accounts');
  check('viewer cannot list accounts', res.status === 403, `got ${res.status}`);

  const contributor = client();
  await login(contributor, `contrib-${RUN}`, 'Testpass123');

  res = await contributor(`/api/upload?dir=${encodeURIComponent(familyAlbum)}&rel=note.txt`,
    { method: 'POST', body: uploadForm() });
  check('contributor can upload', res.status === 200, `got ${res.status}`);
  res = await contributor('/api/delete', json({ paths: [`${familyAlbum}/note.txt`] }));
  check('contributor cannot delete', res.status === 403, `got ${res.status}`);
  res = await contributor('/api/rename', json({ path: `${familyAlbum}/note.txt`, name: 'renamed.txt' }));
  check('contributor cannot rename', res.status === 403, `got ${res.status}`);

  const manager = client();
  await login(manager, `manager-${RUN}`, 'Testpass123');

  res = await manager('/api/rename', json({ path: `${familyAlbum}/note.txt`, name: `renamed-${RUN}.txt` }));
  check('manager can rename', res.status === 200, `got ${res.status}`);
  res = await manager('/api/delete', json({ paths: [`${familyAlbum}/renamed-${RUN}.txt`] }));
  check('manager can delete', res.status === 200, `got ${res.status}`);
  res = await manager('/api/accounts');
  check('manager cannot manage accounts', res.status === 403, `got ${res.status}`);

  // --- album scoping ---------------------------------------------------------

  const scoped = client();
  await login(scoped, `scoped-${RUN}`, 'Testpass123');

  res = await scoped('/api/list?path=/');
  const scopedRoot = await res.json();
  check('scoped account sees only its own root at "/"',
    scopedRoot.folders?.length === 1 && scopedRoot.folders[0].path === familyAlbum,
    JSON.stringify(scopedRoot));

  res = await scoped(`/api/list?path=${encodeURIComponent(privateAlbum)}`);
  check('scoped account is refused outside its root', res.status === 400, `got ${res.status}`);

  res = await scoped(`/api/upload?dir=${encodeURIComponent(privateAlbum)}&rel=x.txt`,
    { method: 'POST', body: uploadForm() });
  check('scoped account cannot upload outside its root', res.status === 400, `got ${res.status}`);

  res = await scoped(`/api/upload?dir=${encodeURIComponent(familyAlbum)}&rel=ok.txt`,
    { method: 'POST', body: uploadForm() });
  check('scoped account can upload inside its root', res.status === 200, `got ${res.status}`);

  // resolveSafe collapses ".." within bounds before the traversal check ever
  // sees it, so this lands on the *sibling* album "/Private-<run>" — a
  // perfectly valid library path, just not one of this account's roots. It is
  // isWithinRoots(), not traversal rejection, that must catch it here.
  res = await scoped(`/api/list?path=${encodeURIComponent(`${familyAlbum}/../Private-${RUN}`)}`);
  check('scoped account cannot reach a sibling album via a relative path',
    res.status === 400, `got ${res.status}`);

  // A root typed with a trailing slash — an entirely ordinary thing to type,
  // not a hostile input — must not lock the account out of that very root.
  // resolveSafe() never returns a trailing slash for the folder itself, so a
  // root stored as "/Family/" would otherwise never match "/Family".
  res = await createAccount(`trailing-${RUN}`, 'viewer', [`${familyAlbum}/`]);
  check('creating an account with a trailing-slash root succeeds', res.status === 200, `got ${res.status}`);
  const trailingBody = await res.json();
  check('the trailing slash is normalized away in storage',
    trailingBody.account?.roots?.[0] === familyAlbum, JSON.stringify(trailingBody));

  const trailingSlashAcct = client();
  await login(trailingSlashAcct, `trailing-${RUN}`, 'Testpass123');
  res = await trailingSlashAcct(`/api/list?path=${encodeURIComponent(familyAlbum)}`);
  check('an account with a trailing-slash root can access that root folder',
    res.status === 200, `got ${res.status}`);

  // --- revocation ------------------------------------------------------------

  res = await admin('/api/sessions');
  const allSessions = (await res.json()).sessions;
  const viewerSession = allSessions.find((s) => s.username === `viewer-${RUN}`);
  check('admin sees the viewer session in the device list', Boolean(viewerSession));

  if (viewerSession) {
    res = await admin(`/api/sessions/${viewerSession.id}/revoke`, { method: 'POST' });
    check('admin revokes the viewer session', res.status === 200, `got ${res.status}`);

    res = await viewer('/api/list?path=/');
    check('revoked session is rejected on its very next request', res.status === 401, `got ${res.status}`);
  }

  // --- disabling is immediate, not "next login" -------------------------------

  res = await admin(`/api/accounts/contrib-${RUN}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ disabled: true }),
  });
  check('admin disables the contributor account', res.status === 200, `got ${res.status}`);

  res = await contributor('/api/list?path=/');
  check('disabled account is rejected immediately, same cookie as before',
    res.status === 401, `got ${res.status}`);

  // --- the last admin cannot be locked out -------------------------------------

  res = await admin('/api/accounts/admin', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ disabled: true }),
  });
  check('disabling the only admin account is refused', res.status === 409, `got ${res.status}`);

  res = await admin('/api/accounts/admin', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'viewer' }),
  });
  check('demoting the only admin account is refused', res.status === 409, `got ${res.status}`);

  // Prove the guard is about "the last one", not "admin" by name: add a second
  // admin, and only then does touching the first one succeed.
  res = await createAccount(`admin2-${RUN}`, 'admin', ['/']);
  check('a second admin can be created', res.status === 200, `got ${res.status}`);

  res = await admin(`/api/accounts/admin2-${RUN}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ disabled: true }),
  });
  check('with a second admin present, disabling one of them is allowed',
    res.status === 200, `got ${res.status}`);

  // --- a password change signs out every device holding the old session -----
  // The session cookie is signed with the server secret, not the password, so
  // nothing about changing a password invalidates it on its own. That makes
  // this the one patch that must revoke explicitly: otherwise "change your
  // password" is useless as a response to a stolen device or leaked cookie,
  // which is the single most common reason anyone changes one.

  const pwUser = `pwchange-${RUN}`;
  res = await createAccount(pwUser, 'viewer', ['/']);
  check('created an account to test password-change revocation', res.status === 200, `got ${res.status}`);

  const victim = client();
  await login(victim, pwUser, 'Testpass123');
  res = await victim('/api/list?path=/');
  check('that account has a working session before the change', res.status === 200, `got ${res.status}`);

  res = await admin(`/api/accounts/${encodeURIComponent(pwUser)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'Different456' }),
  });
  check('admin changes that account\'s password', res.status === 200, `got ${res.status}`);

  res = await victim('/api/list?path=/');
  check('the already-signed-in device is signed out by the password change',
    res.status === 401, `got ${res.status}`);

  const rejoined = client();
  res = await login(rejoined, pwUser, 'Different456');
  check('and the new password works for a fresh sign-in', res.status === 200, `got ${res.status}`);

  res = await login(client(), pwUser, 'Testpass123');
  check('while the old password no longer does', res.status === 401, `got ${res.status}`);

  // Changing your *own* password must not sign you out of the session you are
  // using to change it — every other device, yes; the tab in your hand, no.
  const selfUser = `pwself-${RUN}`;
  await createAccount(selfUser, 'manager', ['/']);
  const selfA = client();
  const selfB = client();
  await login(selfA, selfUser, 'Testpass123');
  await login(selfB, selfUser, 'Testpass123');

  res = await selfA('/api/accounts/' + encodeURIComponent(selfUser), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'SelfChosen789' }),
  });
  // A manager cannot PATCH accounts (admin-only), so this specific
  // self-service path is not reachable for them — assert that honestly
  // rather than pretending the route allows it.
  check('a non-admin cannot change any account through the accounts route, including their own',
    res.status === 403, `got ${res.status}`);

  // The admin doing it to themselves is the reachable version of the same
  // case: their own current session survives, other devices do not.
  const adminSecond = client();
  await login(adminSecond, 'admin', ADMIN_PASSWORD);
  res = await adminSecond('/api/list?path=/');
  check('a second admin device is signed in before the self-change', res.status === 200, `got ${res.status}`);

  res = await admin('/api/accounts/admin', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  check('admin re-sets their own password to the same value', res.status === 200, `got ${res.status}`);

  res = await admin('/api/list?path=/');
  check('the admin session that made the change stays signed in', res.status === 200, `got ${res.status}`);

  res = await adminSecond('/api/list?path=/');
  check('but the admin\'s other device is signed out', res.status === 401, `got ${res.status}`);

  // --- admin passwords have a higher minimum than lesser roles --------------
  // Same reasoning the first-run wizard already applies: an admin account can
  // reach every file and every setting, from every device on the network.

  res = await admin('/api/accounts', json({
    username: `shortadmin-${RUN}`, password: 'abcd', role: 'admin', roots: ['/'],
  }));
  check('a 4-character admin password is refused', res.status === 400, `got ${res.status}`);

  res = await admin('/api/accounts', json({
    username: `shortviewer-${RUN}`, password: 'abcd', role: 'viewer', roots: ['/'],
  }));
  if (res.status === 200) accountsCreated.push(`shortviewer-${RUN}`);
  check('the same short password is still fine for a viewer', res.status === 200, `got ${res.status}`);

  res = await admin(`/api/accounts/shortviewer-${RUN}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'admin', password: 'abcd' }),
  });
  check('promoting to admin with a short password in the same request is refused',
    res.status === 400, `got ${res.status}`);
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error during the test run -> ${err.stack || err.message}`);
} finally {
  // Always runs, even after a thrown assertion, so a broken test run never
  // leaves throwaway accounts or albums behind in a real installation.
  for (const username of accountsCreated) {
    await admin(`/api/accounts/${encodeURIComponent(username)}`, { method: 'DELETE' }).catch(() => {});
  }
  for (const albumPath of albumsCreated) {
    await admin('/api/delete', json({ paths: [albumPath] })).catch(() => {});
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
