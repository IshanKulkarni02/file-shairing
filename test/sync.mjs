/**
 * Running a sync against real files.
 *
 * lib/sync-plan.js is tested exhaustively on its own; this covers the half
 * that touches disk — that copies preserve what they must, that deletions are
 * recoverable, that encrypted files are never opened, and that a drive pulled
 * mid-run leaves both sides intact.
 *
 *   node test/sync.mjs
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, readdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const sync = require(path.join(here, '..', 'lib', 'sync.js'));
const vaultfile = require(path.join(here, '..', 'lib', 'crypto', 'vaultfile.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

const roots = [];
function scratch() {
  const base = mkdtempSync(path.join(tmpdir(), 'lanshare-sync-'));
  roots.push(base);
  const library = path.join(base, 'library');
  const source = path.join(library, 'Album');
  const target = path.join(base, 'drive', 'Album');
  mkdirSync(source, { recursive: true });
  mkdirSync(target, { recursive: true });
  return { base, library, source, target };
}

function put(root, rel, content, mtime) {
  const full = path.join(root, ...rel.split('/'));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  if (mtime) utimesSync(full, mtime, mtime);
}

const read = (root, rel) => readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const has = (root, rel) => existsSync(path.join(root, ...rel.split('/')));

const runOpts = (s, extra = {}) => ({
  library: s.library,
  sourceDir: s.source,
  targetDir: s.target,
  targetId: 'drive-1',
  ...extra,
});

try {
  // --- a first sync merges both sides -------------------------------------

  {
    const s = scratch();
    put(s.source, 'a.jpg', 'photo a');
    put(s.source, 'Trip/b.jpg', 'photo b');
    put(s.target, 'c.jpg', 'photo c');

    const report = await sync.run(runOpts(s));
    check('a first run reports itself as one', report.firstRun === true);
    check('files travel to the target', read(s.target, 'a.jpg') === 'photo a');
    check('including ones in subfolders', read(s.target, 'Trip/b.jpg') === 'photo b');
    check('and files travel back from the target', read(s.source, 'c.jpg') === 'photo c');
    check('nothing was deleted on a first run', report.planned.deleteOnTarget === 0 && report.planned.deleteOnSource === 0);
    check('and it copied some bytes', report.bytesCopied > 0, String(report.bytesCopied));
  }

  // --- a first sync to a folder that does not exist yet -------------------
  // The liveness check watches the drive, not this sync's own folder within
  // it. Watching the folder made the very first action abort the whole run,
  // blaming a disconnection that had not happened.

  {
    const s = scratch();
    put(s.source, 'a.jpg', 'photo a');
    // Exactly what a fresh drive looks like: present, but with nothing of
    // ours on it yet.
    rmSync(s.target, { recursive: true, force: true });

    const report = await sync.run({
      library: s.library,
      sourceDir: s.source,
      targetDir: s.target,
      driveRoot: path.dirname(s.target),
      targetId: 'fresh-drive',
    });

    check('a first sync to a folder that does not exist yet works',
      report.failed.length === 0, JSON.stringify(report.failed));
    check('and does not claim the drive was disconnected', report.stoppedEarly === false);
    check('the file really arrives', read(s.target, 'a.jpg') === 'photo a');
  }

  // --- an encrypted album keeps its key material with it ------------------

  {
    const s = scratch();
    // What a vault album looks like on disk: the metadata beside ciphertext.
    put(s.source, '.lanshare-vault.json', '{"id":"abc","type":"server","keys":[]}');
    const secret = Buffer.from('MY-PRIVATE-PHOTO-DATA');
    const key = crypto.randomBytes(32);
    await vaultfile.encryptBufferToFile(secret, path.join(s.source, 'photo.enc'), {
      fileKey: key, wrappedKey: crypto.randomBytes(60),
    });

    await sync.run(runOpts(s));

    check('a vault album carries its metadata to the drive',
      has(s.target, '.lanshare-vault.json'),
      'without it the copy on the drive could never be opened');
    check('and its files arrive as ciphertext',
      vaultfile.isVaultFile(path.join(s.target, 'photo.enc')));
    check('with the plaintext nowhere on the drive',
      !readFileSync(path.join(s.target, 'photo.enc')).includes(secret));
  }

  // --- timestamps survive, or every later run sees the world as changed ---

  {
    const s = scratch();
    const when = new Date('2021-06-01T10:00:00Z');
    put(s.source, 'a.jpg', 'photo a', when);
    await sync.run(runOpts(s));

    const from = statSync(path.join(s.source, 'a.jpg'));
    const to = statSync(path.join(s.target, 'a.jpg'));
    check('a copy keeps its modification time',
      Math.abs(from.mtimeMs - to.mtimeMs) < 2000, `${from.mtimeMs} vs ${to.mtimeMs}`);

    // The consequence: an immediate second run must find nothing to do.
    const second = await sync.run(runOpts(s));
    check('so a second run straight afterwards does nothing',
      second.planned.total === 0, JSON.stringify(second.planned));
  }

  // --- deletions propagate, and stay propagated ---------------------------

  {
    const s = scratch();
    put(s.source, 'a.jpg', 'photo a');
    put(s.source, 'b.jpg', 'photo b');
    await sync.run(runOpts(s));

    rmSync(path.join(s.source, 'a.jpg'));
    const report = await sync.run(runOpts(s));
    check('a deletion reaches the other side', !has(s.target, 'a.jpg'));
    check('and is reported as a deletion', report.planned.deleteOnTarget === 1, JSON.stringify(report.planned));

    // The failure mode that makes naive two-way sync unusable.
    const third = await sync.run(runOpts(s));
    check('the run after a deletion does not bring the file back',
      third.planned.total === 0 && !has(s.source, 'a.jpg') && !has(s.target, 'a.jpg'),
      JSON.stringify(third.planned));
    check('the file that was not deleted is untouched', read(s.target, 'b.jpg') === 'photo b');
  }

  // --- a deletion is recoverable -----------------------------------------

  {
    const s = scratch();
    put(s.source, 'precious.jpg', 'the only copy');
    await sync.run(runOpts(s));
    rmSync(path.join(s.source, 'precious.jpg'));
    await sync.run(runOpts(s));

    const trashRoot = path.join(s.target, sync.TRASH_DIR);
    check('a synced deletion goes to a trash folder, not a hard delete', existsSync(trashRoot));

    const stamps = readdirSync(trashRoot);
    const recovered = path.join(trashRoot, stamps[0], 'precious.jpg');
    check('and the file is still readable there',
      existsSync(recovered) && readFileSync(recovered, 'utf8') === 'the only copy',
      recovered);

    // The trash must not then sync itself back as a new file.
    const after = await sync.run(runOpts(s));
    check('the trash folder is not itself synced',
      after.planned.total === 0 && !has(s.source, sync.TRASH_DIR),
      JSON.stringify(after.planned));
  }

  // --- encrypted files are moved as bytes, never opened -------------------

  {
    const s = scratch();
    const secret = Buffer.from('this must never appear in plaintext anywhere');
    const key = crypto.randomBytes(32);
    const wrappedKey = crypto.randomBytes(60); // opaque to the file format
    const encPath = path.join(s.source, 'secret.bin');
    await vaultfile.encryptBufferToFile(secret, encPath, { fileKey: key, wrappedKey });

    await sync.run(runOpts(s));

    const copied = readFileSync(path.join(s.target, 'secret.bin'));
    check('an encrypted file arrives byte-for-byte identical',
      copied.equals(readFileSync(encPath)), `${copied.length} vs ${readFileSync(encPath).length}`);
    check('it is still a vault file on the target', vaultfile.isVaultFile(path.join(s.target, 'secret.bin')));
    check('and its plaintext never appears on the target',
      !copied.includes(secret), 'plaintext found in the synced copy');

    // And it still decrypts, so "byte-for-byte" is not hiding a corrupt copy.
    const back = await vaultfile.decryptToBuffer(path.join(s.target, 'secret.bin'), key);
    check('the synced copy still decrypts to the original',
      back.equals(secret), back.toString('utf8').slice(0, 40));
  }

  // --- conflicts keep both, on both sides ---------------------------------

  {
    const s = scratch();
    put(s.source, 'photo.jpg', 'original');
    await sync.run(runOpts(s));

    // Both sides edited since, differently.
    const later = new Date(Date.now() + 60_000);
    put(s.source, 'photo.jpg', 'edited on the laptop', later);
    put(s.target, 'photo.jpg', 'edited on the drive', new Date(Date.now() + 120_000));

    const report = await sync.run(runOpts(s, { conflictLabel: 'Backup SSD' }));
    check('a genuine conflict is reported', report.planned.conflicts === 1, JSON.stringify(report.planned));

    const conflicted = readdirSync(s.source).find((n) => n.includes('conflicted copy'));
    check('the losing version is kept under a new name', Boolean(conflicted), readdirSync(s.source).join(','));
    check('the name says which drive it came from', conflicted?.includes('Backup SSD'), conflicted);
    check('neither version was lost',
      read(s.source, 'photo.jpg') === 'edited on the laptop'
      && read(s.source, conflicted) === 'edited on the drive',
      `${read(s.source, 'photo.jpg')} / ${read(s.source, conflicted)}`);
    check('and both sides hold both versions',
      read(s.target, 'photo.jpg') === 'edited on the laptop'
      && read(s.target, conflicted) === 'edited on the drive');

    const after = await sync.run(runOpts(s));
    check('the run after a conflict is quiet rather than looping',
      after.planned.total === 0, JSON.stringify(after.planned));
  }

  // --- mirror never writes to the source ----------------------------------

  {
    const s = scratch();
    put(s.source, 'keep.jpg', 'keep me');
    put(s.target, 'stray.jpg', 'not on the source');

    const report = await sync.run(runOpts(s, { policy: 'mirror' }));
    check('a mirror copies the source to the target', read(s.target, 'keep.jpg') === 'keep me');
    check('a mirror removes what the source does not have', !has(s.target, 'stray.jpg'));
    check('a mirror never adds anything to the source', !has(s.source, 'stray.jpg'));
    check('and its removal is still recoverable',
      existsSync(path.join(s.target, sync.TRASH_DIR)), 'no trash folder');
    check('a mirror reports no source-side changes',
      report.planned.toSource === 0 && report.planned.deleteOnSource === 0, JSON.stringify(report.planned));
  }

  // --- a dry run changes nothing ------------------------------------------

  {
    const s = scratch();
    put(s.source, 'a.jpg', 'photo a');
    put(s.target, 'b.jpg', 'photo b');

    const report = await sync.run(runOpts(s, { dryRun: true }));
    check('a dry run reports what it would do', report.planned.total === 2, JSON.stringify(report.planned));
    check('and lists the individual actions', Array.isArray(report.actions) && report.actions.length === 2);
    check('but writes nothing to either side', !has(s.target, 'a.jpg') && !has(s.source, 'b.jpg'));
    check('and records no baseline, so the real run is still a first run',
      (await sync.readBaseline(s.library, 'drive-1')) === null);
  }

  // --- the drive disappears mid-run ---------------------------------------

  {
    // Refusing up front when the drive was never there.
    const s = scratch();
    put(s.source, 'a.jpg', 'photo a');
    rmSync(path.join(s.base, 'drive'), { recursive: true, force: true });

    let refused = null;
    try { await sync.run(runOpts(s)); } catch (err) { refused = err; }
    check('a sync to a disconnected drive refuses rather than half-running',
      refused !== null && /not connected/i.test(refused.message), refused?.message);
    check('and the source is left completely untouched', read(s.source, 'a.jpg') === 'photo a');
  }

  {
    // The harder case: the drive is pulled while the run is under way. This
    // is the ordinary way a USB sync ends, not an exotic failure.
    const s = scratch();
    for (let i = 0; i < 12; i++) put(s.source, `photo-${i}.jpg`, `contents ${i}`);

    const report = await sync.run(runOpts(s, {
      onProgress: ({ done }) => {
        if (done === 3) rmSync(path.join(s.base, 'drive'), { recursive: true, force: true });
      },
    }));

    check('a drive pulled mid-run is noticed', report.stoppedEarly === true, JSON.stringify(report.failed));
    check('and the run stops instead of failing every remaining file one by one',
      report.failed.length === 1, JSON.stringify(report.failed));
    check('the failure says what actually happened',
      /disconnected/i.test(report.failed[0].error), report.failed[0].error);
    check('everything on the source survives the interruption',
      Array.from({ length: 12 }, (_, i) => has(s.source, `photo-${i}.jpg`)).every(Boolean));
    check('and no baseline is written from a drive that is not there',
      (await sync.readBaseline(s.library, 'drive-1')) === null);

    // Plugging it back in must resume cleanly rather than need a repair.
    mkdirSync(s.target, { recursive: true });
    const resumed = await sync.run(runOpts(s));
    check('plugging the drive back in finishes the job',
      resumed.failed.length === 0
      && Array.from({ length: 12 }, (_, i) => has(s.target, `photo-${i}.jpg`)).every(Boolean),
      JSON.stringify(resumed.failed));

    const quiet = await sync.run(runOpts(s));
    check('and the run after that is quiet', quiet.planned.total === 0, JSON.stringify(quiet.planned));
  }

  // --- an interrupted copy leaves no half-written file --------------------

  {
    const s = scratch();
    put(s.source, 'big.jpg', 'x'.repeat(100000));
    await sync.run(runOpts(s));

    const leftovers = readdirSync(s.target).filter((n) => n.endsWith('.lanshare-part'));
    check('no partial files are left behind after a successful copy',
      leftovers.length === 0, leftovers.join(','));
  }

  // --- what is deliberately not synced ------------------------------------

  {
    const s = scratch();
    put(s.source, 'a.jpg', 'photo');
    put(s.source, '.lanshare/sessions.json', '{"machine":"specific"}');
    put(s.source, '.DS_Store', 'mac noise');

    await sync.run(runOpts(s));
    check('server state is not synced between machines', !has(s.target, '.lanshare'));
    check('and neither is operating-system clutter', !has(s.target, '.DS_Store'));
    check('while real files still are', read(s.target, 'a.jpg') === 'photo');
  }

  // --- a relocated album inside a synced folder is not followed -----------

  {
    const s = scratch();
    const elsewhere = path.join(s.base, 'other-drive');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(path.join(elsewhere, 'huge.bin'), 'contents of a whole other drive');

    const locations = require(path.join(here, '..', 'lib', 'locations.js'));
    locations.createLink(path.join(s.source, 'Relocated'), elsewhere);
    put(s.source, 'normal.jpg', 'ordinary photo');

    await sync.run(runOpts(s));
    check('a link to another drive is not followed into the target',
      !has(s.target, 'Relocated/huge.bin'), 'the other drive was copied through the link');
    check('while ordinary files beside it still sync',
      read(s.target, 'normal.jpg') === 'ordinary photo');
  }

  // --- the baseline is honest --------------------------------------------

  {
    const s = scratch();
    put(s.source, 'a.jpg', 'photo a');
    await sync.run(runOpts(s));

    const baseline = await sync.readBaseline(s.library, 'drive-1');
    check('a baseline is recorded after a successful run', baseline instanceof Map && baseline.has('a.jpg'));
    check('it lives with the library, not on the removable drive',
      existsSync(path.join(s.library, sync.STATE_DIR)) && !existsSync(path.join(s.target, sync.STATE_DIR)));

    // A corrupt baseline must read as "no baseline" — which means the next
    // run is a first run, and a first run never deletes.
    writeFileSync(path.join(s.library, sync.STATE_DIR, 'drive-1.json'), '{ this is not json');
    const broken = await sync.readBaseline(s.library, 'drive-1');
    check('a corrupt baseline is treated as no baseline, never as deletions',
      broken === null, JSON.stringify(broken));

    rmSync(path.join(s.source, 'a.jpg'));
    const afterCorrupt = await sync.run(runOpts(s));
    check('so the run after a corrupt baseline restores rather than deletes',
      afterCorrupt.planned.deleteOnTarget === 0 && has(s.source, 'a.jpg'),
      JSON.stringify(afterCorrupt.planned));
  }

  // --- preview and run agree ---------------------------------------------

  {
    const s = scratch();
    put(s.source, 'a.jpg', 'photo a');
    put(s.target, 'b.jpg', 'photo b');

    const previewed = await sync.preview(runOpts(s));
    const report = await sync.run(runOpts(s));
    check('the preview matches what the run actually did',
      previewed.summary.total === report.planned.total
      && previewed.summary.toTarget === report.planned.toTarget,
      `${JSON.stringify(previewed.summary)} vs ${JSON.stringify(report.planned)}`);
  }
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error -> ${err.stack || err.message}`);
} finally {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
