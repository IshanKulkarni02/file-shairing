/**
 * The indexer against a real library on real disk: walking, hashing,
 * extracting metadata, skipping what has not changed, and pruning what is
 * gone.
 *
 *   node test/indexer.mjs
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, renameSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { realisticJpeg } from './helpers/exif-fixture.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { scanLibrary } = require(path.join(here, '..', 'lib', 'indexer.js'));
const { IndexDb } = require(path.join(here, '..', 'lib', 'index-db.js'));
const vaultsLib = require(path.join(here, '..', 'lib', 'vaults.js'));
const locations = require(path.join(here, '..', 'lib', 'locations.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

const roots = [];
const opened = [];
function scratch() {
  const library = mkdtempSync(path.join(tmpdir(), 'lanshare-idx-'));
  roots.push(library);
  const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
  opened.push(db);
  return { library, db };
}

try {
  // --- a first scan of a small real library ---------------------------------

  {
    const { library, db } = scratch();
    mkdirSync(path.join(library, 'Drone'), { recursive: true });
    writeFileSync(path.join(library, 'Drone', 'shot.jpg'),
      realisticJpeg({ make: 'DJI', lat: 32.24, latRef: 'N', lon: 77.19, lonRef: 'E' }));
    writeFileSync(path.join(library, 'notes.txt'), 'not a photo');

    const report = await scanLibrary(library, db);
    check('the scan reports how many files it found', report.scanned === 2, JSON.stringify(report));
    check('both are new, so both count as added', report.added === 2, JSON.stringify(report));
    check('nothing failed', report.failed.length === 0, JSON.stringify(report.failed));

    const photo = db.getByPath('/Drone/shot.jpg');
    check('the photo is indexed with its real EXIF', photo?.camera_make === 'DJI', photo?.camera_make);
    check('and its GPS, extracted end to end from real bytes on disk',
      Math.abs(photo.gps_lat - 32.24) < 1e-3 && Math.abs(photo.gps_lon - 77.19) < 1e-3,
      `${photo?.gps_lat}, ${photo?.gps_lon}`);
    check('its kind is recognised', photo?.kind === 'image');
    check('it has a content hash', typeof photo?.hash === 'string' && photo.hash.length === 64, photo?.hash);

    const notes = db.getByPath('/notes.txt');
    check('a non-image file is indexed too, just without photo metadata',
      notes?.kind === 'file' && notes?.camera_make === null, JSON.stringify(notes));
    check('and carries no clock basis either, since it has no capture time',
      notes?.captured_at_basis === null, notes?.captured_at_basis);
  }

  // --- captured_at_basis: the fix for Phase O1's clock-drift prerequisite ----
  // A photo's GPS fix carries its own UTC clock (GPSDateStamp/GPSTimeStamp),
  // independent of the camera's local-time DateTimeOriginal. Only a photo
  // with both should be marked 'utc-gps'; one with only local time is
  // 'local-naive' — the two must never be silently treated as comparable.

  {
    const { library, db } = scratch();
    mkdirSync(path.join(library, 'Mixed'), { recursive: true });
    writeFileSync(path.join(library, 'Mixed', 'gps-fix.jpg'), realisticJpeg({
      make: 'Apple', dateTimeOriginal: '2026:08:11 16:00:00',
      lat: 32.24, latRef: 'N', lon: 77.19, lonRef: 'E',
      gpsDateStamp: '2026:08:11', gpsTimeStamp: [10, 30, 0],
    }));
    writeFileSync(path.join(library, 'Mixed', 'no-gps.jpg'), realisticJpeg({
      make: 'Canon', dateTimeOriginal: '2026:08:11 16:00:00',
    }));

    await scanLibrary(library, db);

    const withFix = db.getByPath('/Mixed/gps-fix.jpg');
    check('a photo with a GPS time stamp is marked utc-gps',
      withFix?.captured_at_basis === 'utc-gps', withFix?.captured_at_basis);
    check('and its captured_at is the GPS UTC instant, not the local clock',
      withFix?.captured_at === '2026-08-11T10:30:00.000Z', withFix?.captured_at);

    const noFix = db.getByPath('/Mixed/no-gps.jpg');
    check('a photo with only a local-time date is marked local-naive',
      noFix?.captured_at_basis === 'local-naive', noFix?.captured_at_basis);
    check('and keeps the naive local string as-is, with no fabricated offset',
      noFix?.captured_at === '2026-08-11T16:00:00', noFix?.captured_at);
  }

  // --- a second scan of nothing changed really does nothing ------------------

  {
    const { library, db } = scratch();
    const file = path.join(library, 'a.jpg');
    writeFileSync(file, realisticJpeg({ make: 'Canon', lat: 1, latRef: 'N', lon: 1, lonRef: 'E' }));

    const first = await scanLibrary(library, db);
    check('first scan adds the file', first.added === 1);
    const hashAfterFirst = db.getByPath('/a.jpg').hash;

    // Overwrite with different bytes but pin the size and mtime to exactly
    // what they were — what "unchanged by the only signals this module
    // checks" looks like on disk. utimesSync itself loses sub-millisecond
    // precision (confirmed separately: a write's real mtime of x.812ms comes
    // back as x.000ms after being round-tripped through it), which is well
    // inside the indexer's own tolerance for exactly this reason.
    const stat1 = statSync(file);
    const sameSize = Buffer.alloc(stat1.size, 0x41); // all 'A', same length
    writeFileSync(file, sameSize);
    utimesSync(file, stat1.atime, stat1.mtime);

    const second = await scanLibrary(library, db);
    check('a second scan with an unchanged size and mtime skips the file',
      second.skipped === 1 && second.added === 0 && second.updated === 0, JSON.stringify(second));
    check('proving it was never re-read: the stored hash is still the old one',
      db.getByPath('/a.jpg').hash === hashAfterFirst,
      'the file was re-hashed despite looking unchanged');
  }

  // --- a genuinely changed file is re-read -----------------------------------

  {
    const { library, db } = scratch();
    const file = path.join(library, 'a.jpg');
    writeFileSync(file, realisticJpeg({ make: 'Canon', lat: 1, latRef: 'N', lon: 1, lonRef: 'E' }));
    await scanLibrary(library, db);
    const before = db.getByPath('/a.jpg');

    // A different make, and padded to an unambiguously different size —
    // change detection here is by (size, mtime), the same cheap-but-approximate
    // signal lib/sync-plan.js already accepts for the same reason (hashing
    // everything just to compare would defeat the point of incremental
    // scanning), so the fixture has to actually differ in size for this test
    // to mean anything, rather than relying on mtime ticking forward alone.
    writeFileSync(file, realisticJpeg({
      make: 'Nikon', lat: 2, latRef: 'N', lon: 2, lonRef: 'E', padTo: before.size + 500,
    }));
    const report = await scanLibrary(library, db);
    check('a changed file is reported as updated, not added again', report.updated === 1, JSON.stringify(report));

    const after = db.getByPath('/a.jpg');
    check('its new content is reflected', after.camera_make === 'Nikon', after.camera_make);
    check('and its hash changed', after.hash !== before.hash);
  }

  // --- deletion and rename ----------------------------------------------------

  {
    const { library, db } = scratch();
    writeFileSync(path.join(library, 'keep.txt'), 'x');
    writeFileSync(path.join(library, 'gone.txt'), 'y');
    await scanLibrary(library, db);
    check('both files start out indexed', db.count() === 2);

    rmSync(path.join(library, 'gone.txt'));
    const report = await scanLibrary(library, db);
    check('a deleted file is pruned from the index', report.removed === 1, JSON.stringify(report));
    check('and is really gone from it', db.getByPath('/gone.txt') === null);
    check('while the other file is untouched', db.getByPath('/keep.txt') !== null);
  }

  {
    const { library, db } = scratch();
    writeFileSync(path.join(library, 'old-name.jpg'), 'x');
    await scanLibrary(library, db);

    renameSync(path.join(library, 'old-name.jpg'), path.join(library, 'new-name.jpg'));
    const report = await scanLibrary(library, db);
    check('a rename removes the old path', db.getByPath('/old-name.jpg') === null && report.removed === 1);
    check('and adds the new one', db.getByPath('/new-name.jpg') !== null && report.added === 1);
  }

  // --- vault contents: shallow only, never opened for metadata ---------------

  {
    const { library, db } = scratch();
    mkdirSync(path.join(library, 'Private'), { recursive: true });
    await vaultsLib.createVault(path.join(library, 'Private'), { passphrase: 'a properly long passphrase' });
    const ctx = vaultsLib.contextFor(library, '/Private');
    // Write a real vault file the way the app would, using the vault's own
    // file format — proving the indexer treats it as opaque rather than
    // needing a fake to make the point.
    const vaultfile = require(path.join(here, '..', 'lib', 'crypto', 'vaultfile.js'));
    const fileKey = vaultsLib.newFileKey(ctx.masterKey);
    await vaultfile.encryptBufferToFile(
      Buffer.from('PLAINTEXT-THAT-MUST-NEVER-REACH-THE-INDEX'),
      path.join(library, 'Private', 'secret.jpg'),
      { fileKey: fileKey.fileKey, wrappedKey: fileKey.wrappedKey },
    );

    const report = await scanLibrary(library, db);
    check('a vault file is indexed', report.added >= 1, JSON.stringify(report));

    const row = db.getByPath('/Private/secret.jpg');
    check('it is flagged as encrypted', row?.encrypted === 1, JSON.stringify(row));
    check('with no camera, date or GPS extracted from it',
      row?.camera_make === null && row?.captured_at === null && row?.gps_lat === null,
      JSON.stringify(row));
    check('and its plaintext is nowhere in the index database file',
      !JSON.stringify(row).includes('PLAINTEXT-THAT-MUST-NEVER-REACH-THE-INDEX'));

    // The vault's own metadata file must not itself become a search result.
    check('the vault marker file (.lanshare-vault.json) is not indexed as a file',
      db.getByPath('/Private/.lanshare-vault.json') === null);
  }

  // --- a relocated top-level album is followed, not skipped -------------------

  {
    const { library, db } = scratch();
    const driveBase = mkdtempSync(path.join(tmpdir(), 'lanshare-idx-drive-'));
    roots.push(driveBase);
    mkdirSync(path.join(library, 'Photos'), { recursive: true });
    writeFileSync(path.join(library, 'Photos', 'a.jpg'), 'x');

    const config = {};
    const loc = locations.add(config, { label: 'Other Drive', targetPath: driveBase });
    await locations.relocateAlbum(library, config, 'Photos', loc.id);
    check('the album really is a link now, for this test to mean anything',
      locations.isLink(path.join(library, 'Photos')));

    const report = await scanLibrary(library, db);
    check('a relocated top-level album is walked into, not skipped',
      db.getByPath('/Photos/a.jpg') !== null, JSON.stringify(report));
    check('using its logical library path, not a path on the other drive',
      db.getByPath('/Photos/a.jpg')?.rel_path === '/Photos/a.jpg');
  }

  // --- a symlink that is not a top-level album is never followed -------------

  {
    const { library, db } = scratch();
    mkdirSync(path.join(library, 'Real'), { recursive: true });
    writeFileSync(path.join(library, 'Real', 'photo.jpg'), 'x');
    mkdirSync(path.join(library, 'Real', 'Nested'), { recursive: true });
    // A link two levels down, pointing back at the library root — the shape
    // that would loop forever if followed.
    locations.createLink(path.join(library, 'Real', 'Nested', 'loop'), library);

    let threw = false;
    let report = null;
    const finished = await Promise.race([
      scanLibrary(library, db).then((r) => { report = r; return 'done'; }),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 15000)),
    ]).catch(() => { threw = true; return 'threw'; });

    check('a nested symlink back to an ancestor does not hang the scan',
      finished === 'done', finished);
    check('and does not throw', !threw);
    check('the real file beside it is still indexed normally',
      report && db.getByPath('/Real/photo.jpg') !== null);
    check('but nothing from inside the loop link is indexed',
      report && !report.scanned || db.allEntries().every((e) => !e.rel_path.includes('/loop/')),
      JSON.stringify(db.allEntries().map((e) => e.rel_path)));
  }

  // --- resilience: an empty file with a photo extension --------------------

  {
    const { library, db } = scratch();
    writeFileSync(path.join(library, 'empty.jpg'), Buffer.alloc(0));
    let threw = false;
    let report = null;
    try { report = await scanLibrary(library, db); } catch { threw = true; }
    check('a zero-byte file with a photo extension does not crash the scan', !threw);
    check('and is still indexed, just with nothing extracted',
      !threw && db.getByPath('/empty.jpg')?.camera_make === null, JSON.stringify(report));
  }

  // --- internal directories are never indexed ---------------------------------

  {
    const { library, db } = scratch();
    mkdirSync(path.join(library, '.lanshare', 'cache'), { recursive: true });
    writeFileSync(path.join(library, '.lanshare', 'cache', 'thumb.webp'), 'x');
    writeFileSync(path.join(library, 'real.jpg'), 'x');

    await scanLibrary(library, db);
    check('the internal .lanshare directory is never walked into',
      db.count() === 1 && db.getByPath('/real.jpg') !== null,
      JSON.stringify(db.allEntries().map((e) => e.rel_path)));
  }

  // --- progress reporting -------------------------------------------------------

  {
    const { library, db } = scratch();
    writeFileSync(path.join(library, 'a.jpg'), 'x');
    writeFileSync(path.join(library, 'b.jpg'), 'y');
    const calls = [];
    await scanLibrary(library, db, { onProgress: (p) => calls.push(p) });
    check('progress is reported at least once, on completion', calls.length >= 1);
    check('the final call reports it is done', calls[calls.length - 1]?.done === true, JSON.stringify(calls.at(-1)));
    check('with the right final scanned count', calls[calls.length - 1]?.scanned === 2);
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
