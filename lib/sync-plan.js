'use strict';

/**
 * Deciding what a sync should do — and nothing else.
 *
 * This module does not touch the filesystem. It takes three listings and
 * returns a list of actions. Keeping the decision separate from the doing is
 * deliberate: two-way sync is the one place in this app where a wrong answer
 * destroys photos, and a pure function is the only part of it that can be
 * tested exhaustively.
 *
 * ## Why three states
 *
 * Comparing only source and target cannot tell these apart:
 *
 *   - a file is on the source and not the target  → it was added here
 *   - a file is on the source and not the target  → it was deleted there
 *
 * They are the same observation. Without a record of what matched at the end
 * of the last run, the second case is read as the first, and every file you
 * delete comes back on the next sync. So each run compares against a
 * **baseline**: the snapshot written after the previous successful run.
 *
 * Both sides are compared against the baseline independently, which gives a
 * verdict per side — unchanged, added, modified, or deleted — and the pair of
 * verdicts determines the action. A file only gets deleted when the baseline
 * says it was there last time and one side has since removed it. If there is
 * no baseline at all (the first ever run), nothing is deleted: the two sides
 * are merged instead, because there is no evidence any absence was a deletion.
 *
 * ## Entries
 *
 * A listing is a Map of relative path → { size, mtimeMs }. Content hashing
 * would be more accurate but has to read every byte of the library on both
 * sides of a link that may be USB; size plus mtime is what every practical
 * sync tool uses, and the conflict rules below assume it can be wrong.
 */

/** Conflict policies, chosen per target. */
const POLICIES = ['keep-both', 'newest-wins', 'mirror'];

/**
 * How far apart two timestamps can be and still count as the same moment.
 *
 * FAT32 stores mtimes at 2-second resolution, and a file copied to a USB
 * stick routinely comes back a second or two off. Without this, every file
 * on a FAT drive looks modified on every run.
 */
const MTIME_TOLERANCE_MS = 2000;

class SyncPlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SyncPlanError';
  }
}

function sameFile(a, b) {
  if (!a || !b) return false;
  if (a.size !== b.size) return false;
  return Math.abs(a.mtimeMs - b.mtimeMs) <= MTIME_TOLERANCE_MS;
}

/**
 * What happened to one path on one side since the baseline.
 *
 * 'absent' is distinct from 'deleted': absent means it was not there last
 * time either, so its absence says nothing and must never cause a delete.
 */
function verdictFor(now, base) {
  if (now && !base) return 'added';
  if (!now && base) return 'deleted';
  if (!now && !base) return 'absent';
  return sameFile(now, base) ? 'unchanged' : 'modified';
}

/**
 * A name for the losing copy in a keep-both conflict.
 *
 * The suffix carries the machine name and the date so that a folder full of
 * these is still readable a year later, which "photo (2).jpg" is not.
 */
function conflictName(relPath, label, when = new Date()) {
  const slash = relPath.lastIndexOf('/');
  const dir = slash === -1 ? '' : relPath.slice(0, slash + 1);
  const name = slash === -1 ? relPath : relPath.slice(slash + 1);

  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';

  const stamp = [
    when.getFullYear(),
    String(when.getMonth() + 1).padStart(2, '0'),
    String(when.getDate()).padStart(2, '0'),
  ].join('-');

  const safeLabel = String(label || 'other').replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'other';
  return `${dir}${stem} (conflicted copy from ${safeLabel} ${stamp})${ext}`;
}

/**
 * Paths that differ only in capitalisation.
 *
 * Linux tells `Photo.jpg` and `photo.jpg` apart; Windows and macOS do not.
 * Syncing a Linux library to a Windows drive would silently have one file
 * overwrite the other, and which one survives depends on iteration order.
 * There is no safe automatic answer, so these are reported and skipped
 * rather than guessed at.
 */
function findCaseCollisions(listings) {
  const seen = new Map();
  const collisions = new Map();

  for (const listing of listings) {
    for (const rel of listing.keys()) {
      const key = rel.toLowerCase();
      const first = seen.get(key);
      if (first === undefined) {
        seen.set(key, rel);
      } else if (first !== rel) {
        const group = collisions.get(key) || new Set([first]);
        group.add(rel);
        collisions.set(key, group);
      }
    }
  }

  const flagged = new Set();
  for (const group of collisions.values()) for (const rel of group) flagged.add(rel);
  return flagged;
}

