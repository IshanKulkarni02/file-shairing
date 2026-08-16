/**
 * Federated search over real HTTP, between two real LANShare servers: a
 * result that lives on both merges into one with two locations, a
 * peer-only result comes through labelled with where it actually lives, a
 * non-admin account never reaches the peer at all, and killing the peer
 * mid-test still answers from what was cached the moment before — honestly
 * marked as such.
 *
 * Fully self-contained: starts and stops both servers itself, so it needs
 * nothing from test/run-all.mjs beyond being run as a plain suite.
 *
 *   node test/federation-routes.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const helper = path.join(here, 'helpers', 'federation-server.mjs');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

function client(base) {
  let cookie = '';
  return async (p, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + p, { ...options, headers, redirect: 'manual' });
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

async function waitForIdle(req, deadlineMs = 30000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const body = await (await req('/api/index/status')).json();
    if (!body.scanning) return body;
    if (Date.now() > deadline) throw new Error('index scan did not finish in time');
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function rebuildAndWait(req) {
  let body = await (await req('/api/index/rebuild', { method: 'POST' })).json();
  if (body.alreadyRunning) {
    await waitForIdle(req);
    await req('/api/index/rebuild', { method: 'POST' });
  }
  await waitForIdle(req);
}

/** A server started for this suite alone — its own home, port and process. */
function startServer({ port, adminPassword, peer }) {
  const home = mkdtempSync(path.join(tmpdir(), 'lanshare-federation-'));
  const env = {
    ...process.env,
    LANSHARE_HOME: home,
    PORT: String(port),
    ADMIN_PASSWORD: adminPassword,
    ...(peer ? { PEER_JSON: JSON.stringify(peer) } : {}),
  };
  const proc = spawn(process.execPath, [helper], { cwd: root, env, stdio: 'ignore' });
  return { proc, home, base: `http://127.0.0.1:${port}` };
}

