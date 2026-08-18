/**
 * lib/sort-engine.js against real files on real disk: planning a sort,
 * applying it, and undoing it.
 *
 *   node test/sort-engine.mjs
 */

import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const engine = require(path.join(here, '..', 'lib', 'sort-engine.js'));
const sortRules = require(path.join(here, '..', 'lib', 'sort-rules.js'));
const { IndexDb } = require(path.join(here, '..', 'lib', 'index-db.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

function scratchLibrary() {
  return mkdtempSync(path.join(tmpdir(), 'lanshare-sort-engine-'));
}

function putFile(library, relPath, content = 'x') {
  const abs = path.join(library, ...relPath.split('/').filter(Boolean));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

// --- plan(): matching, non-matching, and already-in-place -------------------

{
  const library = scratchLibrary();
  try {
    sortRules.saveRulesText(library, 'when camera.make = "DJI" -> /Drone/{year}');
    putFile(library, '/Inbox/a.jpg');
    putFile(library, '/Inbox/b.jpg');
    putFile(library, '/Drone/2026/already-here.jpg');

    const entries = [
      { path: '/Inbox/a.jpg', name: 'a.jpg', cameraMake: 'DJI', capturedAt: '2026-03-15T00:00:00' },
      { path: '/Inbox/b.jpg', name: 'b.jpg', cameraMake: 'Canon', capturedAt: '2026-03-15T00:00:00' },
      { path: '/Drone/2026/already-here.jpg', name: 'already-here.jpg', cameraMake: 'DJI', capturedAt: '2026-01-01T00:00:00' },
    ];
    const result = await engine.plan({ library, entries });

    check('a matching file is planned to move', result.moves.some((m) => m.path === '/Inbox/a.jpg' && m.destinationAlbum === '/Drone/2026'), JSON.stringify(result.moves));
    check('a non-matching file is reported unmatched, not planned to move',
      result.unmatched.includes('/Inbox/b.jpg') && !result.moves.some((m) => m.path === '/Inbox/b.jpg'));
    check('a file already exactly where its rule would put it is left out of the plan entirely',
      !result.moves.some((m) => m.path === '/Drone/2026/already-here.jpg'), JSON.stringify(result.moves));
    check('the plan reports how many rules were active', result.ruleCount === 1);
  } finally {
    rmSync(library, { recursive: true, force: true });
  }
}

// --- apply(): files actually move, a batch is recorded ----------------------

{
  const library = scratchLibrary();
  try {
    const fromAbs = putFile(library, '/Inbox/photo.jpg', 'real bytes');
    const result = await engine.apply({
      library,
      moves: [{ path: '/Inbox/photo.jpg', name: 'photo.jpg', destinationAlbum: '/Drone/2026' }],
    });

    check('the move is reported successful', result.moved.length === 1 && result.failed.length === 0, JSON.stringify(result));
    check('the file no longer exists at its old path', !existsSync(fromAbs));
    const toAbs = path.join(library, 'Drone', '2026', 'photo.jpg');
    check('the file exists at the new path with its content intact',
      existsSync(toAbs) && readFileSync(toAbs, 'utf8') === 'real bytes');

    const batches = engine.loadBatches(library);
    check('a batch was recorded', batches.length === 1 && batches[0].moved.length === 1, JSON.stringify(batches));
    check('the batch records exactly the from/to that happened',
      batches[0].moved[0].from === '/Inbox/photo.jpg' && batches[0].moved[0].to === '/Drone/2026/photo.jpg');
  } finally {
    rmSync(library, { recursive: true, force: true });
  }
}

// --- apply(): a name collision at the destination is disambiguated, not overwritten --

{
  const library = scratchLibrary();
  try {
    putFile(library, '/Inbox/photo.jpg', 'the one being moved');
    putFile(library, '/Drone/2026/photo.jpg', 'an unrelated file already there');

    const result = await engine.apply({
      library,
      moves: [{ path: '/Inbox/photo.jpg', name: 'photo.jpg', destinationAlbum: '/Drone/2026' }],
    });

    check('the move still succeeds despite the name collision', result.moved.length === 1, JSON.stringify(result));
    check('the pre-existing file at that name is untouched',
      readFileSync(path.join(library, 'Drone', '2026', 'photo.jpg'), 'utf8') === 'an unrelated file already there');
    check('the moved file landed under a disambiguated name',
      readFileSync(path.join(library, 'Drone', '2026', 'photo (2).jpg'), 'utf8') === 'the one being moved');
    check('the batch correctly records the disambiguated destination, not the original name',
      engine.loadBatches(library)[0].moved[0].to === '/Drone/2026/photo (2).jpg');
  } finally {
    rmSync(library, { recursive: true, force: true });
  }
}

// --- apply(): a move that cannot happen is reported failed, not thrown ------

{
  const library = scratchLibrary();
  try {
    // No such source file at all.
    const result = await engine.apply({
      library,
      moves: [{ path: '/Inbox/does-not-exist.jpg', name: 'does-not-exist.jpg', destinationAlbum: '/Somewhere' }],
    });
    check('a move whose source does not exist is reported failed, not thrown', result.failed.length === 1 && result.moved.length === 0, JSON.stringify(result));
    check('no batch is recorded when nothing actually moved', engine.loadBatches(library).length === 0);
  } finally {
    rmSync(library, { recursive: true, force: true });
  }
}

// --- undoLastBatch(): restores files, removes the batch once fully undone ----

{
  const library = scratchLibrary();
  try {
    putFile(library, '/Inbox/one.jpg', 'one');
    putFile(library, '/Inbox/two.jpg', 'two');
    await engine.apply({
      library,
      moves: [
        { path: '/Inbox/one.jpg', name: 'one.jpg', destinationAlbum: '/Sorted' },
        { path: '/Inbox/two.jpg', name: 'two.jpg', destinationAlbum: '/Sorted' },
      ],
    });
    check('both files really did move', existsSync(path.join(library, 'Sorted', 'one.jpg')) && existsSync(path.join(library, 'Sorted', 'two.jpg')));

    const undone = await engine.undoLastBatch({ library });
    check('undo reports both files restored', undone.restored.length === 2 && undone.failed.length === 0, JSON.stringify(undone));
    check('both files are back at their original paths',
      existsSync(path.join(library, 'Inbox', 'one.jpg')) && existsSync(path.join(library, 'Inbox', 'two.jpg')));
    check('and gone from the sorted destination', !existsSync(path.join(library, 'Sorted', 'one.jpg')) && !existsSync(path.join(library, 'Sorted', 'two.jpg')));
    check('the fully-undone batch is removed from history', engine.loadBatches(library).length === 0);

    let rejected = null;
    try { await engine.undoLastBatch({ library }); } catch (err) { rejected = err; }
    check('undoing again with nothing left to undo is refused clearly',
      rejected instanceof engine.SortEngineError, String(rejected));
  } finally {
    rmSync(library, { recursive: true, force: true });
  }
}

// --- undoLastBatch(): a blocked restore is partial, not all-or-nothing -------

{
  const library = scratchLibrary();
  try {
    putFile(library, '/Inbox/only.jpg', 'the moved file');
    await engine.apply({
      library,
      moves: [{ path: '/Inbox/only.jpg', name: 'only.jpg', destinationAlbum: '/Sorted' }],
    });

    // Something new now occupies the original spot — undo must not clobber it.
    putFile(library, '/Inbox/only.jpg', 'a different file that showed up later');

    const undone = await engine.undoLastBatch({ library });
    check('the blocked restore is reported failed, not silently skipped or forced',
      undone.restored.length === 0 && undone.failed.length === 1, JSON.stringify(undone));
    check('the file that showed up later at the original path is untouched',
      readFileSync(path.join(library, 'Inbox', 'only.jpg'), 'utf8') === 'a different file that showed up later');
    check('the moved file is still at its sorted location, not lost',
      readFileSync(path.join(library, 'Sorted', 'only.jpg'), 'utf8') === 'the moved file');
    check('the batch stays in history, since it is not fully undone yet', engine.loadBatches(library).length === 1);
  } finally {
    rmSync(library, { recursive: true, force: true });
  }
}

// --- a plan referencing a "gps near" place, geocoded through a real cache write --

{
  const library = scratchLibrary();
  try {
    sortRules.saveRulesText(library, 'when gps near "Testville" -> /Rides/Testville');
    // Pre-seed the geocode cache so this test needs no real network call —
    // resolveMany() only skips the network for what is already cached.
    const geocode = require(path.join(here, '..', 'lib', 'geocode.js'));
    geocode.saveCache(library, { testville: { lat: 10, lon: 20 } });

    const entries = [{ path: '/Inbox/ride.jpg', name: 'ride.jpg', gpsLat: 10.01, gpsLon: 20.01, capturedAt: null }];
    const result = await engine.plan({ library, entries });
    check('a plan resolves a "gps near" rule using the on-disk geocode cache, no network needed',
      result.moves.length === 1 && result.moves[0].destinationAlbum === '/Rides/Testville', JSON.stringify(result));
  } finally {
    rmSync(library, { recursive: true, force: true });
  }
}

// --- nothing is written outside the library, whatever apply() is handed ----
// apply() accepts a person-edited subset of a plan's moves, not only what
// plan() produced, so containment lives in the one function every read and
// write here goes through rather than only at the parser. This hands it a
// move the parser would now never produce, to prove the backstop is real.

{
  const library = scratchLibrary();
  const outside = path.join(library, '..', `escaped-by-engine-${Date.now().toString(36)}`);
  try {
    mkdirSync(path.join(library, 'Album'), { recursive: true });
    writeFileSync(path.join(library, 'Album', 'only-copy.jpg'), 'the one and only copy');

    const batch = await engine.apply({
      library,
      moves: [{
        path: '/Album/only-copy.jpg',
        name: 'only-copy.jpg',
        destinationAlbum: `/../${path.basename(outside)}`,
      }],
    });

    check('a move aimed outside the library is refused, not performed',
      batch.moved.length === 0 && batch.failed.length === 1, JSON.stringify(batch));
    check('and the refusal says why',
      /outside the library/.test(batch.failed[0]?.error || ''), batch.failed[0]?.error);
    check('nothing was written outside the library', !existsSync(outside));
    check('and the original file is untouched where it started',
      readFileSync(path.join(library, 'Album', 'only-copy.jpg'), 'utf8') === 'the one and only copy');
  } finally {
    rmSync(library, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

// --- Phase O1: trip and clock-drift resolution, via a real IndexDb ---------
// plan()'s `db` option is what makes {trip}/"when trip = ..." and drift
// correction actually work end to end — tripFor() and correctedCapturedAt()
// mirror resolvedGeocoder()'s shape (lib/sort-engine.js), resolved fresh
// from the index rather than stored anywhere, so this exercises the whole
// path: an approved trip_clusters/camera_corrections row in a real database
// through to the destination plan() actually produces.

{
  const library = scratchLibrary();
  const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
  try {
    sortRules.saveRulesText(library, 'when trip = "Motocamping_Nov" -> /Rides/{trip}/{camera}');
    putFile(library, '/Inbox/trip.jpg');
    putFile(library, '/Inbox/no-trip.jpg');

    db.createTripCluster({
      id: 'c1', label: 'Motocamping_Nov', status: 'proposed',
      startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-11-04T00:00:00Z',
      cameraSet: ['DJI FC3582'],
    });
    db.addTripClusterMember('c1', 'hash-trip', 'time-density');

    const entries = [
      { path: '/Inbox/trip.jpg', name: 'trip.jpg', hash: 'hash-trip', cameraModel: 'FC3582', capturedAt: '2026-11-02T00:00:00' },
      { path: '/Inbox/no-trip.jpg', name: 'no-trip.jpg', hash: 'hash-other', cameraModel: 'FC3582', capturedAt: '2026-11-02T00:00:00' },
    ];

    const beforeApproval = await engine.plan({ library, entries, db });
    check('a file in a cluster that is only proposed, not yet approved, does not match a trip= rule',
      !beforeApproval.moves.some((m) => m.path === '/Inbox/trip.jpg'), JSON.stringify(beforeApproval));

    db.setTripClusterStatus('c1', 'approved');
    const afterApproval = await engine.plan({ library, entries, db });
    check('once the cluster is approved, the file resolves to its trip and the rule matches',
      afterApproval.moves.some((m) => m.path === '/Inbox/trip.jpg' && m.destinationAlbum === '/Rides/Motocamping_Nov/FC3582'),
      JSON.stringify(afterApproval.moves));
    check('a file never added to any cluster still does not match, even after the other one is approved',
      !afterApproval.moves.some((m) => m.path === '/Inbox/no-trip.jpg'), JSON.stringify(afterApproval.moves));

    check('plan() without a db option at all still works exactly as before — trips just never match',
      (await engine.plan({ library, entries })).moves.length === 0);
  } finally {
    db.close();
    rmSync(library, { recursive: true, force: true });
  }
}

{
  const library = scratchLibrary();
  const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
  try {
    // "date =" matches a *local* calendar day (see sort-rules.js's
    // capturedDateOnly), so the corrected day is computed the same way here
    // — with local Date methods — rather than hardcoded, so this test is
    // correct under whatever timezone actually runs it. The 25-hour offset
    // (deliberately more than a full day) guarantees the local calendar date
    // advances by at least one regardless of timezone or DST, so raw and
    // corrected can never accidentally land on the same local day.
    const pad2 = (n) => String(n).padStart(2, '0');
    const localDateOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const rawInstant = new Date('2026-08-01T12:00:00.000Z'); // noon UTC — comfortably mid-day anywhere
    const offsetSeconds = 25 * 3600;
    const correctedInstant = new Date(rawInstant.getTime() + offsetSeconds * 1000);
    const correctedDate = localDateOf(correctedInstant);

    sortRules.saveRulesText(library, `when kind = image and date = "${correctedDate}" -> /Corrected`);
    putFile(library, '/Inbox/drift.jpg');

    db.createCameraCorrection({
      id: 'corr1', cameraMake: 'DJI', cameraModel: 'FC3582', offsetSeconds,
      effectiveFrom: '2026-08-01T00:00:00.000Z', effectiveTo: '2026-08-01T23:59:59.000Z',
      status: 'approved', evidenceCount: 6, sampleCount: 12,
    });

    const entries = [{
      path: '/Inbox/drift.jpg', name: 'drift.jpg', kind: 'image',
      cameraMake: 'DJI', cameraModel: 'FC3582', capturedAt: rawInstant.toISOString(),
    }];

    const result = await engine.plan({ library, entries, db });
    check('a file from a drifting camera is matched against its corrected date, not its raw one',
      result.moves.some((m) => m.path === '/Inbox/drift.jpg' && m.destinationAlbum === '/Corrected'),
      JSON.stringify(result));

    const noDb = await engine.plan({ library, entries });
    check('without db, no correction is applied and the raw (uncorrected) date does not match',
      noDb.moves.length === 0, JSON.stringify(noDb));
  } finally {
    db.close();
    rmSync(library, { recursive: true, force: true });
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
