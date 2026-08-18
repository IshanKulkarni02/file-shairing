'use strict';

/**
 * Graduated trust, per action type: ask -> ghost -> auto, exactly as
 * described in plan.md's "Graduated trust" section. This module owns the
 * three level values and what it takes to be *offered* a promotion; it
 * does not decide anything on its own — every promotion is an explicit
 * setTrustLevel() call triggered by a person, never automatic. Demotion is
 * the one exception: lib/pattern-discovery.js's revertProposal() calls
 * setTrustLevel(actionType, 'ask') unconditionally on any revert, since
 * "undo demotes immediately" has no offer-and-wait step in the design.
 */

const configLib = require('./config');

class TrustError extends Error {}

const LEVELS = ['ask', 'ghost', 'auto'];
const DEFAULT_LEVEL = 'ask';

// Evidence thresholds for *offering* a promotion — not thresholds that act
// on their own. Ask->ghost is approval-count-based (plan.md: "after
// repeated approvals with no undo"); ghost->auto is outcome-based (plan.md:
// "the log is the evidence for promoting it to auto" — a week of ghost
// logging real, messy data, not a tally of clicks).
const ASK_TO_GHOST_MIN_APPROVALS = 3;
const GHOST_TO_AUTO_MIN_GHOST_LOGS = 5;

function getTrustLevel(config, actionType) {
  const level = config?.trust?.[actionType];
  return LEVELS.includes(level) ? level : DEFAULT_LEVEL;
}

/**
 * Set one action type's trust level, going through config.js's version-
 * checked save() so a concurrent write (the desktop app and a background
 * Discovery pass, say) cannot silently clobber the other. Retries a bounded
 * number of times against a freshly-read version on conflict — there is no
 * person to show a merge conflict to here, just two writers of one map.
 */
function setTrustLevel(actionType, level, { attempts = 5 } = {}) {
  if (!LEVELS.includes(level)) {
    throw new TrustError(`Unknown trust level "${level}" — expected one of ${LEVELS.join(', ')}`);
  }
  for (let i = 0; i < attempts; i++) {
    const config = configLib.load() || {};
    const expectedVersion = configLib.configVersion();
    const nextConfig = { ...config, trust: { ...(config.trust || {}), [actionType]: level } };
    try {
      configLib.save(nextConfig, { expectedVersion });
      return level;
    } catch (err) {
      if (err instanceof configLib.ConfigConflictError && i < attempts - 1) continue;
      throw err;
    }
  }
  throw new TrustError(`Could not save trust level for "${actionType}" — too many concurrent conflicts`);
}

/** How many of the most recent decided proposals of this kind were approved, unbroken, back to the last rejection (or the start of history). */
function approvalStreak(db, actionType) {
  const approved = db.listProposals('approved').filter((p) => p.kind === actionType).map((p) => ({ ...p, outcome: 'approved' }));
  const rejected = db.listProposals('rejected').filter((p) => p.kind === actionType).map((p) => ({ ...p, outcome: 'rejected' }));
  const merged = [...approved, ...rejected].sort((a, b) => (b.decidedAt || '').localeCompare(a.decidedAt || ''));
  let streak = 0;
  for (const p of merged) {
    if (p.outcome !== 'approved') break;
    streak += 1;
  }
  return streak;
}

/** How many consecutive ghost-logged decisions this action type has, back to its last demotion. */
function ghostLogStreak(db, actionType) {
  let streak = 0;
  for (const entry of db.listAuditLog({ actionType })) {
    if (entry.decision === 'demoted') break;
    if (entry.decision === 'ghost-logged') streak += 1;
  }
  return streak;
}

/**
 * Whether this action type currently has enough evidence to be *offered* a
 * promotion — a caller (a route, a UI) decides whether and how to surface
 * that offer; this only computes the evidence.
 */
function promotionEligibility(db, config, actionType) {
  const currentLevel = getTrustLevel(config, actionType);
  if (currentLevel === 'ask') {
    const streak = approvalStreak(db, actionType);
    return {
      currentLevel,
      eligibleFor: streak >= ASK_TO_GHOST_MIN_APPROVALS ? 'ghost' : null,
      evidence: { consecutiveApprovals: streak, needed: ASK_TO_GHOST_MIN_APPROVALS },
    };
  }
  if (currentLevel === 'ghost') {
    const streak = ghostLogStreak(db, actionType);
    return {
      currentLevel,
      eligibleFor: streak >= GHOST_TO_AUTO_MIN_GHOST_LOGS ? 'auto' : null,
      evidence: { ghostLogs: streak, needed: GHOST_TO_AUTO_MIN_GHOST_LOGS },
    };
  }
  return { currentLevel, eligibleFor: null, evidence: {} };
}

module.exports = {
  TrustError,
  LEVELS,
  DEFAULT_LEVEL,
  getTrustLevel,
  setTrustLevel,
  promotionEligibility,
};
