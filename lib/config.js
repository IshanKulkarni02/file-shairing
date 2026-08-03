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
 */
const ROOT_DIR = process.pkg
  ? path.dirname(process.execPath)
  : path.join(__dirname, '..');

const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');

const DEFAULTS = {
  // Not 8080: AirPlay receivers and dev servers commonly hold that port.
  port: 8420,
  httpsPort: 8443,
  // Where the media lives. Change this to any folder, e.g. "D:\\Photos".
  library: path.join(ROOT_DIR, 'library'),
  // Session lifetime in days.
  sessionDays: 30,
  users: [],
};

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

function save(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function load() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
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
    users: [{ username: 'admin', ...hashPassword(password) }],
  };
  save(config);
  return { config, generated: password };
}

function setUser(username, password) {
  const config = load() || { ...DEFAULTS, secret: crypto.randomBytes(32).toString('hex') };
  if (!config.secret) config.secret = crypto.randomBytes(32).toString('hex');
  const creds = { username, ...hashPassword(password) };
  const idx = config.users.findIndex((u) => u.username.toLowerCase() === username.toLowerCase());
  if (idx >= 0) config.users[idx] = creds;
  else config.users.push(creds);
  save(config);
  return config;
}

module.exports = {
  CONFIG_PATH,
  ROOT_DIR,
  load,
  loadOrCreate,
  save,
  setUser,
  hashPassword,
  verifyPassword,
  randomPassword,
};
