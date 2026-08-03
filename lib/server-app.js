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
const P = require('./paths');
const thumbs = require('./thumbs');
const ffmpeg = require('./ffmpeg');
const tls = require('./tls');
const permissions = require('./permissions');
const accounts = require('./accounts');
const sessions = require('./sessions');

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
 * Stream a file with byte-range support.
 * iOS Safari will not play a video at all unless ranges return 206.
 */
async function sendFileStream(req, res, absPath, stat, { download = false, type } = {}) {
  const contentType = type || P.mimeOf(absPath);
  const filename = path.basename(absPath);
  const encoded = encodeURIComponent(filename);

  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  res.setHeader('Cache-Control', 'private, max-age=31536000');
  res.setHeader(
    'Content-Disposition',
    `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encoded}`,
  );

  const range = req.headers.range;
  let start = 0;
  let end = stat.size - 1;

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }
    const [, rawStart, rawEnd] = match;
    if (rawStart === '' && rawEnd === '') {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }
    if (rawStart === '') {
      // "bytes=-500" means the last 500 bytes.
      start = Math.max(0, stat.size - Number(rawEnd));
    } else {
      start = Number(rawStart);
      if (rawEnd !== '') end = Math.min(Number(rawEnd), stat.size - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }
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

// ---------------------------------------------------------------------------
// App construction
// ---------------------------------------------------------------------------

function createApp(config) {
  const LIBRARY = path.resolve(config.library);
  const PUBLIC_DIR = path.join(__dirname, '..', 'public');

  fs.mkdirSync(LIBRARY, { recursive: true });
  fs.mkdirSync(path.join(LIBRARY, P.INTERNAL_DIR), { recursive: true });

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

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  app.post('/api/login', (req, res) => {
    const ip = req.socket.remoteAddress || 'unknown';
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
      if (!stat) return;

      const relPath = path.posix.join(target.rel, entry.name);
      if (entry.isDirectory()) {
        folders.push({ name: entry.name, path: relPath, isDir: true, mtime: stat.mtimeMs });
      } else {
        files.push({
          name: entry.name,
          path: relPath,
          isDir: false,
          kind: P.kindOf(entry.name),
          size: stat.size,
          mtime: stat.mtimeMs,
          // Stamps the thumbnail URL so a changed file busts the browser cache.
          v: Math.round(stat.mtimeMs),
        });
      }
    }));

    folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    // Newest first is what you want in a photo library.
    files.sort((a, b) => b.mtime - a.mtime);

    res.json({ path: target.rel, folders, files });
    return undefined;
  });

  app.get('/api/meta', async (req, res) => {
    const target = resolveOr400(req, res, req.query.path);
    if (!target) return undefined;
    const stat = await statOrNull(target.abs);
    if (!stat || stat.isDirectory()) return res.status(404).json({ error: 'Not found' });

    const meta = await thumbs.describe(target.abs);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.json({
      path: target.rel,
      size: stat.size,
      mtime: stat.mtimeMs,
      kind: P.kindOf(target.abs),
      ...(meta || {}),
    });
    return undefined;
  });

  // ---------------------------------------------------------------------------
  // Media delivery
  // ---------------------------------------------------------------------------

  app.get('/api/thumb', async (req, res) => {
    const target = resolveOr400(req, res, req.query.path);
    if (!target) return undefined;
    const stat = await statOrNull(target.abs);
    if (!stat || stat.isDirectory()) return res.status(404).end();

    const variant = req.query.v === 'large' ? 'large' : 'grid';
    const thumbPath = await thumbs.get(LIBRARY, target.abs, target.rel, stat, variant);
    if (!thumbPath) return res.status(404).end();

    const thumbStat = await statOrNull(thumbPath);
    if (!thumbStat) return res.status(404).end();

    // The client appends ?t=<mtime>, so a cached tile is only ever the right one.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Content-Length', thumbStat.size);
    fs.createReadStream(thumbPath).pipe(res);
    return undefined;
  });

  app.get(['/api/file', '/api/file/*'], async (req, res) => {
    const target = resolveOr400(req, res, req.query.path);
    if (!target) return undefined;
    const stat = await statOrNull(target.abs);
    if (!stat || stat.isDirectory()) return res.status(404).json({ error: 'Not found' });
    return sendFileStream(req, res, target.abs, stat, { download: req.query.dl === '1' });
  });

  /**
   * Full-size viewing copy. Safari gets the untouched original; everyone else
   * gets HEIC and TIFF flattened to JPEG, because their browser cannot decode it.
   */
  app.get('/api/preview', async (req, res) => {
    const target = resolveOr400(req, res, req.query.path);
    if (!target) return undefined;
    const stat = await statOrNull(target.abs);
    if (!stat || stat.isDirectory()) return res.status(404).json({ error: 'Not found' });

    if (P.kindOf(target.abs) !== 'image') {
      return sendFileStream(req, res, target.abs, stat);
    }
    if (P.isWebSafeImage(target.abs) || (isSafari(req) && P.ext(target.abs) !== '.tif')) {
      return sendFileStream(req, res, target.abs, stat);
    }

    const thumbPath = await thumbs.get(LIBRARY, target.abs, target.rel, stat, 'large');
    if (!thumbPath) return res.status(415).json({ error: 'Cannot preview this image' });
    const thumbStat = await statOrNull(thumbPath);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('Content-Type', 'image/webp');
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
    const target = resolveOr400(req, res, req.query.path);
    if (!target) return undefined;
    const stat = await statOrNull(target.abs);
    if (!stat || stat.isDirectory()) return res.status(404).json({ error: 'Not found' });
    if (!ffmpeg.tools().available) {
      return res.status(503).json({ error: 'ffmpeg is not available for transcoding' });
    }

    const startSeconds = Math.max(0, Number(req.query.t) || 0);
    const proc = ffmpeg.transcodeStream(target.abs, { startSeconds, height: 1080 });
    if (!proc) return res.status(503).json({ error: 'Transcoding unavailable' });

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
    const target = resolveOr400(req, res, req.query.path);
    if (!target) return undefined;
    const stat = await statOrNull(target.abs);
    if (!stat || stat.isDirectory()) return res.status(404).json({ error: 'Not found' });

    const meta = await ffmpeg.probe(target.abs);
    const codec = (meta?.codec || '').toLowerCase();
    const safari = isSafari(req);
    // HEVC plays on Apple devices and essentially nowhere else.
    const needsTranscode = !safari && (codec === 'hevc' || codec === 'h265')
      || (!safari && P.isAppleVideo(target.abs) && !codec);

    res.json({
      codec: codec || null,
      duration: meta?.duration || 0,
      width: meta?.width || null,
      height: meta?.height || null,
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

      const job = (async () => {
        await fsp.mkdir(destDir, { recursive: true });
        const finalName = P.uniqueName(fs, destDir, name);
        const finalPath = path.join(destDir, finalName);
        // Write to .part first so a dropped connection never leaves a file that
        // looks complete in the gallery.
        const tempPath = `${finalPath}.part`;

        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(tempPath, { highWaterMark: READ_CHUNK });
          stream.on('error', reject);
          out.on('error', reject);
          out.on('finish', resolve);
          stream.pipe(out);
        });

        await fsp.rename(tempPath, finalPath);
        const stat = await fsp.stat(finalPath);
        saved.push({
          name: finalName,
          path: path.posix.join(dir.rel, ...segments, finalName),
          size: stat.size,
          mtime: stat.mtimeMs,
          kind: P.kindOf(finalName),
          v: Math.round(stat.mtimeMs),
        });
      })().catch(async (err) => {
        failures.push({ name, error: err.message });
        stream.resume();
      });

      pending.push(job);
    });

    bb.on('error', (err) => fail(400, err.message));

    bb.on('close', async () => {
      await Promise.allSettled(pending);
      if (responded) return;
      responded = true;
      if (!saved.length && failures.length) {
        return res.status(500).json({ error: failures[0].error, failures });
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

  /** Deletes move to an internal trash folder rather than vanishing. */
  app.post('/api/delete', permissions.requireRole('manager'), async (req, res) => {
    const items = Array.isArray(req.body?.paths) ? req.body.paths : [];
    const trashDir = path.join(LIBRARY, P.INTERNAL_DIR, 'trash', String(Date.now()));
    const deleted = [];
    const failures = [];

    for (const item of items) {
      const src = permissions.resolveForUser(LIBRARY, req.account, item);
      if (!src || src.rel === '/') {
        failures.push({ path: item, error: 'Invalid path' });
        continue;
      }
      try {
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
      // A disabled or demoted account must not keep working on an existing
      // session until that session happens to expire, up to 30 days later.
      if (req.body?.disabled === true) sessions.revokeAllForUser(req.params.username);
      res.json({ ok: true, account: updated });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.delete('/api/accounts/:username', permissions.requireRole('admin'), (req, res) => {
    try {
      accounts.remove(config, req.params.username);
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

  return { app, LIBRARY, stopBackgroundTasks: () => clearInterval(zipSweeper) };
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
  const { app, LIBRARY, stopBackgroundTasks } = createApp(config);
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
    stopBackgroundTasks();
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
  };
}

module.exports = { createApp, start, tuneServer };
