/**
 * Starting on login, per platform.
 *
 * The Linux path is the one worth testing hardest, because it is the one
 * Electron does not implement: `setLoginItemSettings` is a silent no-op
 * there, so the checkbox would tick, the setting would save, and nothing
 * would ever start.
 *
 *   node test/autostart.mjs
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const autostart = require(path.join(here, '..', 'lib', 'autostart.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

const roots = [];
function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lanshare-autostart-'));
  roots.push(dir);
  return dir;
}

/** Stands in for Electron's app object. */
function fakeApp() {
  const calls = [];
  let openAtLogin = false;
  return {
    calls,
    setLoginItemSettings: (settings) => { calls.push(settings); openAtLogin = settings.openAtLogin; },
    getLoginItemSettings: () => ({ openAtLogin }),
  };
}

try {
  // --- Linux writes a real file --------------------------------------------

  {
    const dir = scratch();
    const app = fakeApp();

    const result = autostart.set(true, {
      app, platform: 'linux', dir, packaged: true, execPath: '/opt/LANShare/lanshare',
    });

    check('enabling on Linux writes a desktop entry', result.applied === 'desktop-entry');
    check('and the file is really there', existsSync(result.path), result.path);

    const body = readFileSync(result.path, 'utf8');
    check('it is a valid desktop entry', body.startsWith('[Desktop Entry]'));
    check('it runs the app', /^Exec=\/opt\/LANShare\/lanshare$/m.test(body), body);
    check('it does not open a terminal window', /^Terminal=false$/m.test(body));
    check('and GNOME will not show it as disabled',
      /^X-GNOME-Autostart-enabled=true$/m.test(body));

    check('Electron’s login-item API is not called on Linux, where it does nothing',
      app.calls.length === 0, JSON.stringify(app.calls));

    check('and the state is reported from the file, not from config',
      autostart.isEnabled({ platform: 'linux', dir }) === true);

    autostart.set(false, { app, platform: 'linux', dir });
    check('disabling removes the file', !existsSync(result.path));
    check('and the state follows', autostart.isEnabled({ platform: 'linux', dir }) === false);
  }

  {
    // Removing when it was never there must not throw.
    const dir = scratch();
    let threw = false;
    try { autostart.set(false, { platform: 'linux', dir }); } catch { threw = true; }
    check('disabling something already disabled is quiet', !threw);
  }

  {
    // Run from source, execPath is the electron binary and the app directory
    // has to be passed too, or the entry launches an empty Electron shell.
    const dir = scratch();
    const result = autostart.set(true, {
      platform: 'linux', dir, packaged: false,
      execPath: '/usr/lib/node_modules/electron/dist/electron',
      appPath: '/home/ishan/projects/lanshare',
    });
    const body = readFileSync(result.path, 'utf8');
    check('run from source, the entry passes the app directory too',
      /^Exec=\S*electron \S*lanshare$/m.test(body), body.match(/^Exec=.*$/m)?.[0]);
  }

  {
    // Paths with spaces are ordinary on Linux too ("/home/my name/…").
    const dir = scratch();
    const result = autostart.set(true, {
      platform: 'linux', dir, packaged: true, execPath: '/opt/LAN Share/lanshare',
    });
    const exec = readFileSync(result.path, 'utf8').match(/^Exec=(.*)$/m)[1];
    check('a path with a space is quoted', exec === '"/opt/LAN Share/lanshare"', exec);
  }

  // --- where the file goes --------------------------------------------------

  {
    const home = '/home/ishan';
    check('the default location follows the XDG spec',
      autostart.autostartDir({}, home) === path.join(home, '.config', 'autostart'),
      autostart.autostartDir({}, home));
    check('and XDG_CONFIG_HOME is honoured when set',
      autostart.autostartDir({ XDG_CONFIG_HOME: '/custom/cfg' }, home) === path.join('/custom/cfg', 'autostart'),
      autostart.autostartDir({ XDG_CONFIG_HOME: '/custom/cfg' }, home));
    check('an empty XDG_CONFIG_HOME falls back rather than writing to /autostart',
      autostart.autostartDir({ XDG_CONFIG_HOME: '   ' }, home) === path.join(home, '.config', 'autostart'));
  }

  {
    // The directory may not exist on a fresh install.
    const base = scratch();
    const dir = path.join(base, 'config', 'autostart');
    const result = autostart.set(true, { platform: 'linux', dir, packaged: true, execPath: '/x' });
    check('a missing autostart directory is created', existsSync(result.path));
  }

  // --- Windows and macOS delegate to Electron -------------------------------

  {
    const app = fakeApp();
    const dir = scratch();

    const win = autostart.set(true, { app, platform: 'win32', dir });
    check('Windows uses Electron’s login-item API', win.applied === 'registry');
    check('and asks it to open at login', app.calls[0]?.openAtLogin === true, JSON.stringify(app.calls));
    check('writing no stray file on Windows',
      !existsSync(autostart.desktopFilePath({ dir })), 'a desktop entry was written on Windows');

    const mac = autostart.set(false, { app, platform: 'darwin', dir });
    check('macOS uses it too', mac.applied === 'login-item');
    check('and turning it off is passed through', app.calls[1]?.openAtLogin === false);

    check('the reported state comes from the OS, not from what we asked for',
      autostart.isEnabled({ app, platform: 'win32' }) === false);
  }

  {
    // Nothing should explode if there is no Electron app object at all,
    // which is the case for the headless server.
    let threw = false;
    try {
      autostart.set(true, { app: null, platform: 'win32' });
      autostart.isEnabled({ app: null, platform: 'darwin' });
    } catch { threw = true; }
    check('no Electron app object is survivable', !threw);
  }
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error -> ${err.stack || err.message}`);
} finally {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
