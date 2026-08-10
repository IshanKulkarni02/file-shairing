/**
 * What a sync decides to do.
 *
 * This is the module where a wrong answer deletes photos, so it is tested by
 * enumerating every combination of what can have happened to a file on each
 * side rather than by picking scenarios that seemed interesting.
 *
 *   node test/sync-plan.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const sync = require(path.join(here, '..', 'lib', 'sync-plan.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

const T = 1_700_000_000_000;
const file = (size, mtimeMs) => ({ size, mtimeMs });
const listing = (entries) => new Map(Object.entries(entries));

/** The action for one path, or null. */
function actionFor(plan, rel) {
  return plan.actions.find((a) => a.path === rel) || null;
}

// --- the case the baseline exists for ------------------------------------
// Every other sync bug is recoverable. This one silently undoes deletions.

{
  const source = listing({});                       // deleted here
  const target = listing({ 'a.jpg': file(10, T) }); // still there
  const baseline = listing({ 'a.jpg': file(10, T) });

  const plan = sync.buildPlan({ source, target, baseline });
  const a = actionFor(plan, 'a.jpg');
  check('a file deleted on the source is deleted on the target',
    a?.type === 'delete' && a.side === 'target', JSON.stringify(a));

  // The same two listings without a baseline are indistinguishable from
  // "the target has a file the source has never seen".
  const noBase = sync.buildPlan({ source, target, baseline: null });
  const b = actionFor(noBase, 'a.jpg');
  check('the same listings with no baseline copy it back instead of deleting',
    b?.type === 'copy' && b.direction === 'to-source', JSON.stringify(b));
}

{
  const source = listing({ 'a.jpg': file(10, T) });
  const target = listing({});
  const baseline = listing({ 'a.jpg': file(10, T) });
  const a = actionFor(sync.buildPlan({ source, target, baseline }), 'a.jpg');
  check('a file deleted on the target is deleted on the source',
    a?.type === 'delete' && a.side === 'source', JSON.stringify(a));
}

// --- a first run never deletes -------------------------------------------

{
  const source = listing({ 'here.jpg': file(1, T) });
  const target = listing({ 'there.jpg': file(1, T) });
  const plan = sync.buildPlan({ source, target, baseline: null });

  check('a first run reports itself as one', plan.firstRun === true);
  check('a first run deletes nothing at all',
    !plan.actions.some((a) => a.type === 'delete'), JSON.stringify(plan.actions));
  check('and merges both sides instead',
    actionFor(plan, 'here.jpg')?.direction === 'to-target'
    && actionFor(plan, 'there.jpg')?.direction === 'to-source');
}

// --- every combination of verdicts ---------------------------------------
// Enumerated rather than chosen, so a case cannot be forgotten.

{
  const states = {
    absent: null,
    same: file(10, T),
    changed: file(20, T + 60_000),
  };
  const baseline = listing({ 'f.jpg': file(10, T) });

  const expected = {
    // source state | target state -> what must happen
    'absent|absent': 'nothing',
    'absent|same': 'delete-on-target',
    'absent|changed': 'copy-to-source',
    'same|absent': 'delete-on-source',
    'same|same': 'nothing',
    'same|changed': 'copy-to-source',
    'changed|absent': 'copy-to-target',
    'changed|same': 'copy-to-target',
    'changed|changed': 'conflict',
  };

  let allCorrect = true;
  const wrong = [];
  for (const [sName, sVal] of Object.entries(states)) {
    for (const [tName, tVal] of Object.entries(states)) {
      const source = new Map(sVal ? [['f.jpg', sVal]] : []);
      // Make the two "changed" states genuinely different from each other.
      const tChanged = tName === 'changed' ? file(30, T + 120_000) : tVal;
      const target = new Map(tChanged ? [['f.jpg', tChanged]] : []);

      const plan = sync.buildPlan({ source, target, baseline });
      const a = actionFor(plan, 'f.jpg');
      const got = !a ? 'nothing'
        : a.type === 'conflict-keep-both' ? 'conflict'
          : a.type === 'delete' ? `delete-on-${a.side}`
            : `copy-${a.direction.replace('to-', 'to-')}`;

      const want = expected[`${sName}|${tName}`];
      if (got !== want) { allCorrect = false; wrong.push(`${sName}|${tName}: wanted ${want}, got ${got}`); }
    }
  }
  check('all nine source/target verdict combinations resolve correctly',
    allCorrect, wrong.join('; '));
}

