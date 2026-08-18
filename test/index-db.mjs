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

  // --- content embeddings (Phase N) --------------------------------------------------
  // Uses synthetic, hand-built vectors throughout, never the real CLIP model —
  // proving the real model's embeddings are meaningful is test/clip.mjs's job;
  // this file's job is proving the storage and ranking built on top of
  // whatever vectors it is handed are correct.

  const MODEL = 'test-model-v1';
  function unit(...dims) {
    // A short, easy-to-reason-about vector, padded to a fixed length and
    // then actually normalized — not just "looks unit length" by construction.
    const v = new Float32Array(8);
    dims.forEach((d, i) => { v[i] = d; });
    let sumSq = 0;
    for (const x of v) sumSq += x * x;
    const norm = Math.sqrt(sumSq) || 1;
    return v.map((x) => x / norm);
  }

  {
    const db = scratchDb();
    const v = unit(1, 2, 3, 4);
    db.upsertEmbedding('hash-a', MODEL, v);
    const back = db.getEmbedding('hash-a', MODEL);
    check('an embedding round-trips through storage bit-for-bit (within float32 precision)',
      back.length === v.length && back.every((x, i) => Math.abs(x - v[i]) < 1e-6),
      JSON.stringify([...back]));
    check('an embedding under a different model is not found', db.getEmbedding('hash-a', 'other-model') === null);
    check('an unknown hash is not found', db.getEmbedding('hash-does-not-exist', MODEL) === null);
    db.close();
  }

  {
    const db = scratchDb();
    const v1 = unit(1, 0, 0);
    db.upsertEmbedding('hash-a', MODEL, v1);
    const v2 = unit(0, 1, 0);
    db.upsertEmbedding('hash-a', MODEL, v2);
    const back = db.getEmbedding('hash-a', MODEL);
    check('storing a new embedding for the same hash+model replaces it, not duplicates it',
      back.every((x, i) => Math.abs(x - v2[i]) < 1e-6));
    check('and no duplicate row was created', db.countEmbedded(MODEL) === 1, db.countEmbedded(MODEL));
    db.close();
  }

  {
    const db = scratchDb();
    db.upsert(entry({ relPath: '/a.jpg', hash: 'hash-a' }));
    db.upsert(entry({ relPath: '/b.jpg', hash: 'hash-b' }));
    // A duplicate of hash-a under a second path — must count once, not twice.
    db.upsert(entry({ relPath: '/a-copy.jpg', hash: 'hash-a' }));
    db.upsert(entry({
      relPath: '/vault/c.jpg', hash: 'hash-c', encrypted: true,
    }));
    db.upsert(entry({ relPath: '/no-hash.jpg', hash: null }));

    check('countEmbeddable counts distinct hashes, excluding encrypted and hash-less files',
      db.countEmbeddable() === 2, db.countEmbeddable());

    const needing = db.hashesNeedingEmbedding(MODEL);
    check('hashesNeedingEmbedding lists every embeddable hash before anything is embedded',
      needing.length === 2 && needing.some((n) => n.hash === 'hash-a') && needing.some((n) => n.hash === 'hash-b'),
      JSON.stringify(needing));
    check('a vault file never appears as needing embedding', !needing.some((n) => n.hash === 'hash-c'));
    // MIN(rel_path) is a plain lexicographic string comparison: '-' (0x2D)
    // sorts before '.' (0x2E), so between '/a-copy.jpg' and '/a.jpg' the
    // hyphenated one wins. Asserting the exact value, not just "one of the
    // two", is what actually proves the choice is deterministic rather than
    // incidentally stable.
    const forA = needing.find((n) => n.hash === 'hash-a');
    check('the representative path for a hash with two copies picks MIN(rel_path) deterministically',
      forA.relPath === '/a-copy.jpg', forA.relPath);

    db.upsertEmbedding('hash-a', MODEL, unit(1, 0, 0));
    const stillNeeding = db.hashesNeedingEmbedding(MODEL);
    check('once embedded, a hash stops appearing in hashesNeedingEmbedding — naturally incremental',
      stillNeeding.length === 1 && stillNeeding[0].hash === 'hash-b', JSON.stringify(stillNeeding));
    check('countEmbedded reflects exactly what has been embedded so far', db.countEmbedded(MODEL) === 1);

    db.close();
  }

  {
    const db = scratchDb();
    db.upsert(entry({ relPath: '/cat.jpg', hash: 'hash-cat' }));
    db.upsert(entry({ relPath: '/dog.jpg', hash: 'hash-dog' }));
    db.upsert(entry({ relPath: '/car.jpg', hash: 'hash-car' }));

    // Three well-separated directions in a toy embedding space; a query
    // vector close to one and far from the others should rank accordingly,
    // exactly as a real CLIP space would for genuinely different content.
    db.upsertEmbedding('hash-cat', MODEL, unit(1, 0, 0));
    db.upsertEmbedding('hash-dog', MODEL, unit(0, 1, 0));
    db.upsertEmbedding('hash-car', MODEL, unit(0, 0, 1));

    const results = db.searchByContent(unit(0.95, 0.05, 0), { model: MODEL });
    check('the closest vector ranks first', results[0].hash === 'hash-cat', JSON.stringify(results.map((r) => r.hash)));
    check('every result carries its similarity score', results.every((r) => typeof r._score === 'number'));
    check('scores are sorted highest first', results[0]._score >= results[1]._score && results[1]._score >= results[2]._score);
    check('a result under a model nobody embedded anything for comes back empty',
      db.searchByContent(unit(1, 0, 0), { model: 'nobody-used-this-model' }).length === 0);

    const limited = db.searchByContent(unit(1, 0, 0), { model: MODEL, limit: 1 });
    check('limit is respected', limited.length === 1);
    db.close();
  }

  {
    const db = scratchDb();
    db.upsert(entry({ relPath: '/x.jpg', hash: 'hash-x' }));
    db.upsert(entry({ relPath: '/x-copy.jpg', hash: 'hash-x' }));
    db.upsertEmbedding('hash-x', MODEL, unit(1, 0, 0));
    const results = db.searchByContent(unit(1, 0, 0), { model: MODEL });
    check('a hash shared by two files still yields exactly one search result, not one per path',
      results.length === 1, results.length);

    // Which copy represents the hash has to be the caller's call, because an
    // embedding belongs to content and a restricted account may be able to
    // see only one of the albums that content sits in. Choosing blindly and
    // filtering afterwards loses the result entirely — the account has a
    // perfectly visible copy but the invisible one stood in for it.
    const onlyCopy = db.searchByContent(unit(1, 0, 0), {
      model: MODEL,
      isVisible: (row) => row.rel_path === '/x-copy.jpg',
    });
    check('isVisible picks the copy the caller can actually see',
      onlyCopy.length === 1 && onlyCopy[0].rel_path === '/x-copy.jpg', JSON.stringify(onlyCopy.map((r) => r.rel_path)));

    check('a hash with no visible copy at all yields nothing, rather than leaking one',
      db.searchByContent(unit(1, 0, 0), { model: MODEL, isVisible: () => false }).length === 0);

    check('the score still travels with the chosen copy',
      typeof onlyCopy[0]._score === 'number');
    db.close();
  }

  // --- Phase O1: Adaptive Pattern Engine tables -------------------------------
  // Every one of these is hash- or id-keyed, never a column on `files`, so a
  // trip or a correction survives the very file move it causes. See the
  // SCHEMA comment in lib/index-db.js for why.

  {
    const db = scratchDb();

    const cluster = db.createTripCluster({
      id: 'trip-1', status: 'proposed',
      startsAt: '2026-08-01T00:00:00Z', endsAt: '2026-08-04T00:00:00Z',
      cameraSet: ['DJI FC3582', 'Apple iPhone'],
      gpsEnvelope: { latMin: 32, latMax: 33, lonMin: 77, lonMax: 78 },
    });
    check('creating a trip cluster returns it with JSON fields already parsed',
      Array.isArray(cluster.cameraSet) && cluster.gpsEnvelope.latMin === 32, JSON.stringify(cluster));
    check('and a fresh read back matches', db.getTripCluster('trip-1').status === 'proposed');

    db.addTripClusterMember('trip-1', 'hash-a', 'time-density');
    db.addTripClusterMember('trip-1', 'hash-b', 'gps-anchor');
    check('members are recorded with their reason',
      db.tripClusterMembers('trip-1').some((m) => m.hash === 'hash-a' && m.reason === 'time-density'));

    check('a file resolves to no trip while the cluster is only proposed',
      db.approvedTripForHash('hash-a') === null);
    db.setTripClusterStatus('trip-1', 'approved');
    check('and resolves once the cluster is approved — the resolver lib/sort-engine.js will mirror',
      db.approvedTripForHash('hash-a')?.id === 'trip-1');
    check('a hash never added to any cluster resolves to nothing',
      db.approvedTripForHash('hash-nowhere') === null);

    // Re-clustering supersedes rather than mutating: a second, later cluster
    // pointing back at the first via supersedesId, with the first cluster's
    // own row left untouched until the new one is itself approved.
    const superseding = db.createTripCluster({
      id: 'trip-1b', status: 'proposed', startsAt: '2026-08-01T00:00:00Z', endsAt: '2026-08-02T00:00:00Z',
      cameraSet: ['DJI FC3582'], supersedesId: 'trip-1',
    });
    check('a superseding cluster records what it supersedes', superseding.supersedesId === 'trip-1');
    check('the original cluster is untouched until the supersession is itself approved',
      db.getTripCluster('trip-1').status === 'approved');

    check('listTripClusters filters by status',
      db.listTripClusters('proposed').length === 1 && db.listTripClusters('approved').length === 1);

    db.upsertInferredLocation('hash-c', 32.5, 77.5, 'gps-interpolation', 0.9);
    const loc = db.getInferredLocation('hash-c');
    check('an inferred location round-trips', loc.lat === 32.5 && loc.method === 'gps-interpolation');
    check('a hash never interpolated has no inferred location', db.getInferredLocation('hash-nope') === null);

    const correction = db.createCameraCorrection({
      id: 'corr-1', cameraMake: 'DJI', cameraModel: 'FC3582', offsetSeconds: 3600,
      effectiveFrom: '2026-08-01', effectiveTo: '2026-08-04', status: 'proposed',
      evidenceCount: 6, sampleCount: 15,
    });
    check('a proposed correction is not yet in force',
      db.approvedCorrectionFor('DJI', 'FC3582', '2026-08-02') === null, correction.id);
    db.setCameraCorrectionStatus('corr-1', 'approved');
    check('an approved correction covering the instant is found',
      db.approvedCorrectionFor('DJI', 'FC3582', '2026-08-02')?.offset_seconds === 3600);
    check('the same correction does not apply outside its effective range',
      db.approvedCorrectionFor('DJI', 'FC3582', '2026-09-01') === null);
    check('and never applies to a different camera model',
      db.approvedCorrectionFor('DJI', 'Osmo Action 4', '2026-08-02') === null);
    // A plain file object with no cameraMake/cameraModel property at all
    // (as opposed to one explicitly set to null) has `undefined` there —
    // node:sqlite's parameter binding throws on `undefined` rather than
    // treating it as SQL NULL, unlike every other optional field here.
    check('undefined camera fields (an absent property, not an explicit null) do not throw',
      (() => {
        try { return db.approvedCorrectionFor(undefined, undefined, '2026-08-02') === null; } catch { return false; }
      })());

    db.upsertContentTags('hash-a', 'moondream2', ['tent', 'motorcycle', 'campfire']);
    check('content tags round-trip as a real array, not a JSON string',
      Array.isArray(db.getContentTags('hash-a', 'moondream2'))
      && db.getContentTags('hash-a', 'moondream2').includes('tent'));
    check('a hash never tagged under this model returns null — Discovery\'s signal to tag it live, not "no tags"',
      db.getContentTags('hash-a', 'some-other-model') === null);

    const proposal = db.createProposal({
      id: 'prop-1', kind: 'trip_cluster', subjectId: 'trip-1b',
      ast: { type: 'trip_cluster', clusterId: 'trip-1b' }, summary: 'A 3-day cluster across 1 camera',
    });
    check('a proposal starts pending', proposal.status === 'pending');
    check('and carries its AST as a real object', proposal.ast.clusterId === 'trip-1b');
    check('it shows up in the pending queue', db.listProposals('pending').some((p) => p.id === 'prop-1'));
    db.setProposalStatus('prop-1', 'approved');
    check('approving moves it out of pending and into approved',
      !db.listProposals('pending').some((p) => p.id === 'prop-1')
      && db.listProposals('approved').some((p) => p.id === 'prop-1'));
    check('a decidedAt timestamp is stamped on the decision', db.getProposal('prop-1').decidedAt !== null);

    db.upsert(entry({ relPath: '/dated.jpg', hash: 'hash-dated', capturedAt: '2026-08-01T10:00:00.000Z' }));
    db.upsert(entry({ relPath: '/no-date.jpg', hash: 'hash-nodate', capturedAt: null }));
    const clusterable = db.filesForClustering();
    check('filesForClustering includes hashed, dated files, mapped through dbRowToResult like every other reader',
      clusterable.some((f) => f.path === '/dated.jpg' && f.hash === 'hash-dated'));
    check('and excludes files with no capture time at all — nothing to cluster them by',
      !clusterable.some((f) => f.path === '/no-date.jpg'));

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