/**
 * Build the plan.
 *
 * @param {object} input
 * @param {Map} input.source     relPath -> { size, mtimeMs } in the library
 * @param {Map} input.target     relPath -> { size, mtimeMs } on the other side
 * @param {Map|null} input.baseline  what matched after the last successful run
 * @param {'keep-both'|'newest-wins'|'mirror'} [input.policy]
 * @param {string} [input.conflictLabel]  names the losing copy in keep-both
 * @param {Date} [input.now]
 * @returns {{actions: Array, skipped: Array, summary: object, firstRun: boolean}}
 */
function buildPlan({
  source,
  target,
  baseline = null,
  policy = 'keep-both',
  conflictLabel = 'the other drive',
  now = new Date(),
} = {}) {
  if (!(source instanceof Map) || !(target instanceof Map)) {
    throw new SyncPlanError('source and target listings are required');
  }
  if (baseline !== null && !(baseline instanceof Map)) {
    throw new SyncPlanError('baseline must be a Map or null');
  }
  if (!POLICIES.includes(policy)) {
    throw new SyncPlanError(`Unknown conflict policy: ${policy}`);
  }

  // No baseline means no evidence that any absence was a deletion. Treating
  // it as one would empty a drive the first time it is ever synced.
  const firstRun = baseline === null;
  const base = baseline || new Map();

  const actions = [];
  const skipped = [];
  const paths = new Set([...source.keys(), ...target.keys(), ...base.keys()]);

  // Worked out across both live sides only. The baseline is history, and a
  // collision that no longer exists is not worth refusing over.
  const caseCollisions = findCaseCollisions([source, target]);

  for (const rel of [...paths].sort()) {
    if (caseCollisions.has(rel)) {
      skipped.push({
        path: rel,
        reason: 'another file differs from this one only in capitalisation, '
          + 'which some drives cannot tell apart',
      });
      continue;
    }

    const s = source.get(rel) || null;
    const t = target.get(rel) || null;
    const b = base.get(rel) || null;

    // A mirror has no opinions to reconcile: the target is made to match the
    // source, and nothing ever travels the other way.
    if (policy === 'mirror') {
      if (s && !sameFile(s, t)) {
        actions.push({ type: 'copy', direction: 'to-target', path: rel, reason: t ? 'changed' : 'new' });
      } else if (!s && t) {
        actions.push({ type: 'delete', side: 'target', path: rel, reason: 'not on source' });
      }
      continue;
    }

    const sv = verdictFor(s, b);
    const tv = verdictFor(t, b);

    // Nothing to do: both sides agree, or neither has anything.
    if (sv === 'absent' && tv === 'absent') continue;
    if (sv === 'unchanged' && tv === 'unchanged') continue;

    // One side deleted it and the other left it alone: honour the deletion.
    // This is the case that only works because of the baseline.
    if (sv === 'deleted' && (tv === 'unchanged' || tv === 'deleted')) {
      if (t) actions.push({ type: 'delete', side: 'target', path: rel, reason: 'deleted on source' });
      continue;
    }
    if (tv === 'deleted' && (sv === 'unchanged' || sv === 'absent')) {
      if (s) actions.push({ type: 'delete', side: 'source', path: rel, reason: 'deleted on target' });
      continue;
    }

    // Deleted on one side, changed on the other. The change is evidence
    // someone wanted the file; the deletion is evidence someone did not.
    // Keeping it is the recoverable mistake, so the file comes back.
    if (sv === 'deleted' && (tv === 'added' || tv === 'modified')) {
      actions.push({ type: 'copy', direction: 'to-source', path: rel, reason: 'changed on target after being deleted here' });
      continue;
    }
    if (tv === 'deleted' && (sv === 'added' || sv === 'modified')) {
      actions.push({ type: 'copy', direction: 'to-target', path: rel, reason: 'changed on source after being deleted there' });
      continue;
    }

    // Present on one side only, and not because of a deletion: copy it over.
    if (s && !t) {
      actions.push({ type: 'copy', direction: 'to-target', path: rel, reason: firstRun ? 'first run' : 'new here' });
      continue;
    }
    if (t && !s) {
      actions.push({ type: 'copy', direction: 'to-source', path: rel, reason: firstRun ? 'first run' : 'new there' });
      continue;
    }

    // Present on both and identical — nothing to do even if the baseline
    // disagrees with both of them.
    if (sameFile(s, t)) continue;

    // Present on both, different, and only one side actually changed.
    if (sv === 'unchanged' && (tv === 'modified' || tv === 'added')) {
      actions.push({ type: 'copy', direction: 'to-source', path: rel, reason: 'changed there' });
      continue;
    }
    if (tv === 'unchanged' && (sv === 'modified' || sv === 'added')) {
      actions.push({ type: 'copy', direction: 'to-target', path: rel, reason: 'changed here' });
      continue;
    }

    // Both changed since the baseline, differently. A genuine conflict.
    actions.push(resolveConflict({ rel, s, t, policy, conflictLabel, now }));
  }

  return { actions, skipped, summary: summarize(actions), firstRun };
}