// --- deleted here, changed there -----------------------------------------
// The asymmetric case: one person's deletion against another's edit.

{
  const baseline = listing({ 'f.jpg': file(10, T) });
  const plan = sync.buildPlan({
    source: listing({}),
    target: listing({ 'f.jpg': file(99, T + 5000) }),
    baseline,
  });
  const a = actionFor(plan, 'f.jpg');
  check('a file deleted here but edited there comes back rather than staying deleted',
    a?.type === 'copy' && a.direction === 'to-source', JSON.stringify(a));
}

// --- conflicts -----------------------------------------------------------

{
  const baseline = listing({ 'photo.jpg': file(10, T) });
  const source = listing({ 'photo.jpg': file(20, T + 1000) });
  const target = listing({ 'photo.jpg': file(30, T + 90_000) });

  const keep = sync.buildPlan({ source, target, baseline, policy: 'keep-both', conflictLabel: 'Backup SSD' });
  const k = actionFor(keep, 'photo.jpg');
  check('keep-both renames rather than overwriting', k?.type === 'conflict-keep-both', JSON.stringify(k));
  check('and the kept name says where it came from and when',
    /^photo \(conflicted copy from Backup SSD \d{4}-\d{2}-\d{2}\)\.jpg$/.test(k.keepAs), k.keepAs);
  check('keep-both is counted as a conflict', keep.summary.conflicts === 1);

  const newest = sync.buildPlan({ source, target, baseline, policy: 'newest-wins' });
  const n = actionFor(newest, 'photo.jpg');
  check('newest-wins takes the later timestamp',
    n?.type === 'copy' && n.direction === 'to-source', JSON.stringify(n));
  check('and still reports it as a conflict', newest.summary.conflicts === 1);
}

{
  // A conflicted name has to survive files with no extension and files in
  // subfolders, since both are ordinary in a photo library.
  check('a conflict name keeps the folder it was in',
    sync.conflictName('Trip/2024/photo.jpg', 'SSD', new Date(T)).startsWith('Trip/2024/photo (conflicted'),
    sync.conflictName('Trip/2024/photo.jpg', 'SSD', new Date(T)));
  check('a conflict name handles a file with no extension',
    !sync.conflictName('README', 'SSD', new Date(T)).includes('.'),
    sync.conflictName('README', 'SSD', new Date(T)));
  check('a dotfile is not mistaken for an extension',
    sync.conflictName('.gitignore', 'SSD', new Date(T)).startsWith('.gitignore (conflicted'),
    sync.conflictName('.gitignore', 'SSD', new Date(T)));
  check('a drive label cannot inject path separators into the name',
    !sync.conflictName('a.jpg', '../../etc', new Date(T)).includes('..'),
    sync.conflictName('a.jpg', '../../etc', new Date(T)));
}

// --- mirror --------------------------------------------------------------

{
  const source = listing({ 'keep.jpg': file(10, T), 'new.jpg': file(5, T) });
  const target = listing({ 'keep.jpg': file(10, T), 'stray.jpg': file(7, T) });
  const plan = sync.buildPlan({ source, target, baseline: null, policy: 'mirror' });

  check('a mirror copies what the source has', actionFor(plan, 'new.jpg')?.direction === 'to-target');
  check('a mirror removes what the source does not have',
    actionFor(plan, 'stray.jpg')?.type === 'delete' && actionFor(plan, 'stray.jpg')?.side === 'target');
  check('a mirror never writes to the source',
    !plan.actions.some((a) => a.direction === 'to-source' || a.side === 'source'),
    JSON.stringify(plan.actions));
  check('a mirror leaves matching files alone', !actionFor(plan, 'keep.jpg'));
}

{
  // A mirror must delete on a first run too — that is what mirror means —
  // which is exactly why it is not the default.
  const plan = sync.buildPlan({
    source: listing({}),
    target: listing({ 'old.jpg': file(1, T) }),
    baseline: null,
    policy: 'mirror',
  });
  check('a mirror deletes on a first run, unlike two-way',
    actionFor(plan, 'old.jpg')?.type === 'delete');
}

