/**
 * A config.json from before accounts had roles must still work after the
 * upgrade — and the account it contains must come back as admin, or
 * upgrading locks you out of your own library.
 *
 * Builds a v1-shaped config.json in an isolated temp directory (via
 * LANSHARE_HOME) and boots a throwaway server instance against it, so this
 * never touches the real installation.
 *
 *   node test/migration.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const configLib = require(path.join(repoRoot, 'lib', 'config.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const home = mkdtempSync(path.join(tmpdir(), 'lanshare-migration-'));
const PASSWORD = 'OldPassword123';

try {
  // A config.json exactly as it would have looked before roles existed: no
  // role, no roots, no disabled flag.
  const { salt, hash } = configLib.hashPassword(PASSWORD);
  const v1Config = {
    port: 0,
    library: path.join(home, 'library'),
    sessionDays: 30,
    users: [{ username: 'admin', salt, hash }],
    secret: 'test-secret-not-used-for-anything-real',
  };
  writeFileSync(path.join(home, 'config.json'), JSON.stringify(v1Config, null, 2));

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(repoRoot, 'server.js')], {
    env: { ...process.env, LANSHARE_HOME: home, PORT: String(port), HTTPS_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    try {
      await fetch(`${base}/login`);
      ready = true;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  check('an isolated server boots against a v1 config.json', ready, out.slice(0, 500));

  let cookie = '';
  let res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  check('the old password still signs in', res.status === 200, `got ${res.status}`);
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];

  res = await fetch(`${base}/api/me`, { headers: { cookie } });
  const me = await res.json();
  check('the migrated account comes back as admin', me.role === 'admin', JSON.stringify(me));
  check('the migrated account is unrestricted', (me.roots || []).includes('/'), JSON.stringify(me.roots));

  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));

  const onDisk = JSON.parse(require('fs').readFileSync(path.join(home, 'config.json'), 'utf8'));
  const migratedUser = onDisk.users[0];
  check('config.json on disk is upgraded to include role',
    migratedUser.role === 'admin', JSON.stringify(migratedUser));
  check('config.json on disk is upgraded to include roots',
    Array.isArray(migratedUser.roots) && migratedUser.roots.includes('/'));
  check('config.json on disk is upgraded to include disabled: false',
    migratedUser.disabled === false);

  // --- a config.json that cannot be parsed is explained, not thrown raw -----
  // config.json holds the signing secret and every password hash, and is
  // rewritten on every account change. A process killed mid-write used to
  // leave a truncated file that took the whole app down with a bare
  // SyntaxError from module scope, before any error handling existed.

  const brokenHome = mkdtempSync(path.join(tmpdir(), 'lanshare-badconfig-'));
  try {
    writeFileSync(path.join(brokenHome, 'config.json'), '{ "users": [ truncated mid-writ');

    const probe = spawn(process.execPath, ['-e', `
      process.env.LANSHARE_HOME = ${JSON.stringify(brokenHome)};
      try {
        require(${JSON.stringify(path.join(repoRoot, 'lib', 'config.js').replace(/\\/g, '/'))}).load();
        console.log('NO_THROW');
      } catch (err) {
        console.log('THREW:' + err.message);
      }
    `], { stdio: ['ignore', 'pipe', 'pipe'] });

    let probeOut = '';
    probe.stdout.on('data', (c) => { probeOut += c; });
    probe.stderr.on('data', (c) => { probeOut += c; });
    await new Promise((resolve) => probe.on('close', resolve));

    check('a corrupt config.json throws rather than being silently replaced by defaults',
      probeOut.includes('THREW:'), probeOut.slice(0, 300));
    check('and the message names the file and says what to do about it',
      probeOut.includes('config.json') && /restore|delete/i.test(probeOut), probeOut.slice(0, 300));
    check('and it is not a bare JSON parse error with no context',
      !/^THREW:(Unexpected|Expected)/m.test(probeOut), probeOut.slice(0, 300));
  } finally {
    rmSync(brokenHome, { recursive: true, force: true });
  }

  // --- saving is atomic, so an interrupted write cannot truncate the live file
  {
    const atomicHome = mkdtempSync(path.join(tmpdir(), 'lanshare-atomic-'));
    try {
      const saved = configLib.save.toString();
      check('save() writes to a temp file and renames it into place, never over the live file',
        /\.tmp/.test(saved) && /renameSync/.test(saved), saved.slice(0, 200));
    } finally {
      rmSync(atomicHome, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
