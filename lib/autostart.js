'use strict';

/**
 * Starting LANShare when you log in.
 *
 * Electron's `app.setLoginItemSettings()` handles Windows and macOS. **It does
 * nothing at all on Linux** — the docs say as much, and the failure is silent:
 * the checkbox ticks, the setting saves, and nothing ever starts. So Linux is
 * handled here by writing the XDG autostart entry that desktop environments
 * actually read.
 *
 * The Electron object is passed in rather than required, so this module can be
 * tested without an Electron runtime and so the Linux path can be exercised
 * from any machine.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DESKTOP_FILE = 'lanshare.desktop';

/** Where XDG says autostart entries live. */
function autostartDir(env = process.env, home = os.homedir()) {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME
    : path.join(home, '.config');
  return path.join(base, 'autostart');
}

const desktopFilePath = (options = {}) =>
  path.join(options.dir || autostartDir(options.env, options.home), DESKTOP_FILE);

/**
 * The command that relaunches this app.
 *
 * A packaged AppImage is a single executable and `process.execPath` is it. Run
 * from source, execPath is the electron binary and the app directory has to be
 * passed as an argument or it would launch a blank Electron.
 */
function launchCommand({ execPath, appPath, packaged }) {
  const quote = (value) => (/[\s"']/.test(value) ? `"${value}"` : value);
  if (packaged) return quote(execPath);
  return `${quote(execPath)} ${quote(appPath)}`;
}

function desktopEntry({ execPath, appPath, packaged, name = 'LANShare' }) {
  // Terminal=false and X-GNOME-Autostart-enabled=true are both load-bearing:
  // without the first, some environments open a terminal window; without the
  // second, GNOME shows the entry as disabled.
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${name}`,
    'Comment=Share your photo and video library on your network',
    `Exec=${launchCommand({ execPath, appPath, packaged })}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'NoDisplay=false',
    '',
  ].join('\n');
}

/**
 * Turn autostart on or off.
 *
 * @param {boolean} enabled
 * @param {object} deps
 * @param {object} [deps.app]        Electron's app, on Windows and macOS
 * @param {string} deps.execPath
 * @param {string} deps.appPath
 * @param {boolean} deps.packaged
 * @param {string} [deps.platform]
 * @param {string} [deps.dir]        overrides the autostart folder, for tests
 * @returns {{applied: string, path?: string}}
 */
function set(enabled, {
  app = null,
  execPath = process.execPath,
  appPath = process.cwd(),
  packaged = false,
  platform = process.platform,
  dir = null,
  env = process.env,
  home = os.homedir(),
} = {}) {
  if (platform !== 'linux') {
    // Windows writes a registry Run entry, macOS a login item. Electron does
    // both correctly, and reimplementing either would be worse.
    app?.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
    return { applied: platform === 'darwin' ? 'login-item' : 'registry' };
  }

  const file = desktopFilePath({ dir, env, home });
  if (!enabled) {
    fs.rmSync(file, { force: true });
    return { applied: 'desktop-entry', path: file };
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, desktopEntry({ execPath, appPath, packaged }), { mode: 0o644 });
  return { applied: 'desktop-entry', path: file };
}

/**
 * Whether autostart is actually on, asked of the OS rather than of config.
 *
 * Worth asking separately: someone can remove the entry outside the app, and
 * a checkbox that disagrees with reality is worse than no checkbox.
 */
function isEnabled({
  app = null,
  platform = process.platform,
  dir = null,
  env = process.env,
  home = os.homedir(),
} = {}) {
  if (platform !== 'linux') {
    return Boolean(app?.getLoginItemSettings?.().openAtLogin);
  }
  return fs.existsSync(desktopFilePath({ dir, env, home }));
}

module.exports = {
  set,
  isEnabled,
  autostartDir,
  desktopFilePath,
  desktopEntry,
  launchCommand,
  DESKTOP_FILE,
};
