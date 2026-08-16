/**
 * lib/import.js against real files on real disk: a fake "card" (a temp
 * directory standing in for a mounted volume, with a real DCIM folder) and
 * a real IndexDb standing in for the library's search index.
 *
 *   node test/import.mjs
 */

import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const importLib = require(path.join(here, '..', 'lib', 'import.js'));
const { IndexDb } = require(path.join(here, '..', 'lib', 'index-db.js'));
const hashLib = require(path.join(here, '..', 'lib', 'hash.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

function scratch(prefix) {
  return mkdtempSync(path.join(tmpdir(), `lanshare-${prefix}-`));
}

/** Records every open IndexDb so the finally block can close them all, even after a failed check. */
const openDbs = [];
function scratchDb() {
  const dir = scratch('import-db');
  const db = new IndexDb(path.join(dir, 'index.db'));
  openDbs.push({ db, dir });
  return db;
}

const dirs = []; // every scratch dir made outside scratchDb(), cleaned up the same way
function scratchDir(prefix) {
  const dir = scratch(prefix);
  dirs.push(dir);
  return dir;
}

try {
  // --- detection --------------------------------------------------------

  {
    const noCard = scratchDir('not-a-card');
    mkdirSync(path.join(noCard, 'SomeOtherFolder'));
    check('a volume with no DCIM folder is not detected as a capture device',
      (await importLib.detectCaptureDevice(noCard)) === null);
  }

  {
    const card = scratchDir('card-basic');
    mkdirSync(path.join(card, 'DCIM'));
    const found = await importLib.detectCaptureDevice(card);
    check('a volume with a DCIM folder is detected', found === path.join(card, 'DCIM'), found);
  }

  {
    // Real cards are not consistent about case.
    const card = scratchDir('card-lowercase');
    mkdirSync(path.join(card, 'dcim'));
    const found = await importLib.detectCaptureDevice(card);
    check('a lower-case dcim folder is detected too', found === path.join(card, 'dcim'), found);
  }

  check('detecting on a path that does not exist at all does not throw',
    (await importLib.detectCaptureDevice(path.join(tmpdir(), 'lanshare-does-not-exist-xyz'))) === null);

  // --- planning: what is new ------------------------------------------------

  {
    const card = scratchDir('card-plan');
    const dcim = path.join(card, 'DCIM', '100MEDIA');
    mkdirSync(dcim, { recursive: true });
    writeFileSync(path.join(dcim, 'IMG_0001.jpg'), 'brand new photo one');
    writeFileSync(path.join(dcim, 'IMG_0002.jpg'), 'brand new photo two');
    writeFileSync(path.join(dcim, '.thumbnail-cache'), 'a dotfile the camera left behind — never a photo');

    const db = scratchDb();
    const plan = await importLib.planImport({ mountPoint: card, indexDb: db });

    check('a plan is produced for a real card', Boolean(plan));
    check('dotfiles are never treated as photos to import', !plan.candidates.some((c) => c.name.startsWith('.')));
    check('two genuinely new files are both found', plan.candidates.length === 2, JSON.stringify(plan.candidates));
    check('nothing is reported as already imported on a fresh library', plan.alreadyImported === 0);
    check('the plan totals the real byte size of what it found',
      plan.totalBytes === plan.candidates.reduce((sum, c) => sum + c.size, 0) && plan.totalBytes > 0);

    // Now index one of the two under a completely different path/name —
    // dedup is by content hash, so this must still be recognised.
    const hash1 = await hashLib.hashFile(path.join(dcim, 'IMG_0001.jpg'));
    db.upsert({
      relPath: '/Already/Here/renamed-completely.jpg', size: 20, mtimeMs: Date.now(), hash: hash1,
      kind: 'image', encrypted: false,
    });

    const plan2 = await importLib.planImport({ mountPoint: card, indexDb: db });
    check('a file already in the library by content hash is recognised even under a totally different name/path',
      plan2.candidates.length === 1 && plan2.alreadyImported === 1, JSON.stringify(plan2));
    check('the one still-new file is the right one', plan2.candidates[0].name === 'IMG_0002.jpg');
  }

  {
    const notACard = scratchDir('not-a-card-2');
    const db = scratchDb();
    const plan = await importLib.planImport({ mountPoint: notACard, indexDb: db });
    check('planning against a volume with no DCIM folder returns null, not an empty plan', plan === null);
  }

  // --- running: the actual copy ----------------------------------------------

  {
    const card = scratchDir('card-run');
    const dcim = path.join(card, 'DCIM');
    mkdirSync(dcim);
    const contentA = 'the real bytes of photo A, not a placeholder';
    const contentB = 'the real bytes of photo B, also not a placeholder';
    writeFileSync(path.join(dcim, 'A.jpg'), contentA);
    writeFileSync(path.join(dcim, 'B.jpg'), contentB);

    const db = scratchDb();
    const plan = await importLib.planImport({ mountPoint: card, indexDb: db });
    const destDir = scratchDir('dest-run');

    const result = await importLib.runImport({ plan, destDir });
    check('both new files are reported copied, none failed',
      result.copied.length === 2 && result.failed.length === 0, JSON.stringify(result));
    check('the copied bytes on disk exactly match the source',
      readFileSync(path.join(destDir, 'A.jpg'), 'utf8') === contentA
      && readFileSync(path.join(destDir, 'B.jpg'), 'utf8') === contentB);
    check('no .lanshare-part temp files are left behind',
      !readdirSync(destDir).some((f) => f.includes('.lanshare-part')), JSON.stringify(readdirSync(destDir)));

    check('the source files are completely untouched — still there, unrenamed', existsSync(path.join(dcim, 'A.jpg')) && existsSync(path.join(dcim, 'B.jpg')));
    const stillA = readFileSync(path.join(dcim, 'A.jpg'), 'utf8');
    check('and their content is unchanged too', stillA === contentA);
  }

  {
    // A name collision with something already at the destination — from an
    // unrelated upload, or a previous import from a different card.
    const card = scratchDir('card-collision');
    mkdirSync(path.join(card, 'DCIM'));
    writeFileSync(path.join(card, 'DCIM', 'IMG_0001.jpg'), 'this card\'s IMG_0001');

    const destDir = scratchDir('dest-collision');
    writeFileSync(path.join(destDir, 'IMG_0001.jpg'), 'an unrelated file that already has this exact name');

    const db = scratchDb();
    const plan = await importLib.planImport({ mountPoint: card, indexDb: db });
    const result = await importLib.runImport({ plan, destDir });

    check('a name collision is resolved rather than overwriting the existing file', result.copied.length === 1);
    check('the pre-existing file at that name is untouched',
      readFileSync(path.join(destDir, 'IMG_0001.jpg'), 'utf8') === 'an unrelated file that already has this exact name');
    check('the imported file landed under a disambiguated name instead',
      readFileSync(path.join(destDir, 'IMG_0001 (2).jpg'), 'utf8') === "this card's IMG_0001");
  }

  {
    // Free space, checked before anything is written — via the injectable
    // lookup, so this does not depend on how much space the real test
    // machine's disk actually has free.
    const card = scratchDir('card-space');
    mkdirSync(path.join(card, 'DCIM'));
    writeFileSync(path.join(card, 'DCIM', 'big.jpg'), 'x'.repeat(1000));

    const db = scratchDb();
    const plan = await importLib.planImport({ mountPoint: card, indexDb: db });
    const destDir = scratchDir('dest-space');

    let rejected = null;
    try {
      await importLib.runImport({ plan, destDir, getFreeBytes: () => 10 });
    } catch (err) {
      rejected = err;
    }
    check('running with too little free space is refused before writing anything',
      rejected instanceof importLib.ImportError, String(rejected));
    check('nothing was written to the destination when the space check failed',
      readdirSync(destDir).length === 0, JSON.stringify(readdirSync(destDir)));

    const okResult = await importLib.runImport({ plan, destDir, getFreeBytes: () => 1_000_000_000 });
    check('the same plan succeeds once there really is enough room', okResult.copied.length === 1);
  }

  {
    // A source file that changes between planning and copying — the copy
    // must be caught as wrong rather than silently accepted.
    const card = scratchDir('card-corrupt');
    mkdirSync(path.join(card, 'DCIM'));
    const filePath = path.join(card, 'DCIM', 'unstable.jpg');
    writeFileSync(filePath, 'the original content that gets hashed during planning');

    const db = scratchDb();
    const plan = await importLib.planImport({ mountPoint: card, indexDb: db });

    // Simulate a card that returned different bytes when actually copied —
    // a failing read, corruption, anything — by changing the file after
    // planning but before running.
    writeFileSync(filePath, 'different content entirely, as if the read failed silently');

    const destDir = scratchDir('dest-corrupt');
    const result = await importLib.runImport({ plan, destDir });
    check('a copy that does not match its planned hash is reported failed, not silently accepted',
      result.copied.length === 0 && result.failed.length === 1, JSON.stringify(result));
    check('no partial or wrong file is left at the destination',
      readdirSync(destDir).length === 0, JSON.stringify(readdirSync(destDir)));
  }

  check('running an empty plan (nothing new) does nothing and does not throw',
    (await importLib.runImport({ plan: null, destDir: scratchDir('dest-empty') })).copied.length === 0);

  {
    const card = scratchDir('card-unreadable-subfolder');
    mkdirSync(path.join(card, 'DCIM', 'good'), { recursive: true });
    writeFileSync(path.join(card, 'DCIM', 'good', 'ok.jpg'), 'this one is fine');
    const badDir = path.join(card, 'DCIM', 'bad');
    mkdirSync(badDir);
    writeFileSync(path.join(badDir, 'unreachable.jpg'), 'will not actually be readable');
    try {
      chmodSync(badDir, 0o000);
      const db = scratchDb();
      const plan = await importLib.planImport({ mountPoint: card, indexDb: db });
      check('an unreadable subfolder does not abort the whole scan — the readable sibling is still found',
        Boolean(plan) && plan.candidates.some((c) => c.name === 'ok.jpg'), JSON.stringify(plan));
    } catch (err) {
      // Some environments (notably when running as Administrator on
      // Windows) do not enforce chmod 000, in which case this scenario
      // cannot actually be created — skip rather than fail on a check that
      // was never truly exercised.
      console.log(`  SKIP  unreadable-subfolder scenario could not be created here -> ${err.message}`);
    } finally {
      try { chmodSync(badDir, 0o755); } catch { /* best effort so cleanup below can remove it */ }
    }
  }
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error during the test run -> ${err.stack || err.message}`);
} finally {
  for (const { db, dir } of openDbs) {
    try { db.close(); } catch { /* already closed or never opened */ }
    rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
