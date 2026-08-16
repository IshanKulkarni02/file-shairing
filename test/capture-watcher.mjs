/**
 * lib/capture-watcher.js: noticing a capture device the moment its volume
 * id turns up somewhere it was not a moment ago. lib/volumes.js's own
 * list() is monkey-patched, the same technique test/sync-watcher.mjs
 * already uses — there is no real OS drive to plug in during a test run.
 *
 *   node test/capture-watcher.mjs
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { CaptureWatcher } = require(path.join(here, '..', 'lib', 'capture-watcher.js'));
const { IndexDb } = require(path.join(here, '..', 'lib', 'index-db.js'));
const volumes = require(path.join(here, '..', 'lib', 'volumes.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

const realList = volumes.list;
let attached = [];
volumes.list = () => attached;

function makeCard(id, { withPhotos = true } = {}) {
  const mountPoint = mkdtempSync(path.join(tmpdir(), 'lanshare-capture-watcher-'));
  if (withPhotos) {
    mkdirSync(path.join(mountPoint, 'DCIM'));
    writeFileSync(path.join(mountPoint, 'DCIM', 'photo.jpg'), `bytes for ${id}`);
  }
  return { id, label: id, mountPoint, removable: true, sizeBytes: 0, freeBytes: 0 };
}

const dbDir = mkdtempSync(path.join(tmpdir(), 'lanshare-capture-watcher-db-'));
const indexDb = new IndexDb(path.join(dbDir, 'index.db'));
const config = { locations: [] };

const detections = [];
const watcher = new CaptureWatcher({
  getConfig: () => config,
  getIndexDb: () => indexDb,
  getLibraryVolumeId: () => 'VOL-LIBRARY',
  onDetected: (arrival) => detections.push(arrival),
  log: () => {},
  intervalMs: 100000, // never fires on its own timer during this test — every tick() call below is manual
});

try {
  const preExisting = makeCard('VOL-ALREADY-HERE');
  attached = [preExisting];
  watcher.start();
  await new Promise((r) => setTimeout(r, 20)); // let the async priming tick() settle

  check('a volume already attached when the watcher starts is not treated as an arrival',
    detections.length === 0);

  const newCard = makeCard('VOL-NEW-CARD');
  attached = [preExisting, newCard];
  await watcher.tick();
  check('a genuinely new volume with new photos is detected', detections.length === 1, JSON.stringify(detections));
  check('the detection names the right volume', detections[0]?.volume.id === 'VOL-NEW-CARD');
  check('and carries a real plan with the new file', detections[0]?.plan.candidates.length === 1);

  detections.length = 0;
  const emptyDrive = makeCard('VOL-EMPTY-DRIVE', { withPhotos: false });
  attached = [preExisting, newCard, emptyDrive];
  await watcher.tick();
  check('an ordinary drive with no DCIM folder produces no detection',
    detections.length === 0, JSON.stringify(detections));

  detections.length = 0;
  const libraryDrive = makeCard('VOL-LIBRARY');
  attached = [preExisting, newCard, emptyDrive, libraryDrive];
  await watcher.tick();
  check('the library\'s own volume arriving (e.g. after being unmounted and remounted) is never offered',
    detections.length === 0, JSON.stringify(detections));

  // The same physical card unplugged and replugged is a fresh arrival again.
  detections.length = 0;
  attached = [preExisting, emptyDrive, libraryDrive]; // newCard's volume goes away
  await watcher.tick();
  attached = [preExisting, newCard, emptyDrive, libraryDrive]; // and comes back
  await watcher.tick();
  check('unplugging and replugging the same card is detected again, not suppressed as "already seen"',
    detections.length === 1, JSON.stringify(detections));

  // Two different cards inserted between one tick and the next are both checked.
  detections.length = 0;
  const cardA = makeCard('VOL-SIMULTANEOUS-A');
  const cardB = makeCard('VOL-SIMULTANEOUS-B');
  attached = [preExisting, newCard, emptyDrive, libraryDrive, cardA, cardB];
  await watcher.tick();
  check('two cards that arrive on the same tick are both detected',
    detections.length === 2 && new Set(detections.map((d) => d.volume.id)).size === 2,
    JSON.stringify(detections));

  watcher.stop();
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error during the test run -> ${err.stack || err.message}`);
} finally {
  watcher.stop();
  volumes.list = realList;
  indexDb.close();
  rmSync(dbDir, { recursive: true, force: true });
  for (const v of attached) {
    if (v.mountPoint) rmSync(v.mountPoint, { recursive: true, force: true });
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
