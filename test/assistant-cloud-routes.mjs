/**
 * Phase O5's cloud API key storage over real HTTP, against a server with a
 * real (if fake, for the test) secrets store — something the shared
 * run-all.mjs server can never have, since only the desktop app threads
 * one into start() at all. Mirrors test/central-index-routes.mjs's own
 * helper-server pattern for exactly the same reason.
 *
 *   node test/assistant-cloud-routes.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const helper = path.join(here, 'helpers', 'secrets-server.mjs');

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

const PORT = 8598;
const PASSWORD = 'CloudTestPassword123';

function startServer() {
  const home = mkdtempSync(path.join(tmpdir(), 'lanshare-assistant-cloud-'));
  const env = {
    ...process.env, LANSHARE_HOME: home, PORT: String(PORT), ADMIN_PASSWORD: PASSWORD,
  };
  const proc = spawn(process.execPath, [helper], { cwd: root, env, stdio: 'ignore' });
  return { proc, home, base: `http://127.0.0.1:${PORT}` };
}

async function waitForPing(base, deadlineMs = 20000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/ping`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`${base} did not answer in time`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 300); });
  }
}

function stopServer(handle) {
  return new Promise((resolve) => {
    if (!handle?.proc || handle.proc.killed) { resolve(); return; }
    handle.proc.once('exit', () => resolve());
    handle.proc.kill();
  });
}

const server = startServer();

try {
  await waitForPing(server.base);
  const admin = client(server.base);
  let res = await login(admin, 'admin', PASSWORD);
  check('admin signs in', res.status === 200, `got ${res.status}`);

  // --- with a real secrets store available ------------------------------

  res = await admin('/api/assistant/models');
  let body = await res.json();
  check('a working secrets store is reported as available', body.cloudAvailable === true, JSON.stringify(body));
  check('no cloud key is configured yet', body.cloudConfigured === false);
  check('the disclosure text is included for the UI to show', typeof body.cloudDisclosure === 'string' && body.cloudDisclosure.length > 0);

  res = await admin('/api/assistant/cloud-key', json({ apiKey: '' }));
  body = await res.json();
  check('an empty key is refused', res.status === 400 && typeof body.error === 'string');

  res = await admin('/api/assistant/cloud-key', json({ apiKey: 'sk-ant-test-key-12345', model: 'claude-sonnet-5' }));
  body = await res.json();
  check('setting a real key succeeds', res.status === 200 && body.ok === true, JSON.stringify(body));

  res = await admin('/api/assistant/models');
  body = await res.json();
  check('the key now shows as configured', body.cloudConfigured === true);
  check('the key itself is never returned by any route', JSON.stringify(body).indexOf('sk-ant-test-key-12345') === -1);
  check('the chosen cloud model is reported', body.cloudModel === 'claude-sonnet-5', body.cloudModel);

  // A message with backend:'cloud' now has a key to decrypt and use — it
  // will still fail (no real Anthropic endpoint here), but it must fail
  // *past* the "no key configured" gate, proving the key round-tripped
  // through real encrypt/decrypt rather than just being remembered as set.
  res = await admin('/api/assistant/message', json({ message: 'hello', backend: 'cloud' }));
  body = await res.json();
  check('with a key configured, a cloud message is attempted (and fails on the network, not on a missing key)',
    res.status === 400 && !body.error.toLowerCase().includes('no cloud api key'), JSON.stringify(body));

  res = await admin('/api/assistant/cloud-key', { method: 'DELETE' });
  body = await res.json();
  check('the key can be removed', res.status === 200 && body.ok === true);

  res = await admin('/api/assistant/models');
  body = await res.json();
  check('after removal, it no longer shows as configured', body.cloudConfigured === false);

  res = await admin('/api/assistant/message', json({ message: 'hello', backend: 'cloud' }));
  body = await res.json();
  check('without a key, a cloud message is refused before ever making a network call',
    res.status === 400 && body.error.toLowerCase().includes('no cloud api key'), JSON.stringify(body));

  // --- admin-only ----------------------------------------------------------

  await admin('/api/accounts', json({
    username: 'viewer-cloud', password: 'Testpass123', role: 'viewer', roots: ['/'],
  }));
  const viewer = client(server.base);
  await login(viewer, 'viewer-cloud', 'Testpass123');

  res = await viewer('/api/assistant/cloud-key', json({ apiKey: 'x' }));
  check('a non-admin cannot set the cloud key', res.status === 403, `got ${res.status}`);

  res = await viewer('/api/assistant/cloud-key', { method: 'DELETE' });
  check('a non-admin cannot delete the cloud key', res.status === 403, `got ${res.status}`);
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error during the test run -> ${err.stack || err.message}`);
} finally {
  await stopServer(server);
  rmSync(server.home, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
