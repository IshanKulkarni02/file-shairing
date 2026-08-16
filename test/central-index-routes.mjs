/**
 * The central index over real HTTP and a real relay: two devices publish,
 * then both are killed entirely, and a third device — sharing nothing with
 * either but the same passphrase and the same relay address — still finds
 * both of their files. That property is the whole point of Phase J and the
 * one thing Phase I's peer federation cannot do: a peer that is offline
 * contributes nothing until it answers a search itself at least once, but a
 * device that published to the central index need never be reachable again
 * for its files to keep showing up.
 *
 * Fully self-contained: starts and stops the relay and every server itself.
 *
 *   node test/central-index-routes.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const helper = path.join(here, 'helpers', 'federation-server.mjs');
const { createRelay } = require(path.join(root, 'relay', 'server.js'));

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

function startServer({ port, adminPassword }) {
  const home = mkdtempSync(path.join(tmpdir(), 'lanshare-central-index-'));
  const env = { ...process.env, LANSHARE_HOME: home, PORT: String(port), ADMIN_PASSWORD: adminPassword };
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

function stopServer(handle) {
  return new Promise((resolve) => {
    if (!handle?.proc || handle.proc.killed) { resolve(); return; }
    handle.proc.once('exit', () => resolve());
    handle.proc.kill();
    setTimeout(resolve, 5000);
  });
}

const RUN = Date.now().toString(36);
const TOKEN = `zzcentral${RUN}`;
const PASSPHRASE = 'the same passphrase typed into every device';
const RELAY_PORT = 8590;

const PORT_A = 8592;
const PORT_B = 8594;
const PORT_C = 8596;
const PASSWORD_A = 'a properly long password for A';
const PASSWORD_B = 'a properly long password for B';
const PASSWORD_C = 'a properly long password for C';

let relay = null;
let serverA = null;
let serverB = null;
let serverC = null;
const relayStoreDir = mkdtempSync(path.join(tmpdir(), 'lanshare-relay-store-'));

async function setUpAndPublish(base, password, folder, fileName, bytes) {
  const req = client(base);
  await login(req, 'admin', password);
  const setupRes = await req('/api/central-index/setup', json({
    relayHost: '127.0.0.1', relayPort: RELAY_PORT, passphrase: PASSPHRASE,
  }));
  check(`central index set up on ${folder}`, setupRes.status === 200, `got ${setupRes.status}`);

  await req('/api/mkdir', json({ path: '/', name: folder }));
  await uploadFile(req, `/${folder}`, fileName, bytes);
  await rebuildAndWait(req);

  const publishRes = await req('/api/central-index/publish', { method: 'POST' });
  const publishBody = await publishRes.json();
  check(`publish succeeds from ${folder}`, publishRes.status === 200 && publishBody.entries >= 1,
    JSON.stringify(publishBody));
  return req;
}

try {
  relay = createRelay({ log: () => {}, storeDir: relayStoreDir });
  await relay.listen(RELAY_PORT, '127.0.0.1');

  serverA = startServer({ port: PORT_A, adminPassword: PASSWORD_A });
  serverB = startServer({ port: PORT_B, adminPassword: PASSWORD_B });
  await Promise.all([waitForPing(serverA.base), waitForPing(serverB.base)]);

  await setUpAndPublish(serverA.base, PASSWORD_A, 'FromA', `${TOKEN}-on-a.jpg`, Buffer.from(`bytes from A ${RUN}`));
  await setUpAndPublish(serverB.base, PASSWORD_B, 'FromB', `${TOKEN}-on-b.jpg`, Buffer.from(`bytes from B ${RUN}`));

  // --- both source devices are now killed entirely ---------------------------
  // Only the relay and its two small published blobs survive them.

  await Promise.all([stopServer(serverA), stopServer(serverB)]);

  serverC = startServer({ port: PORT_C, adminPassword: PASSWORD_C });
  await waitForPing(serverC.base);
  const cAdmin = client(serverC.base);
  await login(cAdmin, 'admin', PASSWORD_C);
  await cAdmin('/api/central-index/setup', json({
    relayHost: '127.0.0.1', relayPort: RELAY_PORT, passphrase: PASSPHRASE,
  }));

  let res = await cAdmin(`/api/search?q=${TOKEN}`);
  let body = await res.json();
  check('a third device, sharing nothing with A or B but the passphrase, still finds both their files',
    res.status === 200 && body.results?.length === 2, JSON.stringify(body));

  check('every result is attributed to the central index, not a live/cached peer',
    body.results?.every((r) => r.locations?.every((l) => l.source.startsWith('central:'))),
    JSON.stringify(body.results));
  check('every central-index result is honestly marked not reachable — it is a publish, not a live machine',
    body.results?.every((r) => r.locations?.every((l) => l.reachable === false)));
  check('every central-index result carries when it was published',
    body.results?.every((r) => r.locations?.every((l) => Boolean(l.cachedAt))));

  check('the response reports the central index as reachable, with both devices counted',
    body.centralIndex?.reachable === true && body.centralIndex?.devices === 2, JSON.stringify(body.centralIndex));

  // --- structured filters work over central-index entries too, not just text -

  res = await cAdmin(`/api/search?q=${TOKEN}&kind=image`);
  body = await res.json();
  check('a kind filter still applies to central-index-sourced results',
    body.results?.length === 2, JSON.stringify(body.results));

  res = await cAdmin(`/api/search?q=${TOKEN}&kind=video`);
  body = await res.json();
  check('a kind filter that matches neither excludes both central-index results',
    body.results?.length === 0, JSON.stringify(body.results));

  // --- a non-admin on C never reaches the central index -----------------------

  await cAdmin('/api/accounts', json({ username: `viewer-${RUN}`, password: 'Testpass123', role: 'viewer', roots: ['/'] }));
  const cViewer = client(serverC.base);
  await login(cViewer, `viewer-${RUN}`, 'Testpass123');
  res = await cViewer(`/api/search?q=${TOKEN}`);
  body = await res.json();
  check('a non-admin search on C finds nothing from the central index', (body.results?.length ?? 0) === 0, JSON.stringify(body));
  check('and the response says so — no centralIndex report at all for a non-admin', body.centralIndex == null, JSON.stringify(body.centralIndex));

  // --- the relay itself going away degrades search, does not break it --------

  await relay.close();
  relay = null;

  res = await cAdmin(`/api/search?q=${TOKEN}`);
  body = await res.json();
  check('search still succeeds even when the relay is completely unreachable', res.status === 200, JSON.stringify(body));
  check('central-index results are simply absent rather than the request failing',
    (body.results?.length ?? 0) === 0, JSON.stringify(body.results));
  check('the central index is honestly reported unreachable', body.centralIndex?.reachable === false, JSON.stringify(body.centralIndex));

  // --- publishing without setup, and setup validation -------------------------

  const freshHome = startServer({ port: 8598, adminPassword: 'a properly long password here' });
  await waitForPing(freshHome.base);
  const freshAdmin = client(freshHome.base);
  await login(freshAdmin, 'admin', 'a properly long password here');
  res = await freshAdmin('/api/central-index/publish', { method: 'POST' });
  check('publishing before setup is refused with a clear error', res.status === 400, `got ${res.status}`);

  res = await freshAdmin('/api/central-index/setup', json({ relayHost: '127.0.0.1', relayPort: RELAY_PORT, passphrase: 'short' }));
  check('setup rejects a too-short passphrase', res.status === 400, `got ${res.status}`);
  await stopServer(freshHome);
  rmSync(freshHome.home, { recursive: true, force: true });
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error during the test run -> ${err.stack || err.message}`);
} finally {
  if (relay) await relay.close();
  await Promise.all([stopServer(serverA), stopServer(serverB), stopServer(serverC)]);
  for (const handle of [serverA, serverB, serverC]) {
    if (handle) rmSync(handle.home, { recursive: true, force: true });
  }
  rmSync(relayStoreDir, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
