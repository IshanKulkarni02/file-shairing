/**
 * Run every test suite.
 *
 *   npm test              everything that does not need special hardware
 *   npm test -- --quick   skip the slow ones (media, pwa)
 *   npm test -- media     just the suites whose names contain "media"
 *
 * Sets up its own throwaway library and server, so it never touches the real
 * one and never needs a server started by hand. That matters more than it
 * sounds: the suites were previously only runnable through a shell loop that
 * lived in one person's head.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const filters = args.filter((a) => !a.startsWith('--'));

const HTTP_PORT = 8720;
const HTTPS_PORT = 8721;
const PASSWORD = 'a properly long test password';

/**
 * `kind` decides how a suite is run:
 *   'plain'    — node, no server needed
 *   'server'   — node, given the password and the base URL
 *   'https'    — node, given the password and a host (it builds its own URLs)
 *   'electron' — needs an Electron runtime, not Node
 */
const SUITES = [
  { name: 'sync-plan', file: 'sync-plan.mjs', kind: 'plain' },
  { name: 'sync', file: 'sync.mjs', kind: 'plain' },
  { name: 'sync-watcher', file: 'sync-watcher.mjs', kind: 'plain' },
  { name: 'remote', file: 'remote.mjs', kind: 'plain' },
  { name: 'discovery', file: 'discovery.mjs', kind: 'plain' },
  { name: 'connections', file: 'connections.mjs', kind: 'plain' },
  { name: 'tunnel', file: 'tunnel.mjs', kind: 'plain' },
  { name: 'relay-store', file: 'relay-store.mjs', kind: 'plain' },
  { name: 'volume-parsers', file: 'volume-parsers.mjs', kind: 'plain' },
  { name: 'autostart', file: 'autostart.mjs', kind: 'plain' },
  { name: 'volumes', file: 'volumes.mjs', kind: 'plain' },
  { name: 'locations', file: 'locations.mjs', kind: 'plain' },
  { name: 'library', file: 'library.mjs', kind: 'plain' },
  { name: 'vaultfile', file: 'vaultfile.mjs', kind: 'plain' },
  { name: 'vault', file: 'vault.mjs', kind: 'plain' },
  { name: 'vaults', file: 'vaults.mjs', kind: 'plain' },
  { name: 'migration', file: 'migration.mjs', kind: 'plain' },
  { name: 'e2e-crypto', file: 'e2e-crypto.mjs', kind: 'plain' },
  { name: 'metadata', file: 'metadata.mjs', kind: 'plain' },
  { name: 'index-db', file: 'index-db.mjs', kind: 'plain' },
  { name: 'indexer', file: 'indexer.mjs', kind: 'plain' },
  { name: 'federation', file: 'federation.mjs', kind: 'plain' },
  { name: 'central-index', file: 'central-index.mjs', kind: 'plain' },
  { name: 'smoke', file: 'smoke.mjs', kind: 'server' },
  { name: 'permissions', file: 'permissions.mjs', kind: 'server' },
  { name: 'vault-routes', file: 'vault-routes.mjs', kind: 'server' },
  { name: 'location-routes', file: 'location-routes.mjs', kind: 'server' },
  { name: 'sync-routes', file: 'sync-routes.mjs', kind: 'server' },
  { name: 'search-routes', file: 'search-routes.mjs', kind: 'server' },
  { name: 'federation-routes', file: 'federation-routes.mjs', kind: 'plain' },
  { name: 'central-index-routes', file: 'central-index-routes.mjs', kind: 'plain' },
  { name: 'media', file: 'media.mjs', kind: 'server', slow: true },
  { name: 'pwa', file: 'pwa.mjs', kind: 'https', slow: true },
  { name: 'electron-links', file: 'electron-links.js', kind: 'electron' },
];

function run(command, argv, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, argv, {
      cwd: root,
      env: { ...process.env, ...(options.env || {}) },
      shell: process.platform === 'win32' && command.endsWith('.cmd'),
    });

    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('error', (err) => resolve({ code: 1, output: `${output}\n${err.message}` }));
    child.on('close', (code) => resolve({ code, output }));
  });
}

/** Electron lives in node_modules; going through npx is fragile here. */
function electronBin() {
  const bin = path.join(root, 'node_modules', 'electron', 'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron');
  return existsSync(bin) ? bin : null;
}

const HOME = mkdtempSync(path.join(tmpdir(), 'lanshare-tests-'));

// Set before lib/config.js is required anywhere, because it reads
// LANSHARE_HOME exactly once at load. Overriding whatever the caller had set
// is deliberate: running the tests must never touch a real library, and
// inheriting a stray value from the shell is how that would happen.
process.env.LANSHARE_HOME = HOME;

