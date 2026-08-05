/**
 * Albums living on other drives.
 *
 * The important case is a real cross-volume relocation, so where this machine
 * has a second drive the test uses it rather than simulating one — that is
 * the path that actually copies bytes, verifies them, and swaps in a link.
 *
 *   node test/locations.mjs
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const locations = require(path.join(here, '..', 'lib', 'locations.js'));
const volumes = require(path.join(here, '..', 'lib', 'volumes.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

async function expectReject(name, fn, matcher = /./) {
  try {
    await fn();
    check(name, false, 'expected it to throw, but it resolved');
  } catch (err) {
    check(name, matcher.test(err.message), `threw: ${err.message}`);
  }
}

const roots = [];
function tempDir(prefix, base) {
  const dir = mkdtempSync(path.join(base || tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/**
 * Somewhere on a *different* volume than the library, if this machine has
 * one. On the machine this was written for, temp is on C: and the project on
 * D:, so a genuine cross-drive move gets exercised.
 */
function otherVolumeBase() {
  const all = volumes.list({ fresh: true }).filter((v) => v.id && existsSync(v.mountPoint));
  const tempVolume = volumes.identify(tmpdir());
  const other = all.find((v) => v.id !== tempVolume?.id);
  if (!other) return null;
  // Somewhere writable at the root of that volume.
  const candidate = path.join(other.mountPoint, 'lanshare-location-test');
  try {
    mkdirSync(candidate, { recursive: true });
    roots.push(candidate);
    return candidate;
  } catch {
    return null;
  }
}

const library = tempDir('lanshare-lib-');
const config = { locations: [] };

const ALBUM_FILES = {
  'photo.jpg': 'x'.repeat(500),
  'Sub/nested.txt': 'nested content here',
};

