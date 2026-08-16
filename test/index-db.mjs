/**
 * The search index itself: storage, duplicate lookup, and every filter
 * search() supports, alone and combined.
 *
 *   node test/index-db.mjs
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { IndexDb, haversineKm, boundingBox } = require(path.join(here, '..', 'lib', 'index-db.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

const roots = [];
const opened = [];
function scratchDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lanshare-index-'));
  roots.push(dir);
  const db = new IndexDb(path.join(dir, '.lanshare', 'index.db'));
  // WAL mode holds the file open (and, on Windows, locked) until close() is
  // called. Tracking every handle here means a test block that forgets to
  // close its own db — as one originally did — still gets cleaned up, rather
  // than failing the whole suite on an unrelated EBUSY during teardown.
  opened.push(db);
  return db;
}

const T = new Date('2026-08-11T10:00:00Z').getTime();
function entry(overrides = {}) {
  return {
    relPath: '/Album/photo.jpg', size: 1000, mtimeMs: T, hash: 'abc123',
    kind: 'image', encrypted: false,
    width: 100, height: 100, duration: null,
    cameraMake: null, cameraModel: null, capturedAt: null,
    gpsLat: null, gpsLon: null,
    ...overrides,
  };
}

try {
  // --- the database file itself ---------------------------------------------

  {
    const dir = mkdtempSync(path.join(tmpdir(), 'lanshare-index-'));
    roots.push(dir);
    const dbPath = path.join(dir, '.lanshare', 'index.db');
    const db = new IndexDb(dbPath);
    check('the db file is created, including its parent directory', existsSync(dbPath));
    const mode = db.db.prepare('PRAGMA journal_mode').get();
    check('WAL mode is on, so a search stays responsive during a rebuild',
      String(mode.journal_mode).toLowerCase() === 'wal', JSON.stringify(mode));
    db.close();

    // Reopening an existing db must not fail on "table already exists".
    let reopenError = null;
    let reopened;
    try { reopened = new IndexDb(dbPath); } catch (err) { reopenError = err; }
    check('reopening an existing index does not fail', reopenError === null, reopenError?.message);
    reopened?.close();
  }

  // --- basic storage -----------------------------------------------------------

  {
    const db = scratchDb();
    db.upsert(entry({ relPath: '/Album/a.jpg', cameraMake: 'DJI', cameraModel: 'FC3582' }));
    const row = db.getByPath('/Album/a.jpg');
    check('a stored file can be read back by path', row?.rel_path === '/Album/a.jpg');
    check('its name is derived from the path', row?.name === 'a.jpg', row?.name);
    check('camera fields round-trip', row?.camera_make === 'DJI' && row?.camera_model === 'FC3582');
    check('a path never indexed returns null, not undefined or a throw',
      db.getByPath('/nope.jpg') === null);

    db.upsert(entry({ relPath: '/Album/a.jpg', size: 2000, cameraMake: 'Canon' }));
    check('upserting the same path updates rather than duplicating', db.count() === 1, db.count());
    check('and the new values win', db.getByPath('/Album/a.jpg')?.size === 2000
      && db.getByPath('/Album/a.jpg')?.camera_make === 'Canon');

    db.remove('/Album/a.jpg');
    check('removing a file drops it from the index', db.getByPath('/Album/a.jpg') === null);
    check('and the count reflects it', db.count() === 0);
    db.close();
  }

  // --- encrypted files: shallow metadata only -----------------------------------

  {
    const db = scratchDb();
    db.upsert(entry({
      relPath: '/Vault/secret.jpg', encrypted: true,
      cameraMake: null, cameraModel: null, capturedAt: null, gpsLat: null, gpsLon: null,
    }));
    const row = db.getByPath('/Vault/secret.jpg');
    check('an encrypted file is flagged as such', row?.encrypted === 1, row?.encrypted);
    check('and carries no extracted metadata', row?.camera_make === null && row?.gps_lat === null);
    db.close();
  }

  // --- duplicate detection by content hash --------------------------------------

  {
    const db = scratchDb();
    db.upsert(entry({ relPath: '/A/photo.jpg', hash: 'same-hash' }));
    db.upsert(entry({ relPath: '/B/copy.jpg', hash: 'same-hash' }));
    db.upsert(entry({ relPath: '/C/other.jpg', hash: 'different-hash' }));

    const dupes = db.getByHash('same-hash');
    check('every file sharing a hash is found', dupes.length === 2,
      JSON.stringify(dupes.map((d) => d.rel_path)));
    check('a hash used once returns exactly one row', db.getByHash('different-hash').length === 1);
    check('a hash nobody has returns an empty list, not null', Array.isArray(db.getByHash('nothing-like-this')) && db.getByHash('nothing-like-this').length === 0);
    check('an empty or missing hash is handled without throwing', db.getByHash(null).length === 0 && db.getByHash('').length === 0);
    db.close();
  }

  // --- allEntries(), for incremental scanning -----------------------------------

  {
    const db = scratchDb();
    db.upsert(entry({ relPath: '/a.jpg', size: 111, mtimeMs: 222 }));
    db.upsert(entry({ relPath: '/b.jpg', size: 333, mtimeMs: 444 }));
    const all = db.allEntries();
    check('allEntries lists every indexed file', all.length === 2);
    const a = all.find((e) => e.rel_path === '/a.jpg');
    check('with enough to decide "unchanged, skip it" without reopening the file',
      a?.size === 111 && a?.mtime_ms === 222, JSON.stringify(a));
    db.close();
  }

  // --- text search ---------------------------------------------------------------

  {
    const db = scratchDb();
    db.upsert(entry({ relPath: '/Trip/vacation-beach.jpg' }));
    db.upsert(entry({ relPath: '/Trip/vacation-sunset.jpg' }));
    db.upsert(entry({ relPath: '/Work/report.pdf', kind: 'file' }));

    const found = db.search({ text: 'vacation' });
    check('a text search finds matching filenames', found.length === 2,
      JSON.stringify(found.map((f) => f.rel_path)));
    check('and does not match unrelated ones', !found.some((f) => f.name === 'report.pdf'));

    const caseInsensitive = db.search({ text: 'VACATION' });
    check('search is case-insensitive', caseInsensitive.length === 2);

    check('a query matching nothing returns an empty list', db.search({ text: 'nonexistent' }).length === 0);
  }

  {
    // Filenames with characters that are FTS5 query syntax, not literal text
    // — a raw MATCH would throw a syntax error on these rather than search.
    const db = scratchDb();
    db.upsert(entry({ relPath: '/IMG-2026-01-01(1).jpg' }));
    let threw = false;
    let found = [];
    try { found = db.search({ text: 'IMG-2026-01-01(1).jpg' }); } catch { threw = true; }
    check('a filename containing FTS syntax characters does not throw', !threw);
    check('and still finds the file', !threw && found.length === 1, JSON.stringify(found));

    for (const weird of ['', '   ', '"', '*', 'a AND OR NOT b', String.fromCharCode(0)]) {
      let ok = true;
      try { db.search({ text: weird }); } catch { ok = false; }
      check(`a search of ${JSON.stringify(weird)} does not throw`, ok);
    }
    db.close();
  }

  // --- structured filters ---------------------------------------------------------

  {
    const db = scratchDb();
    db.upsert(entry({ relPath: '/a.jpg', kind: 'image', cameraMake: 'DJI', capturedAt: '2026-03-01T00:00:00Z' }));
    db.upsert(entry({ relPath: '/b.mp4', kind: 'video', cameraMake: 'DJI', capturedAt: '2026-03-02T00:00:00Z' }));
    db.upsert(entry({ relPath: '/c.jpg', kind: 'image', cameraMake: 'Canon', capturedAt: '2026-06-01T00:00:00Z' }));

    check('filtering by kind alone', db.search({ kind: 'video' }).length === 1);
    check('filtering by camera make alone', db.search({ cameraMake: 'DJI' }).length === 2);
    check('filtering by a date range', db.search({ from: '2026-02-01', to: '2026-04-01' }).length === 2,
      JSON.stringify(db.search({ from: '2026-02-01', to: '2026-04-01' }).map((r) => r.rel_path)));

    const combined = db.search({ kind: 'image', cameraMake: 'DJI' });
    check('filters combine with AND, not OR', combined.length === 1 && combined[0].rel_path === '/a.jpg',
      JSON.stringify(combined.map((r) => r.rel_path)));
    db.close();
  }

  // --- GPS radius search -----------------------------------------------------------

  {
    const db = scratchDb();
    // Manali, roughly.
    const center = { lat: 32.2432, lon: 77.1892 };
    db.upsert(entry({ relPath: '/near1.jpg', gpsLat: 32.2440, gpsLon: 77.1900 })); // ~0.1km
    db.upsert(entry({ relPath: '/near2.jpg', gpsLat: 32.2500, gpsLon: 77.1950 })); // ~1km
    db.upsert(entry({ relPath: '/far.jpg', gpsLat: 28.6139, gpsLon: 77.2090 })); // Delhi, ~400km away
    db.upsert(entry({ relPath: '/none.jpg', gpsLat: null, gpsLon: null }));

    const nearby = db.search({ near: center, radiusKm: 5 });
    check('only files within the radius are returned',
      nearby.length === 2 && nearby.every((r) => ['/near1.jpg', '/near2.jpg'].includes(r.rel_path)),
      JSON.stringify(nearby.map((r) => r.rel_path)));
    check('the nearer file sorts first', nearby[0].rel_path === '/near1.jpg',
      JSON.stringify(nearby.map((r) => r.rel_path)));
    check('a file with no GPS at all is never included in a location search',
      !nearby.some((r) => r.rel_path === '/none.jpg'));

    const wide = db.search({ near: center, radiusKm: 500 });
    check('widening the radius includes the far file too', wide.some((r) => r.rel_path === '/far.jpg'));
    db.close();
  }

  {
    const db = scratchDb();
    db.upsert(entry({ relPath: '/pole.jpg', gpsLat: 89.9, gpsLon: 10 }));
    let threw = false;
    try { db.search({ near: { lat: 89.9, lon: 10 }, radiusKm: 5 }); } catch { threw = true; }
    check('a search near the pole, where longitude degrees compress toward nothing, does not throw', !threw);
    db.close();
  }

  // --- the distance math itself, independent of the database ----------------------

  {
    check('the distance from a point to itself is zero', haversineKm(10, 20, 10, 20) === 0);
    // London to Paris is well-documented at roughly 344 km.
    const d = haversineKm(51.5074, -0.1278, 48.8566, 2.3522);
    check('a known real-world distance comes out approximately right',
      Math.abs(d - 344) < 15, d);
    check('missing coordinates produce Infinity rather than NaN or a throw',
      haversineKm(10, 20, null, null) === Infinity);
  }

  {
    const box = boundingBox(32.24, 77.19, 5);
    check('a bounding box surrounds its center point',
      box.latMin < 32.24 && box.latMax > 32.24 && box.lonMin < 77.19 && box.lonMax > 77.19,
      JSON.stringify(box));
  }

  // --- limit is respected -----------------------------------------------------------

  {
    const db = scratchDb();
    for (let i = 0; i < 20; i++) db.upsert(entry({ relPath: `/file-${i}.jpg` }));
    const limited = db.search({ limit: 5 });
    check('search respects an explicit limit', limited.length === 5, limited.length);
    db.close();
  }
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error -> ${err.stack || err.message}`);
} finally {
  for (const db of opened) {
    try { db.close(); } catch { /* already closed */ }
  }
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
