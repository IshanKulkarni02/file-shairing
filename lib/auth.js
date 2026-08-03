'use strict';

const crypto = require('crypto');
const { verifyPassword } = require('./config');

const COOKIE = 'lanshare_sid';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** Stateless signed token, so sessions survive a server restart. */
function signToken(secret, username, days) {
  const payload = b64url(JSON.stringify({ u: username, exp: Date.now() + days * 86400e3 }));
  const sig = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
}

function verifyToken(secret, token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1), 'base64url');
  const want = crypto.createHmac('sha256', secret).update(payload).digest();
  if (sig.length !== want.length || !crypto.timingSafeEqual(sig, want)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

/** Throttle password guessing: 10 tries per IP per 15 minutes. */
const attempts = new Map();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60e3;

function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function recordFailure(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > WINDOW_MS) attempts.set(ip, { count: 1, first: Date.now() });
  else rec.count++;
}

function clearAttempts(ip) {
  attempts.delete(ip);
}

function checkLogin(config, username, password) {
  const user = config.users.find((u) => u.username.toLowerCase() === String(username || '').toLowerCase());
  // Always run a hash so a wrong username costs the same time as a wrong password.
  const salt = user ? user.salt : '0'.repeat(32);
  const hash = user ? user.hash : '0'.repeat(128);
  const ok = verifyPassword(String(password || ''), salt, hash);
  return ok && user ? user.username : null;
}

/** Express middleware factory. Rejects anything without a valid session cookie. */
function requireAuth(config) {
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const session = verifyToken(config.secret, token);
    if (!session) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
      return res.redirect('/login');
    }
    req.user = session.u;
    next();
  };
}

module.exports = {
  COOKIE,
  parseCookies,
  signToken,
  verifyToken,
  checkLogin,
  requireAuth,
  tooManyAttempts,
  recordFailure,
  clearAttempts,
};
