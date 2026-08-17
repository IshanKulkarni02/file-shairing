'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Where writable data lives.
 *
 * Under `node server.js` that is the project folder. Inside a packaged
 * executable __dirname points into the read-only snapshot, so everything the
 * app writes has to go beside the .exe instead — which also makes the build
 * portable: drop LANShare.exe in a folder and its library sits next to it.
 *
 * LANSHARE_HOME overrides both, so tests (and later the desktop app, which
 * may run several independent instances) can point at an isolated directory
 * instead of touching the real installation.
 */
const ROOT_DIR = process.env.LANSHARE_HOME
  ? path.resolve(process.env.LANSHARE_HOME)
  : process.pkg
    ? path.dirname(process.execPath)
    : path.join(__dirname, '..');

const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');

// Server-level state (sessions, account list) that has nothing to do with
// where the media library happens to live — the library can move to another
// drive entirely and this must stay put and stay reachable.
const SERVER_STATE_DIR = path.join(ROOT_DIR, '.lanshare-server');

const DEFAULTS = {
  // Not 8080: AirPlay receivers and dev servers commonly hold that port.
  port: 8420,
  httpsPort: 8443,
  // Where the media lives. Change this to any folder, e.g. "D:\\Photos".
  library: path.join(ROOT_DIR, 'library'),
  // Session lifetime in days.
  sessionDays: 30,
  users: [],
  // Desktop-app-only settings; harmless and unused by the headless CLI/exe.
  closeToTray: true,
  startOnLogin: false,
};

const ROLES = ['viewer', 'contributor', 'manager', 'admin'];

function serverStateDir() {
  fs.mkdirSync(SERVER_STATE_DIR, { recursive: true });
  return SERVER_STATE_DIR;
}

function randomPassword(len = 10) {
  // Ambiguous characters removed so it can be typed on a phone without squinting.
  const alphabet = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expected) {
  const actual = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Fill in fields a pre-accounts config.json would not have.
 *
 * A user record from before roles existed defaults to full admin — anything
 * else would lock the person who has been running this server all along out
 * of their own library the moment they upgrade.
 */
function normalizeUser(user) {
  const changed = {};
  if (!ROLES.includes(user.role)) changed.role = 'admin';
  if (!Array.isArray(user.roots) || !user.roots.length) changed.roots = ['/'];
  if (typeof user.disabled !== 'boolean') changed.disabled = false;
  if (!user.created) changed.created = new Date().toISOString();
  return Object.keys(changed).length ? { ...user, ...changed } : user;
}

/** Returns [normalizedConfig, wasChanged]. */
function normalizeConfig(raw) {
  let changed = false;
  const users = raw.users.map((u) => {
    const next = normalizeUser(u);
    if (next !== u) changed = true;
    return next;
  });
  return [changed ? { ...raw, users } : raw, changed];
}

/**
 * Written to a temp file and renamed into place, never straight over the
 * live file — the same discipline lib/sessions.js already applies to its own
 * store, and for a much more serious reason here. config.json is rewritten
 * on every account change and holds the only copy of the signing secret and
 * every password hash; a process killed mid-write (a forced Windows update
 * reboot is the realistic one) would otherwise leave a truncated file that
 * locks everyone out of the library permanently. rename() is atomic on both
 * Windows and POSIX, so a reader sees either the whole old file or the
 * whole new one.
 */
function save(config) {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
}

/**
 * A corrupt config.json is reported as exactly that, rather than thrown as a
 * bare SyntaxError from whichever module happened to load first. Both entry
 * points (server.js and desktop/main.js) call loadOrCreate() at module scope
 * before any error handling is in place, so without this the whole app dies
 * with an unexplained parse stack trace and no hint about which file is bad
 * or what to do about it.
 *
 * Deliberately *not* silently recovered the way lib/sessions.js recovers
 * from its own corrupt file: losing session records signs devices out
 * harmlessly, but silently starting from DEFAULTS here would generate a new
 * signing secret and no user accounts — a first-run setup on top of a
 * library someone still has, quietly discarding every account instead of
 * telling them their config needs restoring.
 */
function load() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    throw new Error(
      `${CONFIG_PATH} is not valid JSON and cannot be read (${err.message}). `
      + 'Restore it from a backup, or delete it to start fresh — deleting it '
      + 'discards every account and the signing secret, but leaves your library untouched.',
    );
  }
  const merged = { ...DEFAULTS, ...parsed };
  const [normalized, changed] = normalizeConfig(merged);
  // Upgrade the file on disk once, rather than re-normalizing on every load
  // for the life of the process.
  if (changed) save(normalized);
  return normalized;
}

/**
 * Load config, creating it on first run with a random admin password.
 * Returns { config, generated } where `generated` is the plaintext password
 * if one was just created (so the caller can print it once).
 */
function loadOrCreate() {
  const existing = load();
  if (existing && existing.users.length) return { config: existing, generated: null };

  const password = randomPassword();
  const config = {
    ...DEFAULTS,
    ...(existing || {}),
    secret: crypto.randomBytes(32).toString('hex'),
    users: [normalizeUser({ username: 'admin', ...hashPassword(password) })],
  };
  save(config);
  return { config, generated: password };
}

/**
 * Create-or-replace a user by username. This is the low-level primitive
 * behind `npm run setup` — a recovery tool for whoever already has file
 * access to the machine, so it always grants full admin. Day-to-day account
 * management with a specific role and album restrictions goes through
 * lib/accounts.js instead, which is what the desktop app's Accounts screen
 * calls.
 */
function setUser(username, password, opts = {}) {
  const config = load() || { ...DEFAULTS, secret: crypto.randomBytes(32).toString('hex'), users: [] };
  if (!config.secret) config.secret = crypto.randomBytes(32).toString('hex');
  const existing = config.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  const creds = normalizeUser({
    role: 'admin',
    roots: ['/'],
    disabled: false,
    ...existing,
    ...opts,
    username,
    ...hashPassword(password),
  });
  const idx = config.users.findIndex((u) => u.username.toLowerCase() === username.toLowerCase());
  if (idx >= 0) config.users[idx] = creds;
  else config.users.push(creds);
  save(config);
  return config;
}

module.exports = {
  CONFIG_PATH,
  ROOT_DIR,
  ROLES,
  serverStateDir,
  load,
  loadOrCreate,
  save,
  setUser,
  normalizeUser,
  hashPassword,
  verifyPassword,
  randomPassword,
};
