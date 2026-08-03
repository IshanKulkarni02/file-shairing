/**
 * lib/library.js: stats, same-volume detection, and moving a library.
 *
 * Runs entirely against throwaway temp directories — never against a real
 * config or library.
 *
 *   node test/library.mjs
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const lib = require(path.join(here, '..', 'lib', 'library.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

function makeLibrary(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

function readAll(dir, files) {
  return Object.fromEntries(
    Object.keys(files).map((rel) => [rel, readFileSync(path.join(dir, rel), 'utf8')]),
  );
}

const roots = [];
function tempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

const sampleFiles = {
  'photo.jpg': 'x'.repeat(1000),
  'Album/inner.txt': 'nested content',
  'Album/Deep/deep.txt': 'deeper still',
};

try {
  // --- getStats --------------------------------------------------------------

  const statsDir = tempDir('lanshare-stats-');
  makeLibrary(statsDir, sampleFiles);
  mkdirSync(path.join(statsDir, '.lanshare', 'thumbs'), { recursive: true });
  writeFileSync(path.join(statsDir, '.lanshare', 'thumbs', 'x.webp'), 'not counted');

  const stats = await lib.getStats(statsDir);
  check('getStats counts every real file', stats.files === 3, `got ${stats.files}`);
  check('getStats sums their bytes',
    stats.bytes === 1000 + 'nested content'.length + 'deeper still'.length, `got ${stats.bytes}`);
  check('getStats excludes the internal bookkeeping folder',
    !JSON.stringify(stats).includes('not counted'));

  const missing = await lib.getStats(path.join(statsDir, 'does-not-exist'));
  check('getStats on a missing folder returns zero, not an error', missing.files === 0 && missing.bytes === 0);

  // --- sameVolume --------------------------------------------------------------

  check('sameVolume: two paths on C: are the same volume',
    lib.sameVolume('C:\\Users\\someone\\a', 'C:\\Users\\someone\\b'));
  check('sameVolume: C: and D: are different volumes',
    !lib.sameVolume('C:\\Users\\someone\\a', 'D:\\projects\\b'));

  // --- isNestedOrSame ------------------------------------------------------

  check('isNestedOrSame: identical paths', lib.isNestedOrSame('/a/b', '/a/b'));
  check('isNestedOrSame: child is inside parent', lib.isNestedOrSame('/a/b', '/a/b/c'));
  check('isNestedOrSame: unrelated siblings are not nested', !lib.isNestedOrSame('/a/b', '/a/c'));

  // --- moveLibrary: same-volume rename --------------------------------------

  const renameSrc = tempDir('lanshare-rename-src-');
  makeLibrary(renameSrc, sampleFiles);
  const renameDst = path.join(tempDir('lanshare-rename-dst-'), 'moved');
  // The destination temp dir itself must not exist as a populated target —
  // moveLibrary creates it.
  rmSync(renameDst, { recursive: true, force: true });

  const renameResult = await lib.moveLibrary(renameSrc, renameDst, 'move');
  check('same-volume move reports the rename fast path', renameResult.mode === 'rename', JSON.stringify(renameResult));
  check('same-volume move leaves the source gone', !existsSync(renameSrc));
  check('same-volume move produces byte-identical content',
    JSON.stringify(readAll(renameDst, sampleFiles)) === JSON.stringify(sampleFiles));

  // --- moveLibrary: refuses a non-empty destination, source untouched --------

  const guardSrc = tempDir('lanshare-guard-src-');
  makeLibrary(guardSrc, sampleFiles);
  const guardDst = tempDir('lanshare-guard-dst-');
  writeFileSync(path.join(guardDst, 'already-here.txt'), 'do not overwrite me');

  let guardThrew = false;
  try {
    await lib.moveLibrary(guardSrc, guardDst, 'move');
  } catch (err) {
    guardThrew = err instanceof lib.LibraryError;
  }
  check('move refuses a non-empty destination', guardThrew);
  check('after the refusal, the source is completely untouched',
    existsSync(guardSrc) && JSON.stringify(readAll(guardSrc, sampleFiles)) === JSON.stringify(sampleFiles));
  check('after the refusal, the destination is untouched too',
    existsSync(path.join(guardDst, 'already-here.txt')) && !existsSync(path.join(guardDst, 'photo.jpg')));

  // --- moveLibrary: refuses nesting -----------------------------------------

  const nestSrc = tempDir('lanshare-nest-src-');
  makeLibrary(nestSrc, sampleFiles);

  let nestThrew = false;
  try {
    await lib.moveLibrary(nestSrc, path.join(nestSrc, 'Album'), 'move');
  } catch (err) {
    nestThrew = err instanceof lib.LibraryError;
  }
  check('move refuses relocating into its own subfolder', nestThrew);
  check('after refusing to nest, the source is untouched', existsSync(nestSrc));

  // --- moveLibrary: "point" mode never touches the old files ------------------

  const pointSrc = tempDir('lanshare-point-src-');
  makeLibrary(pointSrc, sampleFiles);
  const pointDst = path.join(tempDir('lanshare-point-dst-'), 'elsewhere');
  rmSync(pointDst, { recursive: true, force: true });

  const pointResult = await lib.moveLibrary(pointSrc, pointDst, 'point');
  check('"point" mode reports nothing was moved', pointResult.moved === false);
  check('"point" mode leaves the old files exactly where they were',
    existsSync(pointSrc) && existsSync(path.join(pointSrc, 'photo.jpg')));
  check('"point" mode creates the new empty location', existsSync(pointDst));

  // --- moveLibrary: a genuine cross-volume move, if this machine has one -----
  // D:\ exists on this machine and system temp is on C:\, so this is a real
  // cross-volume copy, not a simulation.

  const systemTempIsOnC = tmpdir().toLowerCase().startsWith('c:');
  const hasDDrive = existsSync('D:\\');

  if (systemTempIsOnC && hasDDrive) {
    const crossSrc = tempDir('lanshare-cross-src-');
    makeLibrary(crossSrc, sampleFiles);
    const crossDst = path.join('D:\\', `lanshare-cross-test-${Date.now()}`);

    check('cross-volume source and destination are really on different volumes',
      !lib.sameVolume(crossSrc, crossDst));

    try {
      const crossResult = await lib.moveLibrary(crossSrc, crossDst, 'move');
      check('cross-volume move reports the copy path', crossResult.mode === 'copy', JSON.stringify(crossResult));
      check('cross-volume move leaves the source gone', !existsSync(crossSrc));
      check('cross-volume move produces byte-identical content',
        JSON.stringify(readAll(crossDst, sampleFiles)) === JSON.stringify(sampleFiles));
    } finally {
      rmSync(crossDst, { recursive: true, force: true });
    }
  } else {
    console.log('  SKIP  cross-volume move (this machine has no second drive to test against)');
  }

  // --- cache and trash clearing ------------------------------------------------

  const cacheDir = tempDir('lanshare-cache-');
  mkdirSync(path.join(cacheDir, '.lanshare', 'thumbs', 'ab'), { recursive: true });
  writeFileSync(path.join(cacheDir, '.lanshare', 'thumbs', 'ab', 'x.webp'), 'thumb');
  mkdirSync(path.join(cacheDir, '.lanshare', 'trash', '123'), { recursive: true });
  writeFileSync(path.join(cacheDir, '.lanshare', 'trash', '123', 'deleted.jpg'), 'gone');

  const cacheFreed = await lib.clearThumbnailCache(cacheDir);
  check('clearThumbnailCache reports what it freed', cacheFreed.bytes === 'thumb'.length && cacheFreed.files === 1);
  check('clearThumbnailCache actually empties the folder',
    (await lib.getCacheStats(cacheDir)).files === 0);

  const trashFreed = await lib.emptyTrash(cacheDir);
  check('emptyTrash reports what it freed', trashFreed.bytes === 'gone'.length && trashFreed.files === 1);
  check('emptyTrash actually empties the folder', (await lib.getTrashStats(cacheDir)).files === 0);
} finally {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