/**
 * Both sides changed. Neither copy is knowably right.
 *
 * keep-both is the default because it is the only option that cannot lose
 * work: the loser is renamed rather than overwritten. newest-wins is offered
 * because it is quieter, with the cost stated where it is chosen — clock skew
 * between a Mac and a PC can easily make the older edit look newer.
 */
function resolveConflict({ rel, s, t, policy, conflictLabel, now }) {
  if (policy === 'newest-wins') {
    const sourceWins = s.mtimeMs >= t.mtimeMs;
    return {
      type: 'copy',
      direction: sourceWins ? 'to-target' : 'to-source',
      path: rel,
      reason: 'both changed; newest wins',
      conflict: true,
    };
  }

  // keep-both: the target's copy is set aside under a new name and the
  // source's copy takes the canonical path. Both survive on both sides.
  return {
    type: 'conflict-keep-both',
    path: rel,
    keepAs: conflictName(rel, conflictLabel, now),
    reason: 'both changed since the last sync',
    conflict: true,
  };
}

function summarize(actions) {
  const summary = {
    total: actions.length,
    toTarget: 0,
    toSource: 0,
    deleteOnTarget: 0,
    deleteOnSource: 0,
    conflicts: 0,
  };
  for (const a of actions) {
    if (a.conflict || a.type === 'conflict-keep-both') summary.conflicts++;
    if (a.type === 'copy') {
      if (a.direction === 'to-target') summary.toTarget++;
      else summary.toSource++;
    } else if (a.type === 'conflict-keep-both') {
      // Both sides end up holding both copies.
      summary.toTarget++;
      summary.toSource++;
    } else if (a.type === 'delete') {
      if (a.side === 'target') summary.deleteOnTarget++;
      else summary.deleteOnSource++;
    }
  }
  return summary;
}

/**
 * The snapshot to record after a run.
 *
 * Built by re-listing both sides once the run has finished and recording only
 * the paths genuinely present and matching on both. It is deliberately not
 * derived from what the plan intended to do: a baseline that claims a file
 * matched when it does not is worse than having no baseline at all, because
 * the next run reads the mismatch as a deliberate edit and may act on it.
 * Anything that failed to copy simply does not appear, and the next run sees
 * it as new work rather than as settled history.
 *
 * This puts one requirement on the runner: **it must preserve modification
 * times when it copies.** If it does not, nothing matches afterwards, the
 * baseline comes out empty, and the following run treats every file in the
 * library as independently changed on both sides — which under keep-both
 * means a conflicted copy of everything.
 */
function baselineAfter(sourceAfter, targetAfter) {
  if (!(sourceAfter instanceof Map) || !(targetAfter instanceof Map)) {
    throw new SyncPlanError('baselineAfter needs the two listings taken after the run');
  }
  const next = new Map();
  for (const [rel, entry] of sourceAfter) {
    const t = targetAfter.get(rel);
    if (t && sameFile(entry, t)) next.set(rel, { size: entry.size, mtimeMs: entry.mtimeMs });
  }
  return next;
}

module.exports = {
  POLICIES,
  MTIME_TOLERANCE_MS,
  SyncPlanError,
  buildPlan,
  baselineAfter,
  conflictName,
  // exported for tests
  verdictFor,
  sameFile,
  findCaseCollisions,
};
