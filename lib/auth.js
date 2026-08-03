'use strict';

const crypto = require('crypto');
const { verifyPassword } = require('./config');
const sessions = require('./sessions');

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

/**
 * Signed token carrying a username, expiry, and a session id.
 *
 * The signature alone proves the token was issued by this server and has not
 * expired — it does not prove the session is still wanted. That is what the
 * session id is for: it looks up a record in lib/sessions.js on every
 * request, and deleting that record is what makes "sign out this device" or
 * "disable this account" take effect immediately instead of up to
 * `sessionDays` later.
 */
function signToken(secret, username, days, sessionId) {
  const payload = b64url(JSON.stringify({ u: username, sid: sessionId, exp: Date.now() + days * 86400e3 }));
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

/**
 * Verify a username/password. Returns the matching user record (including
 * role and roots, but not the password hash) or null.
 *
 * Disabled accounts are rejected here too, but that is not the check that
 * matters for an account disabled *after* sign-in — requireAuth below
 * re-checks on every request, since this function only ever runs once, at
 * login.
 */
function checkLogin(config, username, password) {
  const user = config.users.find((u) => u.username.toLowerCase() === String(username || '').toLowerCase());
  // Always run a hash so a wrong username costs the same time as a wrong password.
  const salt = user ? user.salt : '0'.repeat(32);
  const hash = user ? user.hash : '0'.repeat(128);
  const ok = verifyPassword(String(password || ''), salt, hash);
  if (!ok || !user || user.disabled) return null;
  const { salt: _s, hash: _h, ...safe } = user;
  return safe;
}

/**
 * Express middleware factory. Rejects anything without a valid session
 * cookie, a live session record, and an enabled account — checked fresh on
 * every request, because `config` is the one shared, mutable object the rest
 * of the server also edits in place (see lib/accounts.js), so a role change
 * or a disable is visible here on the very next request.
 */
function requireAuth(config) {
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const claims = verifyToken(config.secret, token);
    const session = claims && sessions.find(claims.sid);
    const account = session && config.users.find(
      (u) => u.username.toLowerCase() === claims.u.toLowerCase(),
    );

    if (!claims || !session || !account || account.disabled) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
      return res.redirect('/login');
    }

    sessions.touch(session.id);
    req.user = account.username;
    req.sessionId = session.id;
    const { salt: _s, hash: _h, ...safe } = account;
    req.account = safe;
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