// --- pull: collect from the other side, touch nothing over there ---------
// For a Google Drive or Dropbox folder you want to fetch from rather than
// manage. Mirror would push your library onto it and delete what it holds
// that you do not — somewhere between rude and catastrophic on a shared
// folder — so this is the direction that has to exist separately.

{
  const source = listing({ 'mine.jpg': file(10, T) });
  const target = listing({ 'theirs.jpg': file(20, T), 'mine.jpg': file(10, T) });
  const plan = sync.buildPlan({ source, target, baseline: null, policy: 'pull' });

  check('a pull fetches what only the other side has',
    actionFor(plan, 'theirs.jpg')?.direction === 'to-source', JSON.stringify(plan.actions));
  check('and leaves matching files alone', !actionFor(plan, 'mine.jpg'));
  check('a pull never writes to the other side',
    !plan.actions.some((a) => a.direction === 'to-target' || a.side === 'target'),
    JSON.stringify(plan.actions));
  check('and never deletes anything anywhere',
    !plan.actions.some((a) => a.type === 'delete'), JSON.stringify(plan.actions));
}

{
  // A file gone from the cloud is not an instruction to lose your copy.
  const plan = sync.buildPlan({
    source: listing({ 'kept.jpg': file(10, T) }),
    target: listing({}),
    baseline: listing({ 'kept.jpg': file(10, T) }),
    policy: 'pull',
  });
  check('a file removed from the other side is kept, not deleted here',
    plan.actions.length === 0, JSON.stringify(plan.actions));
}

{
  // An edit over there wins, because that is what fetching means.
  const plan = sync.buildPlan({
    source: listing({ 'photo.jpg': file(10, T) }),
    target: listing({ 'photo.jpg': file(99, T + 60_000) }),
    baseline: listing({ 'photo.jpg': file(10, T) }),
    policy: 'pull',
  });
  const action = actionFor(plan, 'photo.jpg');
  check('a file changed on the other side is fetched again',
    action?.direction === 'to-source', JSON.stringify(action));
  check('and a pull reports no conflicts to resolve', plan.summary.conflicts === 0);
}

// --- timestamp tolerance -------------------------------------------------

{
  const baseline = listing({ 'a.jpg': file(10, T) });
  const plan = sync.buildPlan({
    source: listing({ 'a.jpg': file(10, T) }),
    // FAT32 rounds to two seconds; the same file comes back slightly off.
    target: listing({ 'a.jpg': file(10, T + 1999) }),
    baseline,
  });
  check('a two-second timestamp drift is not treated as a change',
    plan.actions.length === 0, JSON.stringify(plan.actions));

  const beyond = sync.buildPlan({
    source: listing({ 'a.jpg': file(10, T) }),
    target: listing({ 'a.jpg': file(10, T + 10_000) }),
    baseline,
  });
  check('a larger drift is treated as a change', beyond.actions.length === 1);

  const sameTimeDifferentSize = sync.buildPlan({
    source: listing({ 'a.jpg': file(10, T) }),
    target: listing({ 'a.jpg': file(4096, T) }),
    baseline,
  });
  check('a same-timestamp file of a different size is still a change',
    sameTimeDifferentSize.actions.length === 1, JSON.stringify(sameTimeDifferentSize.actions));
}

// --- identical files the baseline disagrees with -------------------------

{
  // Both sides were edited to the same result, or the baseline is stale.
  // Either way there is nothing to copy and nothing to ask about.
  const plan = sync.buildPlan({
    source: listing({ 'a.jpg': file(50, T + 1000) }),
    target: listing({ 'a.jpg': file(50, T + 1000) }),
    baseline: listing({ 'a.jpg': file(10, T) }),
  });
  check('two sides that already match are left alone, stale baseline or not',
    plan.actions.length === 0, JSON.stringify(plan.actions));
}

// --- a stale baseline never invents a deletion ---------------------------

{
  // The baseline mentions a file neither side has any more. It is already
  // gone from both; proposing anything would be acting on a ghost.
  const plan = sync.buildPlan({
    source: listing({}),
    target: listing({}),
    baseline: listing({ 'ghost.jpg': file(10, T) }),
  });
  check('a file already gone from both sides produces no action',
    plan.actions.length === 0, JSON.stringify(plan.actions));
}

