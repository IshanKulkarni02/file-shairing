'use strict';

/**
 * Two independent checks sit in front of every route: can this account's
 * *role* do this kind of thing at all (requireRole), and is the *path* it is
 * asking about inside this account's roots (resolveForUser). Neither implies
 * the other — a manager can delete, but only inside their own roots.
 */

const P = require('./paths');
const { ROLE_LEVEL } = require('./accounts');

/** True for an unrestricted account or a path inside one of its roots. */
function isWithinRoots(account, relPath) {
  const roots = account.roots || ['/'];
  if (roots.includes('/')) return true;
  return roots.some((root) => relPath === root || relPath.startsWith(root.endsWith('/') ? root : `${root}/`));
}

/**
 * Like paths.resolveSafe, but additionally rejects anything outside the
 * account's roots. This is the one function every route must use instead of
 * calling resolveSafe directly — using resolveSafe alone would enforce
 * traversal safety but not the account's album restriction.
 */
function resolveForUser(library, account, relPath) {
  const target = P.resolveSafe(library, relPath);
  if (!target) return null;
  if (!isWithinRoots(account, target.rel)) return null;
  return target;
}

/** Express middleware: 403s unless the account's role is at least `minRole`. */
function requireRole(minRole) {
  const required = ROLE_LEVEL[minRole];
  return (req, res, next) => {
    const level = ROLE_LEVEL[req.account?.role];
    if (level === undefined || level < required) {
      return res.status(403).json({ error: 'Your account is not allowed to do that' });
    }
    return next();
  };
}

module.exports = { isWithinRoots, resolveForUser, requireRole };
