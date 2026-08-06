/**
 * Starting a sync when its drive is connected.
 *
 * The volume list is stubbed rather than requiring a real USB stick to be
 * plugged and unplugged, because what is worth testing here is the decision —
 * when a run starts, when it must not, and what happens after a failure.
 *
 *   node test/sync-watcher.mjs
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const volumes = require(path.join(here, '..', 'lib', 'volumes.js'));
const { SyncWatcher } = require(path.join(here, '..', 'lib', 'sync-watcher.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

// Stand in for the real volume list so a drive can be "unplugged" on demand.
const realList = volumes.list;
let attachedVolumes = [];
volumes.list = () => attachedVolumes;

const roots = [];
function scene() {
  const base = mkdtempSync(path.join(tmpdir(), 'lanshare-watch-'));
  roots.push(base);
  const library = path.join(base, 'library');
  const drive = path.join(base, 'drive');
  mkdirSync(path.join(library, 'Album'), { recursive: true });
  mkdirSync(drive, { recursive: true });
  writeFileSync(path.join(library, 'Album', 'photo.txt'), 'a photo');

  const config = {
    library,
    locations: [{
      id: 'loc-1',
      label: 'Backup SSD',
      volumeId: 'VOLUME-A',
      path: drive,
      relativePath: '',
    }],
    syncTargets: [{
      id: 'target-1',
      label: 'Album → Backup SSD',
      locationId: 'loc-1',
      album: '/Album',
      subPath: 'Album',
      policy: 'keep-both',
      runOnConnect: true,
      lastRun: null,
    }],
  };

  const logs = [];
  const watcher = new SyncWatcher({
    getConfig: () => config,
    getLibrary: () => library,
    log: (m) => logs.push(m),
  });

  return { base, library, drive, config, watcher, logs };
}

const plug = () => { attachedVolumes = [{ id: 'VOLUME-A', mountPoint: 'X:\\' }]; };
const unplug = () => { attachedVolumes = []; };

try {
  // --- a drive already connected at startup is not an arrival -------------

  {
    const s = scene();
    plug();
    await s.watcher.tick({ primeOnly: true });
    check('the first tick starts nothing', s.config.syncTargets[0].lastRun === null);
    check('and nothing was copied', !existsSync(path.join(s.drive, 'Album', 'photo.txt')));

    // Still plugged in on the next tick — that is not an arrival either.
    await s.watcher.tick();
    check('a drive that never went away does not count as newly connected',
      s.config.syncTargets[0].lastRun === null, JSON.stringify(s.config.syncTargets[0].lastRun));
  }

  // --- plugging it in runs the sync ---------------------------------------

  {
    const s = scene();
    unplug();
    await s.watcher.tick({ primeOnly: true });

    plug();
    await s.watcher.tick();

    check('connecting the drive runs the sync',
      readFileSync(path.join(s.drive, 'Album', 'photo.txt'), 'utf8') === 'a photo');
    check('and the run is recorded', s.config.syncTargets[0].lastRun?.copied === 1,
      JSON.stringify(s.config.syncTargets[0].lastRun));
    check('and it says why it ran', s.logs.some((l) => /drive was connected/.test(l)), s.logs.join(' | '));

    // The tick after must not run it again.
    const firstRunAt = s.config.syncTargets[0].lastRun.at;
    await s.watcher.tick();
    check('it does not run again while the drive stays connected',
      s.config.syncTargets[0].lastRun.at === firstRunAt);
  }

  // --- unplug and replug runs it again ------------------------------------

  {
    const s = scene();
    unplug();
    await s.watcher.tick({ primeOnly: true });
    plug();
    await s.watcher.tick();
    const first = s.config.syncTargets[0].lastRun.at;

    unplug();
    await s.watcher.tick();
    check('unplugging on its own runs nothing',
      s.config.syncTargets[0].lastRun.at === first);

    writeFileSync(path.join(s.library, 'Album', 'later.txt'), 'added while it was away');
    plug();
    await s.watcher.tick();
    check('plugging it back in syncs again',
      existsSync(path.join(s.drive, 'Album', 'later.txt')));
  }

  // --- the setting is honoured --------------------------------------------

  {
    const s = scene();
    s.config.syncTargets[0].runOnConnect = false;
    unplug();
    await s.watcher.tick({ primeOnly: true });
    plug();
    await s.watcher.tick();
    check('a target set not to run on connect is left alone',
      s.config.syncTargets[0].lastRun === null && !existsSync(path.join(s.drive, 'Album', 'photo.txt')));
  }

  // --- a different drive is not this target's drive ------------------------

  {
    const s = scene();
    unplug();
    await s.watcher.tick({ primeOnly: true });
    attachedVolumes = [{ id: 'SOME-OTHER-VOLUME', mountPoint: 'Y:\\' }];
    await s.watcher.tick();
    check('connecting an unrelated drive runs nothing',
      s.config.syncTargets[0].lastRun === null);
  }

  // --- a failure does not retry every fifteen seconds ---------------------

  {
    const s = scene();
    // Point the target at an album that is not there, so resolving fails.
    s.config.syncTargets[0].album = '/DoesNotExist';
    unplug();
    await s.watcher.tick({ primeOnly: true });
    plug();
    await s.watcher.tick();

    check('a failure is logged rather than thrown',
      s.logs.some((l) => /could not run/.test(l)), s.logs.join(' | '));

    const attempts = s.logs.filter((l) => /could not run/.test(l)).length;
    await s.watcher.tick();
    await s.watcher.tick();
    check('and it is not retried on every following tick',
      s.logs.filter((l) => /could not run/.test(l)).length === attempts,
      `${s.logs.filter((l) => /could not run/.test(l)).length} attempts`);

    // Fixing the problem and replugging must work, or a transient fault
    // would disable the sync until the app restarts.
    s.config.syncTargets[0].album = '/Album';
    unplug();
    await s.watcher.tick();
    plug();
    await s.watcher.tick();
    check('but a replug tries again once the problem is fixed',
      existsSync(path.join(s.drive, 'Album', 'photo.txt')));
  }

  // --- two ticks cannot start the same sync twice -------------------------

  {
    const s = scene();
    unplug();
    await s.watcher.tick({ primeOnly: true });
    plug();

    // Both ticks see the arrival; only one may act on it.
    const [a, b] = await Promise.all([s.watcher.tick(), s.watcher.tick()]);
    void a; void b;
    const started = s.logs.filter((l) => /started because/.test(l)).length;
    check('overlapping ticks start the sync only once', started === 1, `${started} starts`);
  }

  // --- the watcher reports what is running --------------------------------

  {
    const s = scene();
    check('nothing is running to begin with', s.watcher.runningIds().length === 0);
    unplug();
    await s.watcher.tick({ primeOnly: true });
    plug();
    await s.watcher.tick();
    check('and nothing is left marked as running afterwards',
      s.watcher.runningIds().length === 0, JSON.stringify(s.watcher.runningIds()));
  }

  // --- start/stop are safe to call repeatedly ------------------------------

  {
    const s = scene();
    s.watcher.start();
    s.watcher.start();
    s.watcher.stop();
    s.watcher.stop();
    check('start and stop can be called more than once without complaint', true);
  }
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error -> ${err.stack || err.message}`);
} finally {
  volumes.list = realList;
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