// --- the summary matches the actions -------------------------------------

{
  const plan = sync.buildPlan({
    source: listing({ 'a.jpg': file(1, T), 'both.jpg': file(9, T + 1000) }),
    target: listing({ 'b.jpg': file(1, T), 'both.jpg': file(8, T + 2000) }),
    baseline: listing({ 'both.jpg': file(5, T), 'gone.jpg': file(1, T) }),
  });
  const s = plan.summary;
  check('the summary counts every action',
    s.total === plan.actions.length, `${s.total} vs ${plan.actions.length}`);
  check('a keep-both conflict counts as a copy in both directions',
    s.toTarget >= 1 && s.toSource >= 1, JSON.stringify(s));
}

// --- the baseline written after a run ------------------------------------

{
  // Both listings are taken *after* the run, so the baseline can only ever
  // record what really ended up matching.
  const sourceAfter = listing({ 'a.jpg': file(10, T), 'copied.jpg': file(20, T), 'failed.jpg': file(30, T) });
  const targetAfter = listing({ 'a.jpg': file(10, T), 'copied.jpg': file(20, T) });

  const next = sync.baselineAfter(sourceAfter, targetAfter);
  check('the new baseline records files that match on both sides', next.has('a.jpg'));
  check('including one this run copied across', next.has('copied.jpg'));
  check('but never one that did not make it', !next.has('failed.jpg'),
    JSON.stringify([...next.keys()]));

  // A copy that lost its timestamp is not a match, and must not be recorded
  // as one — that is the whole reason the runner has to preserve mtimes.
  const skewed = sync.baselineAfter(
    listing({ 'a.jpg': file(10, T) }),
    listing({ 'a.jpg': file(10, T + 600_000) }),
  );
  check('a copy whose timestamp was not preserved is not recorded as settled',
    skewed.size === 0, JSON.stringify([...skewed.keys()]));

  let refused = false;
  try { sync.baselineAfter(sourceAfter, null); } catch { refused = true; }
  check('baselineAfter refuses anything that is not two listings', refused);
}

// --- names that differ only in case --------------------------------------
// Linux keeps both; Windows and macOS cannot. Silently letting one overwrite
// the other is the failure mode this refuses to have.

{
  const plan = sync.buildPlan({
    source: listing({ 'Photo.jpg': file(10, T), 'other.jpg': file(1, T) }),
    target: listing({ 'photo.jpg': file(99, T + 5000) }),
    baseline: null,
  });

  const flagged = plan.skipped.map((s) => s.path).sort();
  check('two names differing only in case are both skipped',
    flagged.join(',') === 'Photo.jpg,photo.jpg', flagged.join(','));
  check('neither is copied anywhere',
    !plan.actions.some((a) => a.path.toLowerCase() === 'photo.jpg'),
    JSON.stringify(plan.actions));
  check('the reason explains what a person should do about it',
    /capitalisation/.test(plan.skipped[0].reason), plan.skipped[0].reason);
  check('unaffected files in the same run still sync',
    actionFor(plan, 'other.jpg')?.direction === 'to-target');
}

{
  // The same name on both sides is not a collision — that is just a file.
  const plan = sync.buildPlan({
    source: listing({ 'Photo.jpg': file(10, T) }),
    target: listing({ 'Photo.jpg': file(10, T) }),
    baseline: null,
  });
  check('a matching name on both sides is not treated as a collision',
    plan.skipped.length === 0, JSON.stringify(plan.skipped));
}

{
  // A collision within one side alone still cannot be copied to the other.
  const plan = sync.buildPlan({
    source: listing({ 'a/B.jpg': file(1, T), 'a/b.jpg': file(2, T) }),
    target: listing({}),
    baseline: null,
  });
  check('a collision inside one side alone is skipped too',
    plan.skipped.length === 2 && plan.actions.length === 0,
    `${plan.skipped.length} skipped, ${plan.actions.length} actions`);
}

// --- several runs in a row ------------------------------------------------
// Single-shot tests cannot show the failure everyone actually hits: a
// deletion that reappears on the next sync. That only shows up by running
// the cycle repeatedly against a model of the two sides.

