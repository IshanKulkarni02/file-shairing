'use strict';

/**
 * Builds an Express app and its listeners from a config object.
 *
 * Split out of server.js so something other than a bare CLI process can own
 * the server's lifecycle — the desktop app (Phase A) starts, stops and
 * restarts it in-process as settings change, rather than shelling out.
 *
 * `require('./runtime').init()` must still run before this module is loaded
 * anywhere sharp might be pulled in from — that stays the entry point's job
 * (server.js), not this module's, since it is about the packaged-executable
 * bootstrap rather than app construction.
 */

const express = require('express');
const busboy = require('busboy');
const archiver = require('archiver');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const auth = require('./auth');
const os = require('os');
const configLib = require('./config');
const P = require('./paths');
const thumbs = require('./thumbs');
const ffmpeg = require('./ffmpeg');
const tls = require('./tls');
const permissions = require('./permissions');
const accounts = require('./accounts');
const sessions = require('./sessions');
const vaults = require('./vaults');
const locations = require('./locations');
const syncTargets = require('./sync-targets');
const syncEngine = require('./sync');
const syncWatcher = require('./sync-watcher');
const discovery = require('./discovery');
const remote = require('./remote');
const vaultfile = require('./crypto/vaultfile');
const { IndexDb } = require('./index-db');
const indexer = require('./indexer');

// 4 MB reads keep a gigabit link busy without holding much memory per client.
const READ_CHUNK = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Helpers with no need for a config or a library path
// ---------------------------------------------------------------------------

async function statOrNull(absPath) {
  try {
    return await fsp.stat(absPath);
  } catch {
    return null;
  }
}

function isSafari(req) {
  const ua = req.headers['user-agent'] || '';
  // Chrome and Edge both include "Safari" in their UA, so exclude them.
  return /Safari/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
}

/**
 * Parse a Range header against a known total size.
 *
 * Returns {start, end} for a satisfiable range, null when there was no Range
 * header at all, or the string 'unsatisfiable'. Shared by plaintext and
 * encrypted delivery: an encrypted file's ranges are expressed in *plaintext*
 * offsets, which is exactly the same arithmetic over a different total, so
 * both paths get the same well-tested parsing rather than a second copy of
 * it that could drift.
 */
function parseRange(rangeHeader, totalSize) {
  if (!rangeHeader) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return 'unsatisfiable';

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return 'unsatisfiable';

  let start = 0;
  let end = totalSize - 1;
  if (rawStart === '') {
    // "bytes=-500" means the last 500 bytes.
    start = Math.max(0, totalSize - Number(rawEnd));
  } else {
    start = Number(rawStart);
    if (rawEnd !== '') end = Math.min(Number(rawEnd), totalSize - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= totalSize) {
    return 'unsatisfiable';
  }
  return { start, end };
}

function setMediaHeaders(res, absPath, stat, { download, type }) {
  const encoded = encodeURIComponent(path.basename(absPath));
  res.setHeader('Content-Type', type || P.mimeOf(absPath));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  res.setHeader('Cache-Control', 'private, max-age=31536000');
  res.setHeader(
    'Content-Disposition',
    `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encoded}`,
  );
}

/**
 * Stream a file with byte-range support.
 * iOS Safari will not play a video at all unless ranges return 206.
 */
async function sendFileStream(req, res, absPath, stat, { download = false, type } = {}) {
  setMediaHeaders(res, absPath, stat, { download, type });

  // An empty file has no last byte, so the usual size - 1 is -1 and
  // createReadStream throws a RangeError — uncaught, inside a request handler,
  // which takes the whole server down for everyone. Zero-byte files are
  // ordinary: a transfer that failed, a card that misbehaved, a placeholder.
  // Checked before ranges, since there is no range of an empty file to serve.
  if (stat.size === 0) {
    res.setHeader('Content-Length', 0);
    return res.end();
  }

  const parsed = parseRange(req.headers.range, stat.size);
  if (parsed === 'unsatisfiable') {
    res.setHeader('Content-Range', `bytes */${stat.size}`);
    return res.status(416).end();
  }

  const { start, end } = parsed || { start: 0, end: stat.size - 1 };
  if (parsed) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  }

  res.setHeader('Content-Length', end - start + 1);
  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(absPath, { start, end, highWaterMark: READ_CHUNK });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  return stream.pipe(res);
}

/**
 * The same, for a file stored inside a vault.
 *
 * Every offset the client sees is a plaintext offset — it has no idea the
 * file is encrypted, so range requests, video scrubbing and resumed
 * downloads all behave exactly as they do for an ordinary file. Only the
 * chunks a range actually touches get decrypted.
 */
async function sendEncryptedFileStream(req, res, absPath, stat, fileKey, meta, { download = false, type } = {}) {
  setMediaHeaders(res, absPath, stat, { download, type });

  const total = meta.plaintextSize;
  const parsed = parseRange(req.headers.range, total);
  if (parsed === 'unsatisfiable') {
    res.setHeader('Content-Range', `bytes */${total}`);
    return res.status(416).end();
  }

  const { start, end } = parsed || { start: 0, end: Math.max(0, total - 1) };
  if (parsed) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  }

  res.setHeader('Content-Length', total === 0 ? 0 : end - start + 1);
  if (req.method === 'HEAD') return res.end();

  const stream = vaultfile.createDecryptStream(absPath, fileKey, meta, { start, end });
  // A failure here means the file failed authentication — tampered with, or
  // the wrong key. Headers are already sent, so the only honest signal left
  // is to break the connection rather than serve plausible-looking bytes.
  stream.on('error', (err) => {
    console.warn(`[vault] ${path.basename(absPath)}: ${err.message}`);
    res.destroy();
  });
  res.on('close', () => stream.destroy());
  return stream.pipe(res);
}

// ---------------------------------------------------------------------------
// App construction
// ---------------------------------------------------------------------------

