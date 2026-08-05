/**
 * Volume identification: the round trip that lets a library location survive
 * its drive coming back as a different letter.
 *
 *   node test/volumes.mjs
 */

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const volumes = require(path.join(here, '..', 'lib', 'volumes.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

// --- enumeration -----------------------------------------------------------

const list = volumes.list({ fresh: true });
check('at least one volume is found', list.length > 0, `${list.length}`);
check('every volume reports a mount point',
  list.every((v) => typeof v.mountPoint === 'string' && v.mountPoint.length > 0));
check('every volume reports a removable flag',
  list.every((v) => typeof v.removable === 'boolean'));

// Identification is the point; a platform that cannot do it falls back to
// plain paths, which is a real degradation worth noticing rather than
// asserting away.
const identified = list.filter((v) => v.id);
if (identified.length === 0) {
  console.log('  NOTE  this platform reports no volume ids — locations will fall back to plain paths');
} else {
  check('volumes carry a stable id', identified.length > 0, `${identified.length}/${list.length}`);
  check('volume ids are unique',
    new Set(identified.map((v) => v.id)).size === identified.length);
}

// --- caching ---------------------------------------------------------------
// Enumeration shells out and is slow; anything polling it needs the cache.

volumes._clearCache();
const coldStart = Date.now();
volumes.list();
const coldMs = Date.now() - coldStart;

const warmStart = Date.now();
volumes.list();
const warmMs = Date.now() - warmStart;

check('a repeat call is served from cache', warmMs <= Math.max(5, coldMs / 4),
  `cold ${coldMs}ms, warm ${warmMs}ms`);
check('fresh: true bypasses the cache', volumes.list({ fresh: true }).length === list.length);

// --- identify --------------------------------------------------------------

const cwdVolume = volumes.identify(process.cwd());
if (identified.length > 0) {
  check('the current directory resolves to a volume', Boolean(cwdVolume), String(cwdVolume));
  check('and that volume is one of the enumerated ones',
    !cwdVolume || list.some((v) => v.mountPoint === cwdVolume.mountPoint));
}

check('an unattached volume id is reported as absent',
  volumes.findById('\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\') === null);
check('a null id is not treated as a match', volumes.findById(null) === null);

// --- the round trip that matters -------------------------------------------
// Describe a real path, then resolve it back the way a stored location would
// be resolved after a replug. Getting the same path back is the whole reason
// this module exists.

const described = volumes.describeLocation(process.cwd());
check('describeLocation reports a path', described.path === path.resolve(process.cwd()));

if (described.volumeId) {
  check('describeLocation records the volume id and a path within it',
    Boolean(described.volumeId) && typeof described.relativePath === 'string',
    JSON.stringify({ id: described.volumeId, rel: described.relativePath }));

  const resolved = volumes.resolveLocation(described);
  check('resolveLocation finds the volume again', Boolean(resolved));
  check('and returns the identical path',
    resolved && path.resolve(resolved.path) === path.resolve(process.cwd()),
    `${resolved?.path} vs ${process.cwd()}`);
  check('and reports the location as present', resolved?.present === true);

  // The failure that matters: the drive is not plugged in.
  const missing = volumes.resolveLocation({
    volumeId: '\\\\?\\Volume{deadbeef-0000-0000-0000-000000000000}\\',
    relativePath: 'Photos',
  });
  check('a location on an absent volume resolves to null, not a wrong path',
    missing === null);
} else {
  console.log('  NOTE  no volume id for the current directory — round trip skipped on this platform');
}

// --- temp directory, as a second real path ---------------------------------

const tempDescribed = volumes.describeLocation(os.tmpdir());
check('a second real path also describes cleanly',
  tempDescribed.path === path.resolve(os.tmpdir()));

if (tempDescribed.volumeId && described.volumeId) {
  const sameVolume = tempDescribed.volumeId === described.volumeId;
  console.log(`  NOTE  temp and project are on ${sameVolume ? 'the same' : 'different'} volumes`);
  if (!sameVolume) {
    check('two paths on different volumes get different ids', true);
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