function makeAlbum(dir) {
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(ALBUM_FILES)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

try {
  // --- registering locations ------------------------------------------------

  const externalBase = otherVolumeBase();
  const localBase = tempDir('lanshare-loc-');
  const target = externalBase || localBase;
  if (externalBase) {
    console.log(`  NOTE  using a genuinely different volume for the move: ${externalBase}`);
  } else {
    console.log('  NOTE  only one volume available — the move runs same-volume');
  }

  const added = locations.add(config, { label: 'Backup', targetPath: target });
  check('a location can be registered', Boolean(added.id));
  check('it records the volume it is on, not just the path',
    Boolean(added.volumeId) || process.platform !== 'win32',
    JSON.stringify({ volumeId: added.volumeId }));

  const listed = locations.list(config);
  check('the location is listed as attached', listed[0]?.attached === true);
  check('and reports where it is right now', listed[0]?.path === path.resolve(target));

  expectRejectSync('a duplicate name is refused',
    () => locations.add(config, { label: 'Backup', targetPath: localBase }), /already exists/i);
  expectRejectSync('the same folder twice is refused',
    () => locations.add(config, { label: 'Other', targetPath: target }), /already a location/i);
  expectRejectSync('a folder that does not exist is refused',
    () => locations.add(config, { label: 'Ghost', targetPath: path.join(localBase, 'nope') }),
    /does not exist/i);

  // --- relocating an album --------------------------------------------------

  makeAlbum(path.join(library, 'Holiday'));
  const originalPhoto = readFileSync(path.join(library, 'Holiday', 'photo.jpg'), 'utf8');

  const moved = await locations.relocateAlbum(library, config, 'Holiday', added.id);
  check('the album relocates', moved.name === 'Holiday', JSON.stringify(moved));

  const linkPath = path.join(library, 'Holiday');
  check('what is left behind is a link, not a folder', lstatSync(linkPath).isSymbolicLink());
  check('the bytes really are on the other drive',
    existsSync(path.join(target, 'Holiday', 'photo.jpg')));

  // The whole point: every existing path keeps working through the link.
  check('the album still reads normally through the link',
    readFileSync(path.join(linkPath, 'photo.jpg'), 'utf8') === originalPhoto);
  check('nested files still read through the link',
    readFileSync(path.join(linkPath, 'Sub', 'nested.txt'), 'utf8') === ALBUM_FILES['Sub/nested.txt']);
  check('and it still lists as a directory',
    readdirSync(linkPath).sort().join(',') === 'Sub,photo.jpg');

  const described = locations.describeAlbum(library, config, 'Holiday');
  check('the album reports that it lives elsewhere', described.linked === true);
  check('and names the location it is on', described.location?.label === 'Backup', JSON.stringify(described.location));
  check('and reports the target as reachable', described.reachable === true);

  check('the location lists the album as living on it',
    locations.albumsOn(library, config, added.id).map((a) => a.name).join(',') === 'Holiday');

  // --- guards ---------------------------------------------------------------

  await expectReject('relocating an already-relocated album is refused',
    () => locations.relocateAlbum(library, config, 'Holiday', added.id), /already lives/i);

  await expectReject('relocating a non-existent album is refused',
    () => locations.relocateAlbum(library, config, 'NotThere', added.id), /does not exist/i);

  await expectReject('removing a location still holding albums is refused',
    async () => locations.remove(config, library, added.id), /bring these albums back/i);

  // --- bringing it home -----------------------------------------------------

  const home = await locations.bringAlbumHome(library, config, 'Holiday');
  check('the album comes back', home.name === 'Holiday');
  check('and is a real folder again, not a link', !lstatSync(linkPath).isSymbolicLink());
  check('with its contents intact',
    readFileSync(path.join(linkPath, 'photo.jpg'), 'utf8') === originalPhoto);
  check('and its nested files intact',
    readFileSync(path.join(linkPath, 'Sub', 'nested.txt'), 'utf8') === ALBUM_FILES['Sub/nested.txt']);
  check('the copy on the other drive is gone', !existsSync(path.join(target, 'Holiday')));

  await expectReject('bringing home an album that is already home is refused',
    () => locations.bringAlbumHome(library, config, 'Holiday'), /already lives in the library/i);

  // --- the location can now be removed --------------------------------------

  locations.remove(config, library, added.id);
  check('a location with no albums on it can be removed', locations.list(config).length === 0);

  // --- walking does not follow links ---------------------------------------
  // A link pointing at an ancestor would make a naive walk loop forever.

  const loopBase = tempDir('lanshare-loop-');
  makeAlbum(path.join(loopBase, 'Real'));
  locations.createLink(path.join(loopBase, 'Real', 'loop'), loopBase);
  const measured = await locations.measure(loopBase);
  check('measuring a tree containing a link back to itself terminates',
    measured.files === Object.keys(ALBUM_FILES).length, JSON.stringify(measured));

  // --- a dangling link is reported, not crashed on -------------------------

  const danglingBase = tempDir('lanshare-dangle-');
  const gone = path.join(danglingBase, 'gone');
  mkdirSync(gone);
  const danglingLib = tempDir('lanshare-danglib-');
  locations.createLink(path.join(danglingLib, 'Ghost'), gone);
  rmSync(gone, { recursive: true, force: true });

  const ghost = locations.describeAlbum(danglingLib, config, 'Ghost');
  check('an album whose drive is gone is reported as unreachable',
    ghost.linked === true && ghost.reachable === false, JSON.stringify(ghost));

  const repair = locations.repairLinks(danglingLib, config);
  check('repair reports the broken link rather than throwing',
    repair.broken.some((b) => b.name === 'Ghost'), JSON.stringify(repair));

  // --- a failed bring-home leaves nothing behind ---------------------------
  // Bringing an album home copies it into a hidden staging folder first. If
  // the swap then fails, that copy is as large as the album and invisible in
  // the gallery, so it has to be cleaned up rather than abandoned.

  const failBase = tempDir('lanshare-failhome-');
  const failLib = path.join(failBase, 'library');
  const failDrive = path.join(failBase, 'drive');
  mkdirSync(failLib);
  mkdirSync(failDrive);
  makeAlbum(path.join(failLib, 'Trip'));

  const failConfig = {};
  const failLoc = locations.add(failConfig, { label: 'Fail Drive', targetPath: failDrive });
  await locations.relocateAlbum(failLib, failConfig, 'Trip', failLoc.id);

  const [firstFile, firstContent] = Object.entries(ALBUM_FILES)[0];
  const fs = require('fs');
  const realRmdir = fs.rmdirSync;
  const realUnlink = fs.unlinkSync;
  fs.rmdirSync = () => { throw new Error('injected failure'); };
  fs.unlinkSync = () => { throw new Error('injected failure'); };
  let injected = null;
  try {
    await locations.bringAlbumHome(failLib, failConfig, 'Trip');
  } catch (err) {
    injected = err;
  } finally {
    fs.rmdirSync = realRmdir;
    fs.unlinkSync = realUnlink;
  }

  check('a failed bring-home reports the failure', injected !== null);
  check('and leaves no hidden staging copy behind',
    !readdirSync(failLib).some((n) => n.startsWith('.incoming-')), readdirSync(failLib).join(','));
  check('the album is still reachable on its old path',
    readFileSync(path.join(failLib, 'Trip', firstFile), 'utf8') === firstContent);
  check('and its real contents are still on the drive',
    existsSync(path.join(failDrive, 'Trip', firstFile)));

  // It must still be possible to finish the job once the fault clears.
  await locations.bringAlbumHome(failLib, failConfig, 'Trip');
  check('and it comes home once the fault clears',
    !locations.isLink(path.join(failLib, 'Trip'))
    && readFileSync(path.join(failLib, 'Trip', firstFile), 'utf8') === firstContent);
} finally {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
}

function expectRejectSync(name, fn, matcher) {
  try {
    fn();
    check(name, false, 'expected it to throw');
  } catch (err) {
    check(name, matcher.test(err.message), `threw: ${err.message}`);
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