{
  /** Applies a plan to two in-memory sides, the way the runner will. */
  function apply(plan, source, target) {
    for (const a of plan.actions) {
      if (a.type === 'copy') {
        const [from, to] = a.direction === 'to-target' ? [source, target] : [target, source];
        // Copying preserves the timestamp — the runner is required to.
        to.set(a.path, { ...from.get(a.path) });
      } else if (a.type === 'delete') {
        (a.side === 'target' ? target : source).delete(a.path);
      } else if (a.type === 'conflict-keep-both') {
        const losing = target.get(a.path);
        source.set(a.keepAs, { ...losing });
        target.set(a.keepAs, { ...losing });
        target.set(a.path, { ...source.get(a.path) });
      }
    }
    return sync.baselineAfter(source, target);
  }

  const same = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs;
  function identical(a, b) {
    if (a.size !== b.size) return false;
    for (const [rel, entry] of a) {
      const other = b.get(rel);
      if (!other || !same(entry, other)) return false;
    }
    return true;
  }

  const source = listing({ 'one.jpg': file(1, T), 'two.jpg': file(2, T) });
  const target = listing({ 'three.jpg': file(3, T) });

  // Run 1: first ever sync, nothing deleted, both sides merged.
  let baseline = apply(sync.buildPlan({ source, target, baseline: null }), source, target);
  check('after the first run both sides hold the same files',
    identical(source, target), `${[...source.keys()]} vs ${[...target.keys()]}`);

  // Run 2: nothing has changed, so nothing should happen.
  const quiet = sync.buildPlan({ source, target, baseline });
  check('a second run with no changes does nothing at all',
    quiet.actions.length === 0, JSON.stringify(quiet.actions));

  // Someone deletes a photo on the source and syncs.
  source.delete('one.jpg');
  const deleting = sync.buildPlan({ source, target, baseline });
  check('the deletion propagates to the target',
    deleting.actions.length === 1 && deleting.actions[0].type === 'delete');
  baseline = apply(deleting, source, target);
  check('and the file is gone from both sides',
    !source.has('one.jpg') && !target.has('one.jpg'));

  // The run that historically resurrects it.
  const after = sync.buildPlan({ source, target, baseline });
  check('the next run does not bring the deleted file back',
    after.actions.length === 0, JSON.stringify(after.actions));

  // And one more, to be sure it is stable rather than merely delayed.
  const later = sync.buildPlan({ source, target, baseline: apply(after, source, target) });
  check('and neither does the one after that',
    later.actions.length === 0 && !source.has('one.jpg'), JSON.stringify(later.actions));

  // An edit on the target travels back, and then settles.
  target.set('two.jpg', file(222, T + 500_000));
  baseline = apply(sync.buildPlan({ source, target, baseline }), source, target);
  check('an edit made on the target reaches the source',
    source.get('two.jpg')?.size === 222, JSON.stringify(source.get('two.jpg')));
  check('and the run after that is quiet',
    sync.buildPlan({ source, target, baseline }).actions.length === 0);

  // A genuine conflict resolves, and then also settles.
  source.set('three.jpg', file(31, T + 900_000));
  target.set('three.jpg', file(32, T + 900_000));
  const conflicted = sync.buildPlan({ source, target, baseline, conflictLabel: 'Backup SSD' });
  check('a true conflict is reported once', conflicted.summary.conflicts === 1);
  baseline = apply(conflicted, source, target);
  check('both versions survive the conflict on both sides',
    source.size === target.size && [...source.keys()].some((k) => k.includes('conflicted copy')),
    [...source.keys()].join(', '));
  check('and the run after a conflict is quiet, not a conflict loop',
    sync.buildPlan({ source, target, baseline }).actions.length === 0,
    JSON.stringify(sync.buildPlan({ source, target, baseline }).actions));
}

// --- input validation ----------------------------------------------------

{
  const rejects = (fn) => { try { fn(); return false; } catch { return true; } };
  check('an unknown conflict policy is refused',
    rejects(() => sync.buildPlan({ source: new Map(), target: new Map(), policy: 'whatever' })));
  check('a missing listing is refused',
    rejects(() => sync.buildPlan({ source: new Map() })));
  check('a non-Map baseline is refused',
    rejects(() => sync.buildPlan({ source: new Map(), target: new Map(), baseline: {} })));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