let server = null;

async function startServer() {
  const configLib = require(path.join(root, 'lib', 'config.js'));
  const { config } = configLib.loadOrCreate();
  config.port = HTTP_PORT;
  config.httpsPort = HTTPS_PORT;
  configLib.save(config);
  configLib.setUser('admin', PASSWORD);

  // Sample media, so the media suite has something real to work on.
  await run(process.execPath, [path.join(here, 'make-samples.mjs')], { env: { LANSHARE_HOME: HOME } });

  server = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, LANSHARE_HOME: HOME },
    stdio: 'ignore',
  });

  // Wait for it to answer rather than sleeping a guessed number of seconds.
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/ping`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('the test server did not start within 60s');
    await new Promise((r) => setTimeout(r, 400));
  }
}

/**
 * Kill the test server and wait for it to actually be gone before returning.
 *
 * `child.kill()` only requests termination — it returns immediately, before
 * the OS has necessarily finished tearing the process down. rmSync() used to
 * run right after it with nothing in between, which raced a still-closing
 * SQLite WAL file on Windows often enough to occasionally fail the whole
 * suite on a clean run with EBUSY, for a reason that had nothing to do with
 * whatever suite happened to run last.
 */
function stopServer() {
  return new Promise((resolve) => {
    if (!server || server.killed) { server = null; resolve(); return; }
    const proc = server;
    server = null;
    proc.once('exit', () => resolve());
    proc.kill();
    // Windows does not reliably deliver process signals; if 'exit' never
    // fires, this still lets cleanup proceed rather than hang the suite.
    setTimeout(resolve, 5000);
  });
}

const chosen = SUITES
  .filter((s) => (filters.length ? filters.some((f) => s.name.includes(f)) : true))
  .filter((s) => !(quick && s.slow));

console.log(`\n  LANShare — ${chosen.length} suite${chosen.length === 1 ? '' : 's'}\n`);

let totalPassed = 0;
let totalFailed = 0;
const broken = [];

try {
  if (chosen.some((s) => s.kind === 'server' || s.kind === 'https')) await startServer();

  for (const suite of chosen) {
    const file = path.join(here, suite.file);
    let result;

    if (suite.kind === 'electron') {
      const bin = electronBin();
      if (!bin) {
        console.log(`  ${suite.name.padEnd(16)} skipped — Electron is not installed`);
        continue;
      }
      result = await run(bin, [file], { env: { LANSHARE_HOME: HOME } });
    } else {
      const argv = suite.kind === 'server'
        ? [file, PASSWORD, `http://127.0.0.1:${HTTP_PORT}`]
        : suite.kind === 'https'
          ? [file, PASSWORD, '127.0.0.1', String(HTTP_PORT), String(HTTPS_PORT)]
          : [file];
      result = await run(process.execPath, argv, { env: { LANSHARE_HOME: HOME } });
    }

    const summary = result.output.match(/(\d+) passed, (\d+) failed/);
    const passed = summary ? Number(summary[1]) : 0;
    const failed = summary ? Number(summary[2]) : 0;
    totalPassed += passed;
    totalFailed += failed;

    if (!summary) {
      // No summary line at all means it died rather than reported.
      broken.push({ suite, output: result.output });
      console.log(`  ${suite.name.padEnd(16)} CRASHED`);
    } else if (failed > 0 || result.code !== 0) {
      broken.push({ suite, output: result.output });
      console.log(`  ${suite.name.padEnd(16)} ${passed} passed, ${failed} FAILED`);
    } else {
      console.log(`  ${suite.name.padEnd(16)} ${passed} passed`);
    }
  }
} catch (err) {
  console.error(`\n  Could not run the suites: ${err.message}\n`);
  totalFailed++;
} finally {
  await stopServer();
  rmSync(HOME, { recursive: true, force: true });
}

// Only the failures get their output printed. A wall of green scrolls the one
// thing worth reading off the screen.
for (const { suite, output } of broken) {
  console.log(`\n${'─'.repeat(70)}\n  ${suite.name}\n${'─'.repeat(70)}`);
  const lines = output.split('\n');
  const interesting = lines.filter((l) => /FAIL|Error|error:/i.test(l)).slice(0, 25);
  console.log((interesting.length ? interesting : lines.slice(-25)).join('\n'));
}

console.log(`\n  ${totalPassed} passed, ${totalFailed} failed`
  + `${broken.length ? `, ${broken.length} suite${broken.length === 1 ? '' : 's'} with problems` : ''}\n`);

process.exit(totalFailed || broken.length ? 1 : 0);
