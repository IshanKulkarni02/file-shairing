/**
 * lib/capture-device.js: deciding whether a volume should be offered for
 * import at all, before lib/import.js is ever asked to plan anything.
 *
 *   node test/capture-device.mjs
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const capture = require(path.join(here, '..', 'lib', 'capture-device.js'));
const { IndexDb } = require(path.join(here, '..', 'lib', 'index-db.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

// --- isKnownVolume -----------------------------------------------------------

{
  const config = { locations: [{ id: 'loc1', volumeId: 'VOL-LOCATION-1' }] };
  check('the library\'s own volume is known', capture.isKnownVolume({ config, volumeId: 'VOL-LIB', libraryVolumeId: 'VOL-LIB' }));
  check('a volume backing a relocated album is known', capture.isKnownVolume({ config, volumeId: 'VOL-LOCATION-1', libraryVolumeId: 'VOL-LIB' }));
  check('an unrelated volume is not known', !capture.isKnownVolume({ config, volumeId: 'VOL-STRANGER', libraryVolumeId: 'VOL-LIB' }));
  check('a null/undefined volume id is never known', !capture.isKnownVolume({ config, volumeId: null, libraryVolumeId: 'VOL-LIB' }));
}

// --- dismiss / isDismissed / undismiss, persisted through config.json --------

{
  const HOME = mkdtempSync(path.join(tmpdir(), 'lanshare-capture-device-'));
  try {
    process.env.LANSHARE_HOME = HOME;
    delete require.cache[require.resolve(path.join(here, '..', 'lib', 'config.js'))];
    const configLib = require(path.join(here, '..', 'lib', 'config.js'));
    const { config } = configLib.loadOrCreate();

    check('a fresh config has no dismissed cards', capture.ensureDismissedList(config).length === 0);
    check('an unknown volume id is not dismissed', !capture.isDismissed(config, 'VOL-CARD-1'));

    capture.dismiss(config, configLib, 'VOL-CARD-1');
    check('dismissing a card is remembered immediately', capture.isDismissed(config, 'VOL-CARD-1'));
    check('a different card is unaffected', !capture.isDismissed(config, 'VOL-CARD-2'));

    const reloaded = configLib.load();
    check('the dismissal was actually persisted to disk, not just held in memory',
      reloaded.dismissedCaptureDevices.includes('VOL-CARD-1'));

    capture.dismiss(config, configLib, 'VOL-CARD-1');
    check('dismissing the same card twice does not duplicate the entry',
      capture.ensureDismissedList(config).filter((id) => id === 'VOL-CARD-1').length === 1);

    capture.undismiss(config, configLib, 'VOL-CARD-1');
    check('undismissing makes the card eligible again', !capture.isDismissed(config, 'VOL-CARD-1'));
    const reloadedAfterUndo = configLib.load();
    check('undismissing was persisted too', !reloadedAfterUndo.dismissedCaptureDevices.includes('VOL-CARD-1'));

    // --- checkVolume: the full decision, end to end ---------------------------

    function scratchDb() {
      const dir = mkdtempSync(path.join(tmpdir(), 'lanshare-capture-device-db-'));
      return { db: new IndexDb(path.join(dir, 'index.db')), dir };
    }

    {
      const cardDir = mkdtempSync(path.join(tmpdir(), 'lanshare-capture-device-card-'));
      mkdirSync(path.join(cardDir, 'DCIM'));
      writeFileSync(path.join(cardDir, 'DCIM', 'photo.jpg'), 'a real photo');
      const { db, dir } = scratchDb();
      try {
        const plan = await capture.checkVolume({
          volume: { id: 'VOL-FRESH-CARD', mountPoint: cardDir },
          config, indexDb: db, libraryVolumeId: 'VOL-LIB',
        });
        check('a fresh, unknown, undismissed card with a DCIM folder is offered', Boolean(plan) && plan.candidates.length === 1);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
        rmSync(cardDir, { recursive: true, force: true });
      }
    }

    {
      const emptyDrive = mkdtempSync(path.join(tmpdir(), 'lanshare-capture-device-empty-'));
      const { db, dir } = scratchDb();
      try {
        const plan = await capture.checkVolume({
          volume: { id: 'VOL-ORDINARY-DRIVE', mountPoint: emptyDrive },
          config, indexDb: db, libraryVolumeId: 'VOL-LIB',
        });
        check('an ordinary drive with no DCIM folder is never offered', plan === null);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
        rmSync(emptyDrive, { recursive: true, force: true });
      }
    }

    {
      // The library's own drive, even if it somehow had a DCIM-shaped folder
      // in it, must never be offered as if it were a stranger's card.
      const libraryLikeDrive = mkdtempSync(path.join(tmpdir(), 'lanshare-capture-device-lib-'));
      mkdirSync(path.join(libraryLikeDrive, 'DCIM'));
      writeFileSync(path.join(libraryLikeDrive, 'DCIM', 'coincidence.jpg'), 'x');
      const { db, dir } = scratchDb();
      try {
        const plan = await capture.checkVolume({
          volume: { id: 'VOL-LIB', mountPoint: libraryLikeDrive },
          config, indexDb: db, libraryVolumeId: 'VOL-LIB',
        });
        check('the library\'s own volume is never offered for import, even with a DCIM-shaped folder', plan === null);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
        rmSync(libraryLikeDrive, { recursive: true, force: true });
      }
    }

    {
      const dismissedCardDir = mkdtempSync(path.join(tmpdir(), 'lanshare-capture-device-dismissed-'));
      mkdirSync(path.join(dismissedCardDir, 'DCIM'));
      writeFileSync(path.join(dismissedCardDir, 'DCIM', 'photo.jpg'), 'x');
      capture.dismiss(config, configLib, 'VOL-DISMISSED-CARD');
      const { db, dir } = scratchDb();
      try {
        const plan = await capture.checkVolume({
          volume: { id: 'VOL-DISMISSED-CARD', mountPoint: dismissedCardDir },
          config, indexDb: db, libraryVolumeId: 'VOL-LIB',
        });
        check('a card marked "never" is not offered even though it genuinely has new photos', plan === null);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
        rmSync(dismissedCardDir, { recursive: true, force: true });
      }
    }
  } finally {
    delete process.env.LANSHARE_HOME;
    rmSync(HOME, { recursive: true, force: true });
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