function createApp(config) {
  const LIBRARY = path.resolve(config.library);
  const PUBLIC_DIR = path.join(__dirname, '..', 'public');

  // Syncs in flight, by target id. Two runs over the same pair of folders
  // would each be deciding from a snapshot the other is busy invalidating,
  // which is how a sync deletes something it should not.
  const runningSyncs = new Map();

  fs.mkdirSync(LIBRARY, { recursive: true });
  fs.mkdirSync(path.join(LIBRARY, P.INTERNAL_DIR), { recursive: true });

  // An album living on an external drive is a junction holding an absolute
  // path, so a disk that comes back as F: instead of E: leaves it dangling.
  // Repointing has to happen before the first request, or the first thing
  // anyone sees is an album that appears to have emptied itself.
  try {
    const repair = locations.repairLinks(LIBRARY, config);
    for (const item of repair.repaired) {
      console.log(`[locations] repointed "${item.name}" to ${item.to}`);
    }
    for (const item of repair.broken) {
      console.warn(`[locations] "${item.name}" is unreachable — ${item.location || 'its drive'} is not connected`);
    }
  } catch (err) {
    // Never fatal: a library with no relocated albums must still start.
    console.warn(`[locations] link check skipped: ${err.message}`);
  }

  // The search index. Opened here rather than lazily on first search, so a
  // locked or corrupt database file is discovered at startup — the same
  // moment link repair failures are — rather than on someone's first query.
  const indexDb = new IndexDb(path.join(LIBRARY, P.INTERNAL_DIR, 'index.db'));

  // Tracks a scan in flight, so a request to rebuild while one is already
  // running joins it rather than starting a second walk over the same
  // library at the same time — the identical race the sync engine already
  // guards against for the same reason: two writers deciding from a
  // snapshot the other is busy invalidating.
  let indexScan = null;
  let lastIndexReport = null;
  function runIndexScan() {
    if (!indexScan) {
      indexScan = indexer.scanLibrary(LIBRARY, indexDb)
        .then((report) => { lastIndexReport = { ...report, finishedAt: new Date().toISOString() }; return report; })
        .catch((err) => {
          lastIndexReport = { error: err.message, finishedAt: new Date().toISOString() };
          console.warn(`[index] scan failed: ${err.message}`);
        })
        .finally(() => { indexScan = null; });
    }
    return indexScan;
  }
  // Kicked off in the background at startup rather than awaited: search
  // should not hold up the server coming up, and an empty index answers "no
  // results" honestly until the first scan finishes, rather than the server
  // refusing to start over a library with ten thousand photos in it.
  runIndexScan();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(express.json({ limit: '1mb' }));

  /** Resolve a request's ?path= into a real, in-scope path, or send 400. */
  function resolveOr400(req, res, value) {
    const target = permissions.resolveForUser(LIBRARY, req.account, value);
    if (!target) {
      res.status(400).json({ error: 'Invalid path' });
      return null;
    }
    return target;
  }

  /**
   * Everything a media route needs in order to serve one file, whether or
   * not it lives in a vault.
   *
   * Returns null after already sending a response — the caller just returns.
   * For a plain file, `vault` is null and the caller behaves exactly as
   * before. For a vault file it carries the per-file key and the decrypted
   * metadata, so callers never touch key material directly.
   */
  async function openForRead(req, res, rawPath) {
    const target = resolveOr400(req, res, rawPath);
    if (!target) return null;

    const stat = await statOrNull(target.abs);
    if (!stat || stat.isDirectory()) {
      res.status(404).json({ error: 'Not found' });
      return null;
    }

    const ctx = vaults.contextFor(LIBRARY, target.rel);
    if (!ctx) return { target, stat, vault: null };

    // An end-to-end vault's contents are ciphertext to this server by
    // definition — it has no key and never will. That has to be checked
    // *before* the locked gate: `unlocked` is always false for these, since
    // there is no server-side key to hold, and gating on it would make the
    // files permanently unreachable. The bytes are handed over as stored and
    // the browser decrypts them; routes needing plaintext (thumbnails,
    // transcoding, previews) decline further down rather than failing deep
    // inside a decrypt.
    if (ctx.type === 'e2e') {
      return { target, stat, vault: ctx, e2e: true };
    }

    if (!ctx.unlocked) {
      res.status(423).json({ error: 'This album is locked', locked: true, vault: ctx.albumRel });
      return null;
    }

    try {
      // The header needs no key and carries the file key, wrapped under the
      // vault master key. Unwrap that, then read the full metadata — which
      // does need the file key, since it authenticates the trailer.
      const { header } = await vaultfile.readHeader(target.abs);
      const fileKey = vaults.fileKeyFrom(ctx.masterKey, header.wrappedKey);
      const meta = await vaultfile.readMetadata(target.abs, fileKey);
      return { target, stat, vault: ctx, fileKey, meta };
    } catch (err) {
      res.status(500).json({ error: `Could not open this encrypted file: ${err.message}` });
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  /**
   * "Is there a LANShare here, and which one?" — deliberately unauthenticated,
   * because a client has to identify a host before it can decide whether to
   * send a password to it.
   *
   * It says only what someone who can already reach the port could work out
   * anyway. No library contents, no account names, no paths.
   */
  app.get('/api/ping', (req, res) => {
    res.json({
      app: 'lanshare',
      version: require('../package.json').version,
      name: config.hostName || os.hostname(),
    });
  });

  /**
   * Where a request really came from.
   *
   * Everything arriving through the relay is replayed against this server
   * over loopback, so it all looks like 127.0.0.1. Left alone that would put
   * every visitor from the internet in the same login-throttle bucket as
   * someone sitting at the keyboard — so a remote guesser could lock the
   * owner out of their own machine — and would show every remote session on
   * the Devices screen as local, which is precisely the screen you would
   * check if you were worried about one.
   *
   * The marker is only trusted from loopback. Anyone who can send a request
   * from there is already on the machine.
   */
  function describeSource(req) {
    const address = req.socket.remoteAddress || 'unknown';
    const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
    if (loopback && req.headers['x-lanshare-via'] === 'relay') return 'over the internet';
    return address;
  }

  app.post('/api/login', (req, res) => {
    const ip = describeSource(req);
    if (auth.tooManyAttempts(ip)) {
      return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes and try again.' });
    }

    const account = auth.checkLogin(config, req.body?.username, req.body?.password);
    if (!account) {
      auth.recordFailure(ip);
      return res.status(401).json({ error: 'Wrong username or password' });
    }

    auth.clearAttempts(ip);
    const session = sessions.create({
      username: account.username,
      ip,
      userAgent: req.headers['user-agent'],
      days: config.sessionDays,
    });
    const token = auth.signToken(config.secret, account.username, config.sessionDays, session.id);
    res.cookie(auth.COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: config.sessionDays * 86400e3,
      path: '/',
    });
    res.json({ ok: true, username: account.username, role: account.role });
    return undefined;
  });

  app.post('/api/logout', (req, res) => {
    // This route sits ahead of requireAuth (a client must be able to clear a
    // stale cookie without one), so the session id is not on req yet — pull
    // it from the cookie directly and actually revoke the record, rather than
    // only dropping the client-side cookie.
    const token = auth.parseCookies(req.headers.cookie)[auth.COOKIE];
    const claims = auth.verifyToken(config.secret, token);
    if (claims?.sid) sessions.revoke(claims.sid);
    res.clearCookie(auth.COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // The certificate is public material and must be reachable before a device
  // trusts us, so it deliberately sits outside the auth wall.
  app.get('/cert', (req, res) => {
    const certPath = path.join(LIBRARY, P.INTERNAL_DIR, 'tls', 'cert.pem');
    if (!fs.existsSync(certPath)) return res.status(404).send('HTTPS is not enabled.');
    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
    res.setHeader('Content-Disposition', 'attachment; filename="lanshare.crt"');
    fs.createReadStream(certPath).pipe(res);
    return undefined;
  });

  app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));

  // Static assets carry no secrets and the login page needs them.
  // maxAge 0 means the browser revalidates and usually gets a 304, which costs
  // nothing on a LAN and stops devices running last week's JavaScript after an
  // update. Offline caching is the service worker's job, not this header's.
  app.use('/assets', express.static(PUBLIC_DIR, { maxAge: 0, etag: true, index: false }));
  app.get('/manifest.webmanifest', (req, res) =>
    res.sendFile(path.join(PUBLIC_DIR, 'manifest.webmanifest')));
  app.get('/sw.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, 'sw.js'));
  });

  app.use(auth.requireAuth(config));
  // Everything below this line requires a valid session, a live session
  // record, and an account that is not disabled.

  app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  app.get('/api/me', (req, res) => {
    const isAdmin = req.account.role === 'admin';
    res.json({
      username: req.account.username,
      role: req.account.role,
      roots: req.account.roots,
      // The on-disk library path is local machine detail; only an admin
      // account needs it, and it is not this server's business to hand a
      // restricted account a path it cannot even see.
      ...(isAdmin ? { library: LIBRARY } : {}),
    });
  });

  // ---------------------------------------------------------------------------
  // Browsing
  // ---------------------------------------------------------------------------

  app.get('/api/list', async (req, res) => {
    const roots = req.account.roots || ['/'];
    const restricted = !roots.includes('/');

    // A restricted account's "root" is virtual — "/" is not actually inside
    // any single one of its roots, so the normal in-scope check must not run
    // against it. Resolve loosely first (safe path, no scoping) just to find
    // out whether the request even means the library root.
    const requested = P.resolveSafe(LIBRARY, req.query.path);
    if (!requested) return res.status(400).json({ error: 'Invalid path' });

    if (restricted && requested.rel === '/') {
      const folders = [];
      for (const root of roots) {
        const resolved = P.resolveSafe(LIBRARY, root);
        if (!resolved) continue;
        const stat = await statOrNull(resolved.abs);
        if (!stat || !stat.isDirectory()) continue;
        folders.push({
          name: path.posix.basename(resolved.rel) || resolved.rel,
          path: resolved.rel,
          isDir: true,
          mtime: stat.mtimeMs,
        });
      }
      return res.json({ path: '/', folders, files: [] });
    }

    // Anything other than the virtual root goes through the real scoping
    // check, same as every other route.
    const target = resolveOr400(req, res, req.query.path);
    if (!target) return undefined;

    // A locked vault shows nothing at all — not even the names of what is
    // inside it. The client renders a lock prompt from this response.
    //
    // End-to-end albums are the exception, and have to be: there is no
    // server-side key to unlock, so `unlocked` is permanently false and
    // gating on it would hide the album from its owner forever. The listing
    // is served and the *client* decides whether it holds the key. Nothing
    // is given away by doing so — filenames are not encrypted in either kind
    // of vault, and the contents remain ciphertext this server cannot read.
    const ctx = vaults.contextFor(LIBRARY, target.rel);
    if (ctx && ctx.type !== 'e2e' && !ctx.unlocked) {
      return res.json({
        path: target.rel,
        folders: [],
        files: [],
        vault: { path: ctx.albumRel, type: ctx.type, locked: true },
      });
    }

    let entries;
    try {
      entries = await fsp.readdir(target.abs, { withFileTypes: true });
    } catch (err) {
      const status = err.code === 'ENOENT' ? 404 : 500;
      return res.status(status).json({ error: 'Folder not found' });
    }

    const folders = [];
    const files = [];

    await Promise.all(entries.map(async (entry) => {
      if (entry.name === P.INTERNAL_DIR || entry.name.startsWith('.')) return;
      const abs = path.join(target.abs, entry.name);
      const stat = await statOrNull(abs);

      // Albums living on another drive, so an unplugged disk shows as exactly
      // that rather than as an album that mysteriously emptied.
      const stored = target.rel === '/' ? locations.describeAlbum(LIBRARY, config, entry.name) : null;

      // statOrNull follows the link, so a relocated album on a disconnected
      // drive lands here as null. Dropping it would hide the album — and the
      // reason it is missing — from the one screen meant to explain it.
      if (!stat && !stored?.linked) return;

      const relPath = path.posix.join(target.rel, entry.name);
      // Not entry.isDirectory(): a junction is a reparse point, so the dirent
      // reports a symlink and a relocated album would be listed as a file.
      if (stat ? stat.isDirectory() : true) {
        // Flag vault albums so the grid can badge them and show a lock.
        const childVault = stat ? vaults.readVaultMeta(abs) : null;
        folders.push({
          name: entry.name,
          path: relPath,
          isDir: true,
          mtime: stat ? stat.mtimeMs : 0,
          ...(childVault
            ? { vault: { type: childVault.type, locked: !vaults.isUnlocked(childVault.id) } }
            : {}),
          ...(stored?.linked
            ? {
              storage: {
                location: stored.location?.label || null,
                reachable: stored.reachable,
              },
            }
            : {}),
        });
      } else {
        files.push({
          name: entry.name,
          path: relPath,
          isDir: false,
          kind: P.kindOf(entry.name),
          // Inside a vault this is the encrypted size, a little larger than
          // the real one. Reporting the true size would mean opening and
          // authenticating every file just to draw a listing.
          size: stat.size,
          mtime: stat.mtimeMs,
          ...(ctx ? { encrypted: true, e2e: ctx.type === 'e2e' } : {}),
          // Stamps the thumbnail URL so a changed file busts the browser cache.
          v: Math.round(stat.mtimeMs),
        });
      }
    }));

    folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    // Newest first is what you want in a photo library.
    files.sort((a, b) => b.mtime - a.mtime);

    res.json({
      path: target.rel,
      folders,
      files,
      ...(ctx ? { vault: { path: ctx.albumRel, type: ctx.type, locked: false } } : {}),
    });
    return undefined;
  });

  /**
   * Search the index. The index itself knows nothing about accounts — it is
   * one file describing the whole library — so this route is the only thing
   * standing between a restricted account and another account's files. That
   * is exactly the kind of boundary this app has gotten wrong before (the
   * vault-blind routes fixed after the Phase B audit), so every row is
   * checked here, in JS, rather than folded into the SQL: isWithinRoots's
   * `/`-boundary check (a root of "/Family" must not also match
   * "/FamilyPhotos2") is easy to get subtly wrong if reimplemented as a SQL
   * LIKE clause, and correctness matters more here than the small extra cost
   * of filtering in the route.
   */
  app.get('/api/search', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const kind = typeof req.query.kind === 'string' ? req.query.kind : null;
    const camera = typeof req.query.camera === 'string' ? req.query.camera : null;
    const from = typeof req.query.from === 'string' ? req.query.from : null;
    const to = typeof req.query.to === 'string' ? req.query.to : null;

    let near = null;
    let radiusKm;
    const lat = Number(req.query.near_lat);
    const lon = Number(req.query.near_lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      near = { lat, lon };
      const r = Number(req.query.radius_km);
      radiusKm = Number.isFinite(r) && r > 0 ? r : 5;
    }

    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.floor(requestedLimit), 500) : 100;

    const roots = req.account.roots || ['/'];
    const restricted = !roots.includes('/');

    // A restricted account can have most of a page of raw results filtered
    // back out below, so the index is asked for more than the caller wants
    // and the result trimmed to `limit` after filtering, not before — asking
    // for exactly `limit` rows first could come back empty even when the
    // account has plenty of matches elsewhere within its own roots.
    const rows = indexDb.search({
      text: q,
      kind,
      cameraMake: camera,
      from,
      to,
      near,
      radiusKm,
      limit: restricted ? Math.min(limit * 5, 2000) : limit,
    });

    const results = [];
    for (const row of rows) {
      if (results.length >= limit) break;
      if (!permissions.isWithinRoots(req.account, row.rel_path)) continue;

      // Mirrors /api/list: a locked server-unlock vault shows nothing at
      // all, not even filenames — so a match against a name inside one must
      // not leak that the file exists while it is locked. An e2e vault has
      // no server-side lock state to gate on (the server never holds that
      // key), so its entries — already content-blind, since the indexer
      // never opens vault files — pass through unconditionally.
      if (row.encrypted) {
        const ctx = vaults.contextFor(LIBRARY, row.rel_path);
        if (ctx && ctx.type !== 'e2e' && !ctx.unlocked) continue;
      }

      results.push({
        path: row.rel_path,
        name: row.name,
        kind: row.kind,
        size: row.size,
        mtime: row.mtime_ms,
        encrypted: Boolean(row.encrypted),
        width: row.width,
        height: row.height,
        duration: row.duration,
        cameraMake: row.camera_make,
        cameraModel: row.camera_model,
        capturedAt: row.captured_at,
        gpsLat: row.gps_lat,
        gpsLon: row.gps_lon,
        ...(near ? { distanceKm: row._distanceKm } : {}),
      });
    }

    res.json({ results, indexing: Boolean(indexScan) });
  });

  app.post('/api/index/rebuild', permissions.requireRole('admin'), (req, res) => {
    const alreadyRunning = Boolean(indexScan);
    runIndexScan();
    res.json({ started: !alreadyRunning, alreadyRunning });
  });

  app.get('/api/index/status', permissions.requireRole('admin'), (req, res) => {
    res.json({ scanning: Boolean(indexScan), lastScan: lastIndexReport, count: indexDb.count() });
  });

  app.get('/api/meta', async (req, res) => {
    const opened = await openForRead(req, res, req.query.path);
    if (!opened) return undefined;
    const { target, stat, vault, e2e, meta: vaultMeta } = opened;

    res.setHeader('Cache-Control', 'private, max-age=86400');

    // Inside a vault, stat.size is the encrypted size — larger than the file
    // the person actually has. The true size comes from the authenticated
    // trailer. Dimensions and duration need plaintext, which sharp and
    // ffprobe cannot get at from a path, so they are simply absent here
    // rather than wrong; the thumbnail path already handles that properly.
    if (vault) {
      return res.json({
        path: target.rel,
        size: e2e ? stat.size : vaultMeta.plaintextSize,
        mtime: stat.mtimeMs,
        kind: P.kindOf(target.abs),
        encrypted: true,
        e2e: Boolean(e2e),
      });
    }

    const described = await thumbs.describe(target.abs);
    res.json({
      path: target.rel,
      size: stat.size,
      mtime: stat.mtimeMs,
      kind: P.kindOf(target.abs),
      ...(described || {}),
    });
    return undefined;
  });

  // ---------------------------------------------------------------------------
  // Media delivery
  // ---------------------------------------------------------------------------

  app.get('/api/thumb', async (req, res) => {
    const opened = await openForRead(req, res, req.query.path);
    if (!opened) return undefined;
    const { target, stat, vault, e2e, fileKey } = opened;

    // Nothing on this server can read an end-to-end vault's contents, so
    // there is no thumbnail to make. The client shows a generic tile.
    if (e2e) return res.status(409).json({ error: 'End-to-end encrypted', e2e: true });

    const variant = req.query.v === 'large' ? 'large' : 'grid';
    const thumbPath = vault
      ? await thumbs.getEncrypted(LIBRARY, target.abs, target.rel, stat, variant, fileKey, vault.masterKey)
      : await thumbs.get(LIBRARY, target.abs, target.rel, stat, variant);
    if (!thumbPath) return res.status(404).end();

    const thumbStat = await statOrNull(thumbPath);
    if (!thumbStat) return res.status(404).end();

    // The client appends ?t=<mtime>, so a cached tile is only ever the right one.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('Content-Type', 'image/webp');

    // A vault's thumbnails are themselves encrypted on disk — otherwise the
    // cache would be a plaintext copy of exactly what the vault protects.
    if (vault) {
      const stream = await thumbs.openEncryptedThumb(thumbPath, vault.masterKey);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      return stream.pipe(res);
    }

    res.setHeader('Content-Length', thumbStat.size);
    fs.createReadStream(thumbPath).pipe(res);
    return undefined;
  });

  app.get(['/api/file', '/api/file/*'], async (req, res) => {
    const opened = await openForRead(req, res, req.query.path);
    if (!opened) return undefined;
    const { target, stat, vault, e2e, fileKey, meta } = opened;
    const download = req.query.dl === '1';

    // An end-to-end vault's files are handed over exactly as stored. The
    // browser that owns the key decrypts them; this server cannot and does
    // not try.
    if (vault && !e2e) {
      return sendEncryptedFileStream(req, res, target.abs, stat, fileKey, meta, { download });
    }
    return sendFileStream(req, res, target.abs, stat, { download });
  });

  /**
   * Full-size viewing copy. Safari gets the untouched original; everyone else
   * gets HEIC and TIFF flattened to JPEG, because their browser cannot decode it.
   */
  app.get('/api/preview', async (req, res) => {
    const opened = await openForRead(req, res, req.query.path);
    if (!opened) return undefined;
    const { target, stat, vault, e2e, fileKey, meta } = opened;

    if (e2e) return res.status(409).json({ error: 'End-to-end encrypted', e2e: true });

    const needsConversion = P.kindOf(target.abs) === 'image'
      && !P.isWebSafeImage(target.abs)
      && !(isSafari(req) && P.ext(target.abs) !== '.tif');

    if (!needsConversion) {
      return vault
        ? sendEncryptedFileStream(req, res, target.abs, stat, fileKey, meta, {})
        : sendFileStream(req, res, target.abs, stat);
    }

    const thumbPath = vault
      ? await thumbs.getEncrypted(LIBRARY, target.abs, target.rel, stat, 'large', fileKey, vault.masterKey)
      : await thumbs.get(LIBRARY, target.abs, target.rel, stat, 'large');
    if (!thumbPath) return res.status(415).json({ error: 'Cannot preview this image' });

    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('Content-Type', 'image/webp');

    if (vault) {
      const stream = await thumbs.openEncryptedThumb(thumbPath, vault.masterKey);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      return stream.pipe(res);
    }

    const thumbStat = await statOrNull(thumbPath);
    if (thumbStat) res.setHeader('Content-Length', thumbStat.size);
    fs.createReadStream(thumbPath).pipe(res);
    return undefined;
  });

  /**
   * Live H.264 transcode. Chrome and Firefox cannot play the HEVC that iPhones
   * record into .mov, so the viewer falls back here. Output is fragmented MP4,
   * which starts playing before the encode finishes.
   */
  app.get('/api/stream', async (req, res) => {
    const opened = await openForRead(req, res, req.query.path);
    if (!opened) return undefined;
    const { target, vault, e2e, fileKey, meta } = opened;

    if (e2e) return res.status(409).json({ error: 'End-to-end encrypted', e2e: true });
    if (!ffmpeg.tools().available) {
      return res.status(503).json({ error: 'ffmpeg is not available for transcoding' });
    }

    const startSeconds = Math.max(0, Number(req.query.t) || 0);

    // ffmpeg cannot open an encrypted file, so for a vault the decrypted
    // bytes are piped into it on stdin instead. Seeking then costs more —
    // ffmpeg has to read forward from the start rather than jumping — but a
    // transcode is already sequential, and this keeps plaintext off disk
    // entirely, which is the whole point of the vault.
    const proc = vault
      ? ffmpeg.transcodeStream('pipe:0', { startSeconds, height: 1080 })
      : ffmpeg.transcodeStream(target.abs, { startSeconds, height: 1080 });
    if (!proc) return res.status(503).json({ error: 'Transcoding unavailable' });

    if (vault) {
      const plain = vaultfile.createDecryptStream(target.abs, fileKey, meta, {});
      plain.on('error', () => proc.kill('SIGKILL'));
      // ffmpeg exiting first (a client seeking away) would otherwise make
      // this write to a closed pipe.
      proc.stdin.on('error', () => plain.destroy());
      plain.pipe(proc.stdin);
    }

    res.setHeader('Content-Type', 'video/mp4');
    // Length is unknown while encoding, so ranges cannot be honoured here; the
    // client seeks by re-requesting with ?t=<seconds> instead.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Accept-Ranges', 'none');

    proc.stdout.pipe(res);
    proc.stderr.resume();
    const stop = () => proc.kill('SIGKILL');
    res.on('close', stop);
    proc.on('error', () => res.destroy());
    return undefined;
  });

  /** Tells the viewer whether this client can play the file directly. */
  app.get('/api/playback', async (req, res) => {
    const opened = await openForRead(req, res, req.query.path);
    if (!opened) return undefined;
    const { target, vault, e2e } = opened;

    if (e2e) return res.status(409).json({ error: 'End-to-end encrypted', e2e: true });

    // ffprobe cannot open an encrypted file, and decrypting a whole video
    // just to read its codec would be absurd. Inside a vault, fall back to
    // the container extension: a .mov or .m4v is assumed to be the HEVC an
    // iPhone records, which is the case the transcode fallback exists for.
    // Guessing wrong only costs an unnecessary transcode, never a failure.
    const probed = vault ? null : await ffmpeg.probe(target.abs);
    const codec = (probed?.codec || '').toLowerCase();
    const safari = isSafari(req);
    const appleContainer = P.isAppleVideo(target.abs);
    const needsTranscode = !safari && (
      codec === 'hevc' || codec === 'h265' || (appleContainer && !codec)
    );

    res.json({
      codec: codec || null,
      duration: probed?.duration || 0,
      width: probed?.width || null,
      height: probed?.height || null,
      encrypted: Boolean(vault),
      direct: !needsTranscode,
      url: needsTranscode
        ? `/api/stream?path=${encodeURIComponent(target.rel)}`
        : `/api/file?path=${encodeURIComponent(target.rel)}`,
    });
    return undefined;
  });

  // ---------------------------------------------------------------------------
  // Upload
  // ---------------------------------------------------------------------------

  app.post('/api/upload', permissions.requireRole('contributor'), (req, res) => {
    const dir = permissions.resolveForUser(LIBRARY, req.account, req.query.dir);
    if (!dir) return res.status(400).json({ error: 'Invalid folder' });

    let bb;
    try {
      bb = busboy({
        headers: req.headers,
        limits: { files: 20, fields: 10 },
        highWaterMark: 1024 * 1024,
        fileHwm: 1024 * 1024,
      });
    } catch {
      return res.status(400).json({ error: 'Expected a file upload' });
    }

    const saved = [];
    const failures = [];
    const pending = [];
    let responded = false;

    const fail = (status, message) => {
      if (responded) return;
      responded = true;
      req.unpipe(bb);
      res.status(status).json({ error: message });
    };

    bb.on('file', (field, stream, info) => {
      // The browser sends the folder-relative path so dropped folders keep shape.
      const relHint = req.query.rel ? decodeURIComponent(String(req.query.rel)) : info.filename;
      const segments = P.safeRelSegments(relHint) || P.safeRelSegments(info.filename);
      if (!segments) {
        failures.push({ name: info.filename, error: 'Unsafe filename' });
        stream.resume();
        return;
      }

      const name = segments.pop();
      const destDir = path.join(dir.abs, ...segments);

      // Claimed before anything is written, and atomically: a phone sending a
      // batch opens several requests at once, and two holding the same
      // filename would otherwise each find it free, each pick it, and each
      // write to the same file — losing all but one.
      let finalName = null;
      let finalPath = null;

      const job = (async () => {
        await fsp.mkdir(destDir, { recursive: true });
        finalName = P.reserveName(fs, destDir, name);
        finalPath = path.join(destDir, finalName);
        // Written beside the destination first, so a dropped connection never
        // leaves a file that looks complete in the gallery. The random suffix
        // keeps two uploads from sharing a scratch file even when they are
        // writing names that differ only by the (2) they were given.
        const tempPath = `${finalPath}.${crypto.randomBytes(6).toString('hex')}.part`;

        // Uploading into a vault encrypts on the way through, so plaintext
        // never lands on disk at all — not even briefly in the .part file.
        const destRel = path.posix.join(dir.rel, ...segments, finalName);
        const ctx = vaults.contextFor(LIBRARY, destRel);
        // Same reasoning as openForRead: an end-to-end album has no
        // server-side key, so `unlocked` is always false and checking it
        // would make uploads permanently impossible. What arrives has
        // already been encrypted by the browser.
        if (ctx && ctx.type !== 'e2e' && !ctx.unlocked) {
          throw new Error('That album is locked');
        }
        // An end-to-end vault's client encrypts before uploading, so what
        // arrives here is already ciphertext and is stored untouched.
        const encrypting = ctx && ctx.type !== 'e2e';

        // Count the plaintext as it goes past. Content-Length is the whole
        // multipart body — every file in the request plus its boundaries —
        // so using it would report one file's size as the size of all of
        // them together.
        let plaintextBytes = 0;
        stream.on('data', (piece) => { plaintextBytes += piece.length; });

        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(tempPath, { highWaterMark: READ_CHUNK });
          stream.on('error', reject);
          out.on('error', reject);
          out.on('finish', resolve);

          if (encrypting) {
            const { fileKey, wrappedKey } = vaults.newFileKey(ctx.masterKey);
            const enc = vaultfile.createEncryptStream({ fileKey, wrappedKey });
            enc.on('error', reject);
            stream.pipe(enc).pipe(out);
          } else {
            stream.pipe(out);
          }
        });

        await fsp.rename(tempPath, finalPath);
        const stat = await fsp.stat(finalPath);
        saved.push({
          name: finalName,
          path: destRel,
          // The client cares about the size of its file, not the envelope
          // around it — reporting the on-disk size would show every upload
          // mysteriously growing by a few KB.
          size: encrypting ? plaintextBytes : stat.size,
          mtime: stat.mtimeMs,
          kind: P.kindOf(finalName),
          encrypted: Boolean(ctx),
          v: Math.round(stat.mtimeMs),
        });
      })().catch(async (err) => {
        failures.push({ name, error: err.message });
        stream.resume();
        // Release the reserved name. Without this a failed upload leaves an
        // empty file sitting in the album, which looks like a photo that will
        // not open, and pushes the next attempt to "name (2)".
        if (finalPath) await fsp.rm(finalPath, { force: true }).catch(() => {});
      });

      pending.push(job);
    });

    bb.on('error', (err) => fail(400, err.message));

    bb.on('close', async () => {
      await Promise.allSettled(pending);
      if (responded) return;
      responded = true;
      if (!saved.length && failures.length) {
        // A name this server refuses — a Windows device name, a trailing dot,
        // something with a separator in it — is the request's problem, not a
        // fault here. Reporting 500 blamed the server for it, and clients
        // retry 5xx, so a folder containing one CON.jpg would be uploaded
        // again and again to be refused again and again. A locked vault is
        // likewise the caller's to resolve.
        const client = failures.every((f) => /unsafe|locked|invalid/i.test(f.error || ''));
        return res.status(client ? 400 : 500).json({ error: failures[0].error, failures });
      }
      res.json({ ok: true, saved, failures });
      return undefined;
    });

    return req.pipe(bb);
  });

  // ---------------------------------------------------------------------------
  // Management
  // ---------------------------------------------------------------------------

  app.post('/api/mkdir', permissions.requireRole('contributor'), async (req, res) => {
    const parent = permissions.resolveForUser(LIBRARY, req.account, req.body?.path);
    const name = P.safeName(req.body?.name);
    if (!parent || !name) return res.status(400).json({ error: 'Invalid folder name' });

    const dest = path.join(parent.abs, name);
    if (fs.existsSync(dest)) return res.status(409).json({ error: 'That album already exists' });

    await fsp.mkdir(dest, { recursive: true });
    res.json({ ok: true, path: path.posix.join(parent.rel, name) });
    return undefined;
  });

  app.post('/api/rename', permissions.requireRole('manager'), async (req, res) => {
    const target = permissions.resolveForUser(LIBRARY, req.account, req.body?.path);
    const name = P.safeName(req.body?.name);
    if (!target || !name || target.rel === '/') {
      return res.status(400).json({ error: 'Invalid name' });
    }

    const dest = path.join(path.dirname(target.abs), name);
    if (fs.existsSync(dest)) return res.status(409).json({ error: 'A file with that name exists' });

    try {
      await fsp.rename(target.abs, dest);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ ok: true, path: path.posix.join(path.posix.dirname(target.rel), name) });
    return undefined;
  });

  app.post('/api/move', permissions.requireRole('manager'), async (req, res) => {
    const destDir = permissions.resolveForUser(LIBRARY, req.account, req.body?.to);
    if (!destDir) return res.status(400).json({ error: 'Invalid destination' });

    const items = Array.isArray(req.body?.paths) ? req.body.paths : [];
    const moved = [];
    const failures = [];

    const destVault = vaults.contextFor(LIBRARY, destDir.rel);

    for (const item of items) {
      const src = permissions.resolveForUser(LIBRARY, req.account, item);
      if (!src || src.rel === '/') {
        failures.push({ path: item, error: 'Invalid path' });
        continue;
      }
      // Moving a folder inside itself would detach the whole subtree.
      if (destDir.rel === src.rel || destDir.rel.startsWith(`${src.rel}/`)) {
        failures.push({ path: item, error: 'Cannot move a folder into itself' });
        continue;
      }

      // A plain rename across a vault boundary is silent data loss: the file
      // keeps its encryption but loses the vault that could decrypt it, or
      // stays plaintext somewhere everything is assumed encrypted. Either
      // way it becomes permanently unreadable while reporting success.
      const srcVault = vaults.contextFor(LIBRARY, src.rel);
      const crossing = (srcVault?.metadata.id || null) !== (destVault?.metadata.id || null);
      if (crossing) {
        if (srcVault && !srcVault.unlocked) {
          failures.push({ path: item, error: 'Unlock that album before moving files out of it' });
          continue;
        }
        if (destVault && !destVault.unlocked) {
          failures.push({ path: item, error: 'Unlock the destination album first' });
          continue;
        }
        if (srcVault?.type === 'e2e' || destVault?.type === 'e2e') {
          failures.push({
            path: item,
            error: 'Files cannot be moved in or out of an end-to-end encrypted album — this server has no key for them',
          });
          continue;
        }
        try {
          const name = P.uniqueName(fs, destDir.abs, path.basename(src.abs));
          await reEncryptAcross(src.abs, path.join(destDir.abs, name), srcVault, destVault);
          moved.push(path.posix.join(destDir.rel, name));
        } catch (err) {
          failures.push({ path: item, error: err.message });
        }
        continue;
      }

      try {
        const name = P.uniqueName(fs, destDir.abs, path.basename(src.abs));
        await fsp.rename(src.abs, path.join(destDir.abs, name));
        moved.push(path.posix.join(destDir.rel, name));
      } catch (err) {
        failures.push({ path: item, error: err.message });
      }
    }

    res.json({ ok: failures.length === 0, moved, failures });
    return undefined;
  });

  /**
   * Move one file between differing encryption states, rewriting it on the
   * way: decrypting as it leaves a vault, encrypting as it enters one, or
   * both when moving between two different vaults.
   *
   * Writes to a temporary name and only unlinks the source once the
   * destination is complete, so an interrupted move loses nothing. A
   * directory crossing a vault boundary is refused rather than half-walked:
   * doing it properly means recursing and rewriting every file inside, and a
   * partial result would be worse than a clear refusal.
   */
  async function reEncryptAcross(srcAbs, destAbs, srcVault, destVault) {
    const stat = await fsp.stat(srcAbs);
    if (stat.isDirectory()) {
      throw new Error('Move the files individually — a folder cannot cross an encrypted album boundary in one step');
    }

    const tempPath = `${destAbs}.part`;
    try {
      let source;
      if (srcVault) {
        const { header } = await vaultfile.readHeader(srcAbs);
        const fileKey = vaults.fileKeyFrom(srcVault.masterKey, header.wrappedKey);
        const meta = await vaultfile.readMetadata(srcAbs, fileKey);
        source = vaultfile.createDecryptStream(srcAbs, fileKey, meta, {});
      } else {
        source = fs.createReadStream(srcAbs, { highWaterMark: READ_CHUNK });
      }

      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tempPath, { highWaterMark: READ_CHUNK });
        source.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);

        if (destVault) {
          const { fileKey, wrappedKey } = vaults.newFileKey(destVault.masterKey);
          const enc = vaultfile.createEncryptStream({ fileKey, wrappedKey });
          enc.on('error', reject);
          source.pipe(enc).pipe(out);
        } else {
          source.pipe(out);
        }
      });

      await fsp.rename(tempPath, destAbs);
    } catch (err) {
      await fsp.rm(tempPath, { force: true }).catch(() => {});
      throw err;
    }

    // Only now that the destination is known good.
    await fsp.rm(srcAbs, { force: true });
  }

  /** Deletes move to an internal trash folder rather than vanishing. */
  app.post('/api/delete', permissions.requireRole('manager'), async (req, res) => {
    const items = Array.isArray(req.body?.paths) ? req.body.paths : [];
    const stamp = String(Date.now());
    const deleted = [];
    const failures = [];

    for (const item of items) {
      const src = permissions.resolveForUser(LIBRARY, req.account, item);
      if (!src || src.rel === '/') {
        failures.push({ path: item, error: 'Invalid path' });
        continue;
      }
      try {
        // A vault file trashed into the library-wide bin would be an
        // encrypted blob sitting outside the only vault that could decrypt
        // it — deleted "recoverably" but in fact gone for good. Trash it
        // inside its own vault instead, where it stays covered by the same
        // key. The dot keeps it out of listings exactly like the main bin.
        //
        // Deleting the vault album itself is not a vault file and takes the
        // ordinary path, carrying its metadata and its trash along with it.
        // An album relocated to another drive is a link. Trashing the link is
        // what the ordinary path would do, and it would leave the album's real
        // contents stranded on that drive with nothing pointing at them — not
        // deleted, just invisible and permanent. Its contents are trashed on
        // their own drive instead, for the same reason a vault file is trashed
        // inside its vault.
        if (locations.isLink(src.abs)) {
          const result = await locations.trashAlbum(LIBRARY, config, path.posix.basename(src.rel), stamp);
          configLib.save(config);
          deleted.push(src.rel);
          void result;
          continue;
        }

        const ctx = vaults.contextFor(LIBRARY, src.rel);
        const insideVault = ctx && src.rel !== ctx.albumRel;
        const trashDir = insideVault
          ? path.join(ctx.absDir, '.trash', stamp)
          : path.join(LIBRARY, P.INTERNAL_DIR, 'trash', stamp);

        await fsp.mkdir(trashDir, { recursive: true });
        const name = P.uniqueName(fs, trashDir, path.basename(src.abs));
        await fsp.rename(src.abs, path.join(trashDir, name));
        deleted.push(src.rel);
      } catch (err) {
        failures.push({ path: item, error: err.message });
      }
    }

    res.json({ ok: failures.length === 0, deleted, failures });
    return undefined;
  });

  // ---------------------------------------------------------------------------
  // Vaults
  // ---------------------------------------------------------------------------

  app.get('/api/vaults', async (req, res) => {
    const all = await vaults.listVaults(LIBRARY);
    // Only show vaults the account could reach anyway.
    res.json({ vaults: all.filter((v) => permissions.isWithinRoots(req.account, v.path)) });
  });

  /**
   * Turn an album into a vault. Manager rather than admin: it is a
   * library operation, the same tier as deleting an album, not a
   * server-configuration one.
   */
  app.post('/api/vaults/create', permissions.requireRole('manager'), async (req, res) => {
    const target = permissions.resolveForUser(LIBRARY, req.account, req.body?.path);
    if (!target || target.rel === '/') return res.status(400).json({ error: 'Invalid album' });

    try {
      const metadata = await vaults.createVault(target.abs, {
        passphrase: req.body?.passphrase,
        type: req.body?.type || 'server',
        label: req.body?.label,
      });
      res.json({ ok: true, vault: { path: target.rel, id: metadata.id, type: metadata.type } });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
    return undefined;
  });

  app.post('/api/vaults/unlock', async (req, res) => {
    const target = permissions.resolveForUser(LIBRARY, req.account, req.body?.path);
    if (!target) return res.status(400).json({ error: 'Invalid album' });

    const found = vaults.findVault(LIBRARY, target.rel);
    if (!found) return res.status(404).json({ error: 'That album is not a vault' });

    try {
      if (req.body?.recoveryCode) {
        vaults.unlockWithRecoveryCode(found.metadata, req.body.recoveryCode);
      } else {
        await vaults.unlockVault(found.metadata, req.body?.passphrase);
      }
      res.json({ ok: true, path: found.albumRel });
    } catch (err) {
      // Never 401 here — see lib/vaults.js: that would sign the client out
      // of the whole app for a mistyped vault passphrase.
      res.status(err.status || 403).json({ error: err.message });
    }
    return undefined;
  });

  app.post('/api/vaults/lock', async (req, res) => {
    const target = permissions.resolveForUser(LIBRARY, req.account, req.body?.path);
    if (!target) return res.status(400).json({ error: 'Invalid album' });
    const found = vaults.findVault(LIBRARY, target.rel);
    if (!found) return res.status(404).json({ error: 'That album is not a vault' });
    vaults.lockVault(found.metadata.id);
    res.json({ ok: true, path: found.albumRel });
    return undefined;
  });

  /**
   * Managing who can open a vault.
   *
   * All of these require the vault to be unlocked already — see
   * requireUnlocked in lib/vaults.js. Holding an admin account on this
   * server is deliberately not sufficient: an admin who does not know the
   * passphrase cannot mint themselves a way in.
   */
  function withVault(req, res, handler) {
    const target = permissions.resolveForUser(LIBRARY, req.account, req.body?.path || req.query.path);
    if (!target) {
      res.status(400).json({ error: 'Invalid album' });
      return undefined;
    }
    const found = vaults.findVault(LIBRARY, target.rel);
    if (!found) {
      res.status(404).json({ error: 'That album is not a vault' });
      return undefined;
    }
    return handler(found);
  }

  app.get('/api/vaults/keys', (req, res) => withVault(req, res, (found) => {
    res.json({ path: found.albumRel, keys: vaults.listKeys(found.metadata) });
  }));

  /**
   * The vault's own metadata, for an end-to-end album the browser has to
   * unlock itself.
   *
   * Handing this out is safe and necessary: every master key in it is
   * wrapped under a passphrase-derived key, so it is useless without the
   * passphrase — it is the same material already sitting in the album's
   * folder, which anyone who can read the library can see anyway. Without
   * it the browser has nothing to derive against.
   *
   * Restricted to end-to-end vaults. A server-unlock vault has no reason to
   * ship its wrapped keys to a client, so it does not.
   */
  app.get('/api/vaults/metadata', (req, res) => withVault(req, res, (found) => {
    if (found.metadata.type !== 'e2e') {
      return res.status(400).json({ error: 'Only end-to-end albums are unlocked in the browser' });
    }
    return res.json({
      path: found.albumRel,
      metadata: {
        id: found.metadata.id,
        type: found.metadata.type,
        kdf: found.metadata.kdf,
        check: found.metadata.check,
        keys: found.metadata.keys,
      },
    });
  }));

  app.post('/api/vaults/keys/add', permissions.requireRole('manager'), async (req, res) =>
    withVault(req, res, async (found) => {
      try {
        const keys = await vaults.addPassphrase(found.absDir, found.metadata, {
          passphrase: req.body?.passphrase,
          label: req.body?.label,
        });
        res.json({ ok: true, keys });
      } catch (err) {
        res.status(err.status || 400).json({ error: err.message });
      }
    }));

  app.post('/api/vaults/keys/remove', permissions.requireRole('manager'), async (req, res) =>
    withVault(req, res, async (found) => {
      try {
        const keys = await vaults.removePassphrase(found.absDir, found.metadata, req.body?.keyId);
        res.json({ ok: true, keys });
      } catch (err) {
        res.status(err.status || 400).json({ error: err.message });
      }
    }));

  /**
   * Hands back the vault master key in written form. Deliberately a POST
   * despite reading nothing: it must never land in a browser history entry,
   * a server log line, or a link somebody can share by accident.
   */
  app.post('/api/vaults/recovery-code', permissions.requireRole('manager'), (req, res) =>
    withVault(req, res, (found) => {
      try {
        res.json({
          ok: true,
          code: vaults.exportRecoveryCode(found.metadata),
          warning: 'Anyone with this code can open this album forever. It cannot be revoked without re-encrypting the album.',
        });
      } catch (err) {
        res.status(err.status || 400).json({ error: err.message });
      }
    }));

  // ---------------------------------------------------------------------------
  // Storage locations
  // ---------------------------------------------------------------------------

  /**
   * Registering where albums may live is a machine-configuration decision,
   * not a library one, so it needs admin — unlike relocating an individual
   * album, which is manager, the same tier as moving or deleting it.
   */
  app.get('/api/locations', permissions.requireRole('admin'), (req, res) => {
    res.json({
      locations: locations.list(config).map((loc) => ({
        ...loc,
        albums: locations.albumsOn(LIBRARY, config, loc.id).map((a) => a.name),
      })),
    });
  });

  app.post('/api/locations', permissions.requireRole('admin'), (req, res) => {
    try {
      const added = locations.add(config, {
        library: LIBRARY,
        label: req.body?.label,
        targetPath: req.body?.path,
      });
      configLib.save(config);
      res.json({ ok: true, location: added });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.post('/api/locations/remove', permissions.requireRole('admin'), (req, res) => {
    try {
      locations.remove(config, LIBRARY, req.body?.id);
      configLib.save(config);
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  /**
   * Move an album onto another drive, or bring it back.
   *
   * Both copy the whole album, so both can take a long time and neither is
   * safe to run twice at once against the same album — the album is locked
   * for the duration by simply awaiting here, since Express will not start a
   * second handler for a request that has not been made yet, and the UI
   * disables the control while it runs.
   */
  app.post('/api/locations/relocate', permissions.requireRole('manager'), async (req, res) => {
    const album = permissions.resolveForUser(LIBRARY, req.account, req.body?.path);
    if (!album || album.rel === '/') return res.status(400).json({ error: 'Invalid album' });
    // Only a top-level album can be relocated: a junction part-way down a
    // tree would work, but "this album lives on the backup drive" is a far
    // easier thing to reason about than an arbitrary subfolder doing so.
    if (album.rel.split('/').filter(Boolean).length !== 1) {
      return res.status(400).json({ error: 'Only a top-level album can be moved to another drive' });
    }

    try {
      const name = path.posix.basename(album.rel);
      const result = req.body?.home
        ? await locations.bringAlbumHome(LIBRARY, config, name)
        : await locations.relocateAlbum(LIBRARY, config, name, req.body?.locationId);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
    return undefined;
  });

  // ---------------------------------------------------------------------------
  // Syncing albums to a drive (admin only — a sync can delete on both sides)
  // ---------------------------------------------------------------------------

  app.get('/api/sync', permissions.requireRole('admin'), (req, res) => {
    res.json({ targets: syncTargets.list(config, LIBRARY), policies: syncTargets.POLICIES });
  });

  app.post('/api/sync', permissions.requireRole('admin'), (req, res) => {
    try {
      const target = syncTargets.add(config, LIBRARY, req.body || {});
      configLib.save(config);
      res.json({ ok: true, target });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.post('/api/sync/update', permissions.requireRole('admin'), (req, res) => {
    try {
      const target = syncTargets.update(config, req.body?.id, req.body?.patch || {});
      configLib.save(config);
      res.json({ ok: true, target });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.post('/api/sync/remove', permissions.requireRole('admin'), (req, res) => {
    try {
      syncTargets.remove(config, req.body?.id);
      configLib.save(config);
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  /**
   * Run one sync, or preview it.
   *
   * A preview is the same call with dryRun set, so what is shown cannot drift
   * from what would happen. Runs are serialized per target: two syncs of the
   * same pair of folders at once would each be deciding from a snapshot the
   * other is busy invalidating.
   */
  app.post('/api/sync/run', permissions.requireRole('admin'), async (req, res) => {
    const id = req.body?.id;
    const dryRun = Boolean(req.body?.dryRun);

    if (!dryRun && runningSyncs.has(id)) {
      return res.status(409).json({ error: 'That sync is already running' });
    }

    try {
      const resolved = syncTargets.resolveForRun(config, LIBRARY, id, { create: !dryRun });
      const work = syncEngine.run({
        library: LIBRARY,
        sourceDir: resolved.sourceDir,
        targetDir: resolved.targetDir,
        driveRoot: resolved.driveRoot,
        targetId: resolved.targetId,
        policy: resolved.policy,
        conflictLabel: resolved.conflictLabel,
        dryRun,
      });

      if (!dryRun) runningSyncs.set(id, work);
      const report = await work;

      if (!dryRun) {
        syncTargets.recordRun(config, id, report);
        configLib.save(config);
      }
      return res.json({ ok: true, report });
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    } finally {
      if (!dryRun) runningSyncs.delete(id);
    }
  });

  // ---------------------------------------------------------------------------
  // Accounts (admin only)
  // ---------------------------------------------------------------------------

  app.get('/api/accounts', permissions.requireRole('admin'), (req, res) => {
    res.json({ accounts: accounts.list(config) });
  });

  app.post('/api/accounts', permissions.requireRole('admin'), (req, res) => {
    try {
      const created = accounts.create(config, {
        username: req.body?.username,
        password: req.body?.password,
        role: req.body?.role,
        roots: req.body?.roots,
      });
      res.json({ ok: true, account: created });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.patch('/api/accounts/:username', permissions.requireRole('admin'), (req, res) => {
    try {
      const updated = accounts.update(config, req.params.username, req.body || {});
      // Not what actually blocks a disabled account — requireAuth re-reads
      // account.disabled fresh from config.users on every request, so that
      // takes effect immediately with or without this. This just clears the
      // now-meaningless session record out of the Devices list. A role
      // demotion deliberately does *not* revoke: requireAuth re-reads the
      // role fresh too, so the account is already restricted to its new,
      // lower role on its very next request — forcing a sign-out on top of
      // that would be surprising for a permission change alone.
      if (req.body?.disabled === true) sessions.revokeAllForUser(req.params.username);
      res.json({ ok: true, account: updated });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.delete('/api/accounts/:username', permissions.requireRole('admin'), (req, res) => {
    try {
      accounts.remove(config, req.params.username);
      // Same as above: a deleted account is already refused by requireAuth
      // (config.users.find() returns nothing to match), this just tidies up
      // the Devices list rather than leaving a phantom entry behind.
      sessions.revokeAllForUser(req.params.username);
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Sessions / devices
  // ---------------------------------------------------------------------------

  app.get('/api/sessions', (req, res) => {
    const isAdmin = req.account.role === 'admin';
    const list = sessions.list(isAdmin ? null : req.account.username);
    res.json({ sessions: list.map((s) => ({ ...s, current: s.id === req.sessionId })) });
  });

  app.post('/api/sessions/:id/revoke', (req, res) => {
    const isAdmin = req.account.role === 'admin';
    const target = sessions.find(req.params.id);
    if (!target) return res.status(404).json({ error: 'No such session' });
    if (!isAdmin && target.username !== req.account.username) {
      return res.status(403).json({ error: 'Not your session' });
    }
    sessions.revoke(req.params.id);
    res.json({ ok: true });
    return undefined;
  });

  // ---------------------------------------------------------------------------
  // ZIP download of a selection
  // ---------------------------------------------------------------------------

  const zipJobs = new Map();

  app.post('/api/zip-prepare', (req, res) => {
    const items = Array.isArray(req.body?.paths) ? req.body.paths : [];
    const resolved = items
      .map((item) => permissions.resolveForUser(LIBRARY, req.account, item))
      .filter(Boolean)
      .filter((item) => item.rel !== '/');

    if (!resolved.length) return res.status(400).json({ error: 'Nothing selected' });

    const id = crypto.randomBytes(12).toString('hex');
    zipJobs.set(id, { items: resolved, user: req.user, expires: Date.now() + 5 * 60e3 });
    res.json({ id, url: `/api/zip/${id}` });
    return undefined;
  });

  app.get('/api/zip/:id', async (req, res) => {
    const job = zipJobs.get(req.params.id);
    // A prepared job belongs to the session that made it.
    if (!job || job.expires < Date.now() || job.user !== req.user) {
      return res.status(404).json({ error: 'That download link has expired' });
    }
    zipJobs.delete(req.params.id);

    const stamp = new Date().toISOString().slice(0, 10);
    const name = job.items.length === 1
      ? `${path.basename(job.items[0].abs)}.zip`
      : `lanshare-${stamp}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);

    // store: photos and videos are already compressed, so deflate would burn CPU
    // for nothing and slow the transfer down.
    const archive = archiver('zip', { store: true });
    archive.on('warning', (err) => console.warn('[zip]', err.message));
    archive.on('error', () => res.destroy());
    res.on('close', () => archive.abort());
    archive.pipe(res);

    for (const item of job.items) {
      const stat = await statOrNull(item.abs);
      if (!stat) continue;
      const base = path.basename(item.abs);

      // A zip of raw vault files would be a folder of undecryptable blobs —
      // technically a backup, but not what anyone means by "download these".
      // Files inside an unlocked vault are decrypted into the archive; the
      // zip itself is then plaintext, which is the point of asking for it.
      const ctx = vaults.contextFor(LIBRARY, item.rel);
      if (ctx && !stat.isDirectory()) {
        if (!ctx.unlocked || ctx.type === 'e2e') {
          // Nothing readable to add. Skipping beats emitting a blob the
          // person will discover is useless only after downloading it.
          console.warn(`[zip] skipping ${item.rel}: vault is ${ctx.unlocked ? 'end-to-end' : 'locked'}`);
          continue;
        }
        try {
          const { header } = await vaultfile.readHeader(item.abs);
          const fileKey = vaults.fileKeyFrom(ctx.masterKey, header.wrappedKey);
          const meta = await vaultfile.readMetadata(item.abs, fileKey);
          archive.append(vaultfile.createDecryptStream(item.abs, fileKey, meta, {}), { name: base });
        } catch (err) {
          console.warn(`[zip] skipping ${item.rel}: ${err.message}`);
        }
        continue;
      }

      if (stat.isDirectory()) archive.directory(item.abs, base);
      else archive.file(item.abs, { name: base });
    }

    await archive.finalize();
    return undefined;
  });

  // Clear out prepared-but-never-fetched zip jobs.
  const zipSweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, job] of zipJobs) if (job.expires < now) zipJobs.delete(id);
  }, 60e3);
  zipSweeper.unref();

  // ---------------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------------

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    return res.redirect('/');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[error]', err.message);
    if (res.headersSent) return res.destroy();
    return res.status(500).json({ error: 'Something went wrong on the server' });
  });

  // Watches for a sync target's drive being plugged in. Runs in the headless
  // server too, not only the desktop app — a machine left running as the
  // household's library is exactly where "sync when I plug the disk in"
  // earns its keep.
  const watcher = new syncWatcher.SyncWatcher({
    getConfig: () => config,
    getLibrary: () => LIBRARY,
    save: (updated) => configLib.save(updated),
    log: (message) => console.log(`[sync] ${message}`),
  });
  watcher.start();

  // Announces this host on the LAN and collects the others, so adding a
  // machine is picking it from a list rather than knowing its IP.
  const finder = new discovery.Discovery({
    getConfig: () => config,
    announce: config.discoverable !== false,
    log: (message) => console.log(`[discovery] ${message}`),
  });
  finder.start();

  return {
    app,
    LIBRARY,
    syncWatcher: watcher,
    discovery: finder,
    stopBackgroundTasks: async () => {
      clearInterval(zipSweeper);
      watcher.stop();
      finder.stop();
      // Let an in-flight scan finish (or fail) on its own before the
      // database it writes to is closed out from under it. Without this, a
      // fast start()-then-stop() — every route test does exactly that —
      // races a background scan against its own database handle.
      await indexScan;
      indexDb.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

function tuneServer(server) {
  // Node kills any request older than 5 minutes by default, which silently
  // breaks multi-gigabyte uploads. Uploads are exactly what this app is for.
  server.requestTimeout = 0;
  server.headersTimeout = 120e3;
  server.keepAliveTimeout = 72e3;
  server.on('connection', (socket) => {
    // Media streaming is throughput-bound; do not let Nagle add latency.
    socket.setNoDelay(true);
  });
  return server;
}

/**
 * Bring up the HTTPS listener. Chrome and Edge only offer to install a PWA,
 * and only allow a service worker, in a secure context — so this is what
 * makes the app installable on Android and desktop. Failure here is never
 * fatal: the HTTP listener is the one that matters.
 */
async function startHttps(app, config, library) {
  if (!config.httpsPort) return null;

  const credentials = await tls.ensureCertificate(library);
  if (!credentials) return null;

  const server = tuneServer(https.createServer(
    { key: credentials.key, cert: credentials.cert },
    app,
  ));

  server.on('error', (err) => {
    console.warn(`[https] disabled: ${err.message}`);
  });

  await new Promise((resolve) => server.listen(config.httpsPort, '0.0.0.0', resolve));
  return server;
}

/**
 * Build the app and bring its listener(s) up. Returns a handle the caller
 * uses to find out what actually started and to shut it down again —
 * `stop()` is what lets the desktop app restart the server when you change a
 * port or the library location, without restarting the whole process.
 */
async function start(config) {
  const { app, LIBRARY, stopBackgroundTasks, syncWatcher: watcher, discovery: finder } = createApp(config);
  const httpServer = tuneServer(http.createServer(app));

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, '0.0.0.0', () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  // A key pair takes a moment to generate on first run; the HTTP listener is
  // already accepting connections by the time this resolves.
  const httpsServer = await startHttps(app, config, LIBRARY);

  async function stop() {
    await stopBackgroundTasks();
    // Stopping the server drops every unlocked vault key. Anything else
    // would leave keys in memory for a server nobody is running — and the
    // desktop app stops and restarts the server routinely, for a port
    // change or a library move, so this is a real path rather than a
    // shutdown-only nicety.
    vaults.lockAll();
    await Promise.all([
      new Promise((resolve) => httpServer.close(() => resolve())),
      httpsServer ? new Promise((resolve) => httpsServer.close(() => resolve())) : Promise.resolve(),
    ]);
  }

  return {
    app,
    LIBRARY,
    httpServer,
    httpsServer,
    stop,
    port: config.port,
    httpsPort: httpsServer ? config.httpsPort : null,
    // Passed through so the desktop app can show what these are doing. Left
    // out of this object once already, which cost nothing visible — the
    // features simply did nothing, silently, because every caller checks for
    // them before use.
    syncWatcher: watcher,
    discovery: finder,
  };
}

module.exports = { createApp, start, tuneServer };
