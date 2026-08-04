'use strict';

/**
 * Role-aware account management, used by the API the desktop app's Accounts
 * screen calls. `config.setUser()` in lib/config.js is a separate, lower-level
 * recovery primitive used by `npm run setup` — see the comment there for why
 * the two are kept apart.
 *
 * Every function here mutates the config object it is given **in place** and
 * then persists it. That is deliberate: server.js holds one shared config
 * object for the life of the process, and auth middleware closes over that
 * same reference. Replacing it wholesale (`config = {...}`) would silently
 * detach the middleware from future changes; every mutation here goes through
 * `config.users` in place instead, so a role change or a disable takes effect
 * on the very next request.
 */

const configLib = require('./config');
const { normalizeRootPath } = require('./paths');

const ROLE_LEVEL = { viewer: 0, contributor: 1, manager: 2, admin: 3 };

class AccountError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function findIndex(config, username) {
  return config.users.findIndex((u) => u.username.toLowerCase() === String(username || '').toLowerCase());
}

/** Never hand password material to a caller outside this module. */
function sanitize(user) {
  const { salt, hash, ...safe } = user;
  return safe;
}

function list(config) {
  return config.users.map(sanitize);
}

function get(config, username) {
  const idx = findIndex(config, username);
  return idx >= 0 ? sanitize(config.users[idx]) : null;
}

function enabledAdminCount(config) {
  return config.users.filter((u) => u.role === 'admin' && !u.disabled).length;
}

function validateRole(role) {
  if (!configLib.ROLES.includes(role)) {
    throw new AccountError(`Role must be one of: ${configLib.ROLES.join(', ')}`);
  }
}

/**
 * Roots restrict an account to specific top-level albums (or nested paths).
 * `["/"]` — the default — means unrestricted. Anything else must be a clean
 * absolute-from-library path; validation deliberately does not check the
 * album exists, since it is reasonable to grant access to a folder that will
 * be created later.
 *
 * Returns the *normalized* roots rather than just validating the input —
 * every root must be stored in exactly the shape resolveSafe() would return
 * for that folder, or isWithinRoots()'s comparison silently breaks (see
 * lib/paths.js normalizeRootPath for the failure this prevents). A root
 * typed with a trailing slash is a completely ordinary thing for someone to
 * type, not a hostile input, so this normalizes it rather than rejecting it.
 */
function normalizeRoots(roots) {
  if (!Array.isArray(roots) || !roots.length) {
    throw new AccountError('roots must be a non-empty array of paths');
  }
  const cleaned = roots.map((root) => {
    const normalized = typeof root === 'string' ? normalizeRootPath(root) : null;
    if (!normalized) throw new AccountError(`Invalid root path: ${root}`);
    return normalized;
  });
  // Two differently-typed roots ("Family" and "Family/") normalize to the
  // same string; a duplicate is harmless for access control but would
  // otherwise show the same album twice in a restricted account's synthetic
  // root listing.
  return [...new Set(cleaned)];
}

function create(config, { username, password, role = 'viewer', roots = ['/'] }) {
  const name = String(username || '').trim();
  if (!name || name.length > 64) throw new AccountError('Username is required');
  if (!/^[\w.-]+$/.test(name)) {
    throw new AccountError('Username may only contain letters, numbers, dot, dash and underscore');
  }
  if (findIndex(config, name) >= 0) throw new AccountError('That username is already taken', 409);
  if (!password || password.length < 4) throw new AccountError('Password must be at least 4 characters');
  validateRole(role);
  const cleanRoots = normalizeRoots(roots);

  const record = configLib.normalizeUser({
    username: name,
    ...configLib.hashPassword(password),
    role,
    roots: cleanRoots,
    disabled: false,
  });
  config.users.push(record);
  configLib.save(config);
  return sanitize(record);
}

/**
 * Patch role, roots, disabled state and/or password. Refuses any change that
 * would leave zero enabled admin accounts — that is the one mistake this
 * server cannot let you make, because there would be no account left with
 * permission to undo it.
 */
function update(config, username, patch = {}) {
  const idx = findIndex(config, username);
  if (idx < 0) throw new AccountError('No such account', 404);
  const current = config.users[idx];

  const next = { ...current };
  if (patch.role !== undefined) { validateRole(patch.role); next.role = patch.role; }
  if (patch.roots !== undefined) next.roots = normalizeRoots(patch.roots);
  if (patch.disabled !== undefined) next.disabled = Boolean(patch.disabled);
  if (patch.password) {
    if (patch.password.length < 4) throw new AccountError('Password must be at least 4 characters');
    Object.assign(next, configLib.hashPassword(patch.password));
  }

  const wasEnabledAdmin = current.role === 'admin' && !current.disabled;
  const staysEnabledAdmin = next.role === 'admin' && !next.disabled;
  if (wasEnabledAdmin && !staysEnabledAdmin && enabledAdminCount(config) <= 1) {
    throw new AccountError('Cannot change the last admin account — add another admin first', 409);
  }

  config.users[idx] = next;
  configLib.save(config);
  return sanitize(next);
}

function remove(config, username) {
  const idx = findIndex(config, username);
  if (idx < 0) throw new AccountError('No such account', 404);
  const current = config.users[idx];

  if (current.role === 'admin' && !current.disabled && enabledAdminCount(config) <= 1) {
    throw new AccountError('Cannot delete the last admin account — add another admin first', 409);
  }

  config.users.splice(idx, 1);
  configLib.save(config);
}

module.exports = {
  AccountError,
  ROLE_LEVEL,
  list,
  get,
  create,
  update,
  remove,
  enabledAdminCount,
};