async function waitForPing(base, deadlineMs = 20000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/ping`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`${base} did not answer in time`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Mirrors run-all.mjs's stopServer(): waits for the process to actually be
 * gone, not just asked to go, so a WAL-mode SQLite file has time to release
 * before cleanup tries to delete the directory holding it. */
function stopServer(handle) {
  return new Promise((resolve) => {
    if (!handle?.proc || handle.proc.killed) { resolve(); return; }
    handle.proc.once('exit', () => resolve());
    handle.proc.kill();
    setTimeout(resolve, 5000);
  });
}

const RUN = Date.now().toString(36);
const TOKEN = `zzfed${RUN}`;
const SHARED_BYTES = Buffer.from(`shared content ${RUN}`);
const B_ONLY_BYTES = Buffer.from(`only on b ${RUN}`);
const PORT_A = 8750;
const PORT_B = 8752;
const PASSWORD_A = 'a properly long password for A';
const PASSWORD_B = 'a properly long password for B';

let serverA = null;
let serverB = null;

try {
  serverB = startServer({ port: PORT_B, adminPassword: PASSWORD_B });
  await waitForPing(serverB.base);
  const bAdmin = client(serverB.base);
  await login(bAdmin, 'admin', PASSWORD_B);

  await bAdmin('/api/mkdir', json({ path: '/', name: 'Shared' }));
  await bAdmin('/api/mkdir', json({ path: '/', name: 'OnlyB' }));
  await uploadFile(bAdmin, '/Shared', `${TOKEN}-on-b.jpg`, SHARED_BYTES);
  await uploadFile(bAdmin, '/OnlyB', `${TOKEN}-unique.jpg`, B_ONLY_BYTES);
  await rebuildAndWait(bAdmin);

  serverA = startServer({
    port: PORT_A, adminPassword: PASSWORD_A,
    peer: { id: 'peerB', label: 'Peer B', base: serverB.base, username: 'admin', password: PASSWORD_B },
  });
  await waitForPing(serverA.base);
  const aAdmin = client(serverA.base);
  await login(aAdmin, 'admin', PASSWORD_A);

  await aAdmin('/api/mkdir', json({ path: '/', name: 'Shared' }));
  await uploadFile(aAdmin, '/Shared', `${TOKEN}-on-a.jpg`, SHARED_BYTES);
  await rebuildAndWait(aAdmin);

  // --- admin, both machines reachable ---------------------------------------

  let res = await aAdmin(`/api/search?q=${TOKEN}`);
  let body = await res.json();
  check('search reaches the running peer', res.status === 200, JSON.stringify(body));

  const shared = body.results?.find((r) => r.locations?.length === 2);
  const onlyB = body.results?.find((r) => r.locations?.some((l) => l.path?.includes('unique')));

  check('the file uploaded separately to both machines merges into one result',
    Boolean(shared), JSON.stringify(body.results));
  if (shared) {
    check('the merged result names both this machine and the peer',
      shared.locations.some((l) => l.source === 'local') && shared.locations.some((l) => l.source === 'peerB'),
      JSON.stringify(shared.locations));
    check('both locations are currently reachable',
      shared.locations.every((l) => l.reachable === true), JSON.stringify(shared.locations));
  }

  check('a file that exists only on the peer still shows up, attributed to it',
    Boolean(onlyB) && onlyB.locations.length === 1 && onlyB.locations[0].source === 'peerB',
    JSON.stringify(onlyB));

  check('the response reports the peer as reachable',
    body.peers?.some((p) => p.id === 'peerB' && p.reachable === true), JSON.stringify(body.peers));

  // --- a non-admin's search never reaches the peer, even though it is up ----

  await aAdmin('/api/accounts', json({ username: `viewer-${RUN}`, password: 'Testpass123', role: 'viewer', roots: ['/'] }));
  const aViewer = client(serverA.base);
  await login(aViewer, `viewer-${RUN}`, 'Testpass123');

  res = await aViewer(`/api/search?q=${TOKEN}`);
  body = await res.json();
  check('a non-admin search still succeeds and finds its own local file',
    res.status === 200 && body.results?.some((r) => r.locations?.some((l) => l.source === 'local')),
    JSON.stringify(body));
  check('a non-admin search never includes anything from the peer',
    !body.results?.some((r) => r.locations?.some((l) => l.source === 'peerB')), JSON.stringify(body.results));
  check('a non-admin search reports no peers at all', (body.peers?.length ?? 0) === 0, JSON.stringify(body.peers));

  // --- the peer goes offline mid-session -------------------------------------
  // stopServer() is called again, harmlessly, in the finally block below —
  // it is idempotent, and serverB.home still has to survive to be cleaned up.

  await stopServer(serverB);

  res = await aAdmin(`/api/search?q=${TOKEN}`);
  body = await res.json();
  check('search still succeeds once the peer is unreachable', res.status === 200, JSON.stringify(body));

  const sharedOffline = body.results?.find((r) => r.locations?.length === 2);
  const onlyBOffline = body.results?.find((r) => r.locations?.some((l) => l.path?.includes('unique')));

  check('the merged result is still there, from cache', Boolean(sharedOffline), JSON.stringify(body.results));
  if (sharedOffline) {
    const peerLoc = sharedOffline.locations.find((l) => l.source === 'peerB');
    check('the peer\'s side of it is now honestly marked unreachable', peerLoc?.reachable === false, JSON.stringify(peerLoc));
    check('and carries when it was last actually seen', Boolean(peerLoc?.cachedAt), JSON.stringify(peerLoc));
    check('the local side is unaffected — still reachable', sharedOffline.locations.find((l) => l.source === 'local')?.reachable === true);
  }

  check('the peer-only file is also still findable, from cache, marked unreachable',
    Boolean(onlyBOffline) && onlyBOffline.locations[0].reachable === false, JSON.stringify(onlyBOffline));

  check('the response reports the peer as unreachable, with a reason',
    body.peers?.some((p) => p.id === 'peerB' && p.reachable === false && p.error), JSON.stringify(body.peers));
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error during the test run -> ${err.stack || err.message}`);
} finally {
  await Promise.all([stopServer(serverA), stopServer(serverB)]);
  if (serverA) rmSync(serverA.home, { recursive: true, force: true });
  if (serverB) rmSync(serverB.home, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
