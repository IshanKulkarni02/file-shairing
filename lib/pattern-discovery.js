'use strict';

/**
 * The Ghost Mode Discovery loop: points lib/trip-clustering.js's pure
 * algorithms at a real IndexDb, turns whatever they find into
 * trip_clusters/camera_corrections rows and one rule_proposals row per
 * finding, and applies an approved proposal by editing the saved rules
 * through the same version-checked path a human editor uses.
 *
 * Named lib/pattern-discovery.js rather than lib/discovery.js — that name
 * already belongs to mDNS LAN host discovery (lib/discovery.js), an
 * unrelated, already-shipped module.
 *
 * A run is read-mostly by design: it writes *proposals*, never a standing
 * rule, and the only files it ever touches on disk are the rules text file
 * itself (only on an explicit approve) — never a media file. Nothing here
 * calls lib/sort-engine.js's apply().
 */

const tripClustering = require('./trip-clustering');
const geocodeLib = require('./geocode');
const sortRules = require('./sort-rules');
const trust = require('./trust');

class PatternDiscoveryError extends Error {}

const VLM_MODEL = 'moondream2'; // matches plan.md's Phase O model choice
const DEFAULT_MAX_LIVE_VLM_CALLS = 20;
// A newly detected cluster is treated as "the same trip" as an existing one
// when their date ranges overlap within this much slack either way — two
// Discovery passes over almost-but-not-quite-identical burst boundaries (a
// file added at the edge, a boundary recomputed by a few minutes) should
// not each mint their own proposal for what is clearly the same trip.
// Deliberately small: detectBursts() itself is what actually decides two
// bursts are separate trips (via its own, usually much larger, adaptive
// threshold) — this slack only needs to absorb its boundary jitter between
// runs, not second-guess that decision. Too generous a value here would
// silently treat two bursts detectBursts correctly kept apart as one trip.
const RANGE_MATCH_SLACK_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function centroidOf(points) {
  if (!points.length) return null;
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lon = points.reduce((s, p) => s + p.lon, 0) / points.length;
  return { lat, lon };
}

function envelopeOf(points) {
  if (!points.length) return null;
  return {
    latMin: Math.min(...points.map((p) => p.lat)),
    latMax: Math.max(...points.map((p) => p.lat)),
    lonMin: Math.min(...points.map((p) => p.lon)),
    lonMax: Math.max(...points.map((p) => p.lon)),
  };
}

function rangesOverlap(aStart, aEnd, bStart, bEnd, slackMs = 0) {
  return (aStart - slackMs) <= bEnd && (bStart - slackMs) <= aEnd;
}

// A degree-ish buffer (~11km) around a cluster's GPS envelope before
// checking whether a new file falls inside it. Without one, an envelope
// built from as few as one or two GPS readings is razor-thin — real GPS
// readings are never bit-for-bit identical between shots even standing
// still — and a hard exact-box check would reject nearly every genuine
// same-trip file for being a few metres outside it. 0.1 degrees is loose
// enough to absorb that noise while still excluding a plainly different
// city (Bangalore is ~2,000km from Manali either way this is measured).
const GPS_ENVELOPE_BUFFER_DEG = 0.1;

function withinEnvelope(value, min, max) {
  return Number.isFinite(value) && value >= min - GPS_ENVELOPE_BUFFER_DEG && value <= max + GPS_ENVELOPE_BUFFER_DEG;
}

// ---------------------------------------------------------------------------
// Semantic-bridge merge across ambiguous boundaries
// ---------------------------------------------------------------------------

/**
 * For every ambiguous boundary (see trip-clustering.js's isAmbiguousGap),
 * looks up or — if `tagImage` is supplied and the per-run cap allows —
 * live-tags the two bracketing files, and merges the clusters on either
 * side back into one when their tags overlap. `tagImage` is a pluggable
 * `async (hash) => string[] | null`, deliberately not wired to a real
 * model here: the tie-break *decision* is what this phase is about, not
 * standing up a Moondream2 integration, which stays a clean seam to wire
 * in later without touching this logic.
 */
async function bridgeAmbiguousGaps(clusters, boundaries, db, {
  tagImage = null, maxLiveVlmCalls = DEFAULT_MAX_LIVE_VLM_CALLS,
} = {}) {
  let working = clusters.map((c) => ({ ...c }));
  let liveCallsUsed = 0;

  const tagsFor = async (hash) => {
    const cached = db.getContentTags(hash, VLM_MODEL);
    if (cached) return cached;
    if (!tagImage || liveCallsUsed >= maxLiveVlmCalls) return null;
    liveCallsUsed += 1;
    const tags = await tagImage(hash);
    if (Array.isArray(tags)) db.upsertContentTags(hash, VLM_MODEL, tags);
    return Array.isArray(tags) ? tags : null;
  };

  for (const boundary of boundaries) {
    if (!tripClustering.isAmbiguousGap(boundary)) continue;

    const endingHere = working.findIndex((c) => c.files.at(-1)?.hash === boundary.beforeHash);
    const startingHere = working.findIndex((c) => c.files[0]?.hash === boundary.afterHash);
    // Either side may have been filtered out entirely (too few files to be
    // its own candidate cluster) — nothing to bridge into in that case.
    if (endingHere === -1 || startingHere === -1 || endingHere === startingHere) continue;

    // eslint-disable-next-line no-await-in-loop
    const [beforeTags, afterTags] = await Promise.all([tagsFor(boundary.beforeHash), tagsFor(boundary.afterHash)]);
    if (!tripClustering.tagsOverlap(beforeTags, afterTags)) continue;

    const [a, b] = endingHere < startingHere ? [endingHere, startingHere] : [startingHere, endingHere];
    const merged = {
      files: [...working[a].files, ...working[b].files].sort((x, y) => Date.parse(x.capturedAt) - Date.parse(y.capturedAt)),
      startsAt: working[a].startsAt < working[b].startsAt ? working[a].startsAt : working[b].startsAt,
      endsAt: working[a].endsAt > working[b].endsAt ? working[a].endsAt : working[b].endsAt,
      bridgedHashes: new Set([...(working[a].bridgedHashes || []), ...working[b].files.map((f) => f.hash)]),
    };
    working = working.filter((_, i) => i !== a && i !== b);
    working.push(merged);
  }

  return working;
}

// ---------------------------------------------------------------------------
// Matching a freshly detected cluster against what Discovery already knows
// ---------------------------------------------------------------------------

/** The existing cluster (any status) whose date range and camera set this candidate most plausibly overlaps, or null. */
function matchingExistingCluster(candidate, existingClusters) {
  const startMs = Date.parse(candidate.startsAt);
  const endMs = Date.parse(candidate.endsAt);
  const cameraSet = new Set(candidate.files.map((f) => `${f.cameraMake ?? ''} ${f.cameraModel ?? ''}`));

  return existingClusters.find((existing) => {
    if (!rangesOverlap(startMs, endMs, Date.parse(existing.startsAt), Date.parse(existing.endsAt), RANGE_MATCH_SLACK_MS)) {
      return false;
    }
    return existing.cameraSet.some((c) => cameraSet.has(c));
  }) || null;
}

// ---------------------------------------------------------------------------
// The main pass
// ---------------------------------------------------------------------------

/**
 * One Discovery pass: detect trip clusters and camera drift across the
 * whole library, auto-attach new files to already-approved trips, and file
 * a fresh rule_proposals row for everything genuinely new. Never touches a
 * media file — the only write beyond the pattern-engine tables happens in
 * approveProposal(), and only then.
 *
 * @returns {{proposed: Array, autoAttached: Array<{clusterId, hash}>}}
 */
/**
 * Applies whatever the current trust level for this proposal's action type
 * calls for: 'ask' (the default) leaves it pending, exactly O1's original
 * behaviour; 'ghost' logs what *would* happen without touching anything;
 * 'auto' actually approves it, through the exact same approveProposal()
 * path a human clicking "approve" uses — Ghost Mode auto-running is not a
 * second, less-checked way to apply a proposal, it is the same one.
 * `config` is optional; omitting it (every existing caller before this)
 * behaves exactly as if every action type were at 'ask'.
 */
function applyTrustDecision(library, db, config, proposal) {
  const level = trust.getTrustLevel(config, proposal.kind);
  if (level === 'auto') {
    approveProposal(library, db, proposal.id);
    db.appendAuditLog({ actionType: proposal.kind, subjectId: proposal.subjectId, decision: 'auto-approved', reason: proposal.summary });
  } else if (level === 'ghost') {
    db.appendAuditLog({ actionType: proposal.kind, subjectId: proposal.subjectId, decision: 'ghost-logged', reason: proposal.summary });
  }
  return db.getProposal(proposal.id);
}

async function runDiscoveryPass({
  library, db, geocode = geocodeLib, tagImage = null, maxLiveVlmCalls = DEFAULT_MAX_LIVE_VLM_CALLS,
  clusterOptions = {}, driftOptions = {}, config = null,
}) {
  if (!db) throw new PatternDiscoveryError('runDiscoveryPass needs a real IndexDb');

  const files = db.filesForClustering();
  const { clusters: rawClusters, boundaries } = tripClustering.detectBursts(files, clusterOptions);
  const clusters = await bridgeAmbiguousGaps(rawClusters, boundaries, db, { tagImage, maxLiveVlmCalls });

  const existing = [...db.listTripClusters('approved'), ...db.listTripClusters('proposed'), ...db.listTripClusters('rejected')];
  const proposed = [];
  const autoAttached = [];

  for (const cluster of clusters) {
    const match = matchingExistingCluster(cluster, existing);

    if (match?.status === 'approved') {
      // Per your answer on the design questions: a new file auto-attaches
      // to an already-approved trip when it clearly belongs — its own
      // camera, capture time and (if it has one) location all fall inside
      // the envelope that trip was actually approved with — rather than
      // generating a fresh proposal for something that plainly isn't new.
      const memberHashes = new Set(db.tripClusterMembers(match.id).map((m) => m.hash));
      for (const f of cluster.files) {
        if (memberHashes.has(f.hash)) continue;
        if (!match.cameraSet.includes(`${f.cameraMake ?? ''} ${f.cameraModel ?? ''}`)) continue;
        if (f.capturedAt < match.startsAt || f.capturedAt > match.endsAt) continue;
        if (match.gpsEnvelope && Number.isFinite(f.gpsLat) && Number.isFinite(f.gpsLon)) {
          const { latMin, latMax, lonMin, lonMax } = match.gpsEnvelope;
          if (!withinEnvelope(f.gpsLat, latMin, latMax) || !withinEnvelope(f.gpsLon, lonMin, lonMax)) continue;
        }
        db.addTripClusterMember(match.id, f.hash, 'auto-attach');
        autoAttached.push({ clusterId: match.id, hash: f.hash });
      }
      continue;
    }

    if (match?.status === 'proposed' || match?.status === 'rejected') {
      // Already known to Discovery (still awaiting a decision, or already
      // turned down) — re-running must not spam a duplicate proposal for
      // the same candidate every pass.
      continue;
    }

    // Genuinely new: locate what can be located, name what can be named,
    // propose it.
    // eslint-disable-next-line no-await-in-loop
    const inferred = tripClustering.interpolateLocations(cluster.files);
    for (const loc of inferred) db.upsertInferredLocation(loc.hash, loc.lat, loc.lon, loc.method, loc.confidence);
    const inferredByHash = new Map(inferred.map((l) => [l.hash, l]));

    const points = cluster.files
      .map((f) => (Number.isFinite(f.gpsLat) && Number.isFinite(f.gpsLon)
        ? { lat: f.gpsLat, lon: f.gpsLon }
        : inferredByHash.has(f.hash) ? { lat: inferredByHash.get(f.hash).lat, lon: inferredByHash.get(f.hash).lon } : null))
      .filter(Boolean);
    const centroid = centroidOf(points);
    const gpsEnvelope = envelopeOf(points);

    // eslint-disable-next-line no-await-in-loop
    const suggestedName = centroid ? await geocode.reverseGeocode(centroid.lat, centroid.lon, { library }) : null;
    const label = suggestedName ? `${suggestedName}_${cluster.startsAt.slice(0, 7)}` : null;

    const cameraSet = [...new Set(cluster.files.map((f) => `${f.cameraMake ?? ''} ${f.cameraModel ?? ''}`))];
    const clusterId = `trip_${cluster.startsAt.replace(/\D/g, '')}_${Math.random().toString(36).slice(2, 8)}`;
    const record = db.createTripCluster({
      id: clusterId, label, status: 'proposed', startsAt: cluster.startsAt, endsAt: cluster.endsAt, cameraSet, gpsEnvelope,
    });
    for (const f of cluster.files) {
      db.addTripClusterMember(clusterId, f.hash, cluster.bridgedHashes?.has(f.hash) ? 'semantic-bridge' : 'time-density');
    }

    const ast = {
      type: 'trip_cluster',
      clusterId,
      evidence: {
        days: Math.max(1, Math.round((Date.parse(cluster.endsAt) - Date.parse(cluster.startsAt)) / (24 * 3600 * 1000))),
        cameras: cameraSet.length,
        fileCount: cluster.files.length,
      },
      proposedLabel: label,
      action: { kind: 'move', destination: '/Rides/{trip}/{day}/{camera}' },
    };
    const summary = label
      ? `${cluster.files.length} files across ${cameraSet.length} camera(s) over ${ast.evidence.days} day(s) — proposing "${label}"`
      : `${cluster.files.length} files across ${cameraSet.length} camera(s) over ${ast.evidence.days} day(s) — no location available to suggest a name`;

    const proposal = applyTrustDecision(library, db, config, db.createProposal({
      id: `prop_${clusterId}`, kind: 'trip_cluster', subjectId: clusterId, ast, summary,
    }));
    proposed.push({ proposal, cluster: record });
  }

  for (const { cameraMake, cameraModel } of tripClustering.candidateCameras(files)) {
    const drift = tripClustering.estimateDrift(files, cameraMake, cameraModel, driftOptions);
    if (!drift) continue;

    const alreadyKnown = [
      ...db.listCameraCorrections('approved'), ...db.listCameraCorrections('proposed'), ...db.listCameraCorrections('rejected'),
    ].some((c) => c.camera_make === cameraMake && c.camera_model === cameraModel
      && rangesOverlap(
        Date.parse(drift.effectiveFrom), Date.parse(drift.effectiveTo),
        Date.parse(c.effective_from), Date.parse(c.effective_to), RANGE_MATCH_SLACK_MS,
      ));
    if (alreadyKnown) continue;

    const correctionId = `corr_${cameraMake}_${cameraModel}_${Date.now().toString(36)}`.replace(/\s+/g, '_');
    const record = db.createCameraCorrection({
      id: correctionId, cameraMake, cameraModel, offsetSeconds: drift.offsetSeconds,
      effectiveFrom: drift.effectiveFrom, effectiveTo: drift.effectiveTo,
      status: 'proposed', evidenceCount: drift.evidenceCount, sampleCount: drift.sampleCount,
    });
    const ast = {
      type: 'camera_correction',
      correctionId,
      cameraMake,
      cameraModel,
      offsetSeconds: drift.offsetSeconds,
      evidence: { evidenceCount: drift.evidenceCount, sampleCount: drift.sampleCount },
    };
    const summary = `${cameraMake} ${cameraModel} appears offset by ${Math.round(drift.offsetSeconds / 60)} minute(s), `
      + `based on ${drift.evidenceCount} of ${drift.sampleCount} paired shots`;
    const proposal = applyTrustDecision(library, db, config, db.createProposal({
      id: `prop_${correctionId}`, kind: 'camera_correction', subjectId: correctionId, ast, summary,
    }));
    proposed.push({ proposal, correction: record });
  }

  return { proposed, autoAttached };
}

// ---------------------------------------------------------------------------
// Approving / rejecting a proposal
// ---------------------------------------------------------------------------

/**
 * Appends one rule line to the saved rules, going through the exact same
 * version-checked path a human editor's save uses (lib/sort-rules.js's
 * saveRulesText()/rulesVersion()) — an approval from Discovery is just
 * another editor of the same file, not a second write path with its own
 * risk of clobbering a concurrent human edit. Retries a bounded number of
 * times against a freshly-read version on conflict, since an automated
 * append has no user in the loop to show a merge conflict to.
 */
function appendRuleLine(library, ruleLine, { attempts = 5 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const currentText = sortRules.readRulesText(library);
    if (currentText.split(/\r?\n/).some((line) => line.trim() === ruleLine)) return; // already present
    const expectedVersion = sortRules.rulesVersion(library);
    const newText = currentText.trim() ? `${currentText.replace(/\s+$/, '')}\n${ruleLine}\n` : `${ruleLine}\n`;
    try {
      sortRules.saveRulesText(library, newText, { expectedVersion, message: 'Ghost Mode: approved proposal' });
      return;
    } catch (err) {
      if (err instanceof sortRules.RulesConflictError && i < attempts - 1) continue;
      throw err;
    }
  }
}

/** The inverse of appendRuleLine — same version-checked path, same bounded retry. A line already absent is a no-op, not an error. */
function removeRuleLine(library, ruleLine, { attempts = 5 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const lines = sortRules.readRulesText(library).split(/\r?\n/);
    const idx = lines.findIndex((line) => line.trim() === ruleLine);
    if (idx === -1) return;
    const expectedVersion = sortRules.rulesVersion(library);
    const newText = [...lines.slice(0, idx), ...lines.slice(idx + 1)].join('\n');
    try {
      sortRules.saveRulesText(library, newText, { expectedVersion, message: 'Ghost Mode: reverted proposal' });
      return;
    } catch (err) {
      if (err instanceof sortRules.RulesConflictError && i < attempts - 1) continue;
      throw err;
    }
  }
}

function ruleLineFor(proposal) {
  if (proposal.kind !== 'trip_cluster' || !proposal.ast.action?.destination || !proposal.ast.proposedLabel) return null;
  const label = proposal.ast.proposedLabel.replace(/"/g, '');
  return `when trip = "${label}" -> ${proposal.ast.action.destination}`;
}

/**
 * Approve a pending proposal: flips its subject (and, if it supersedes an
 * earlier one, demotes that earlier row to 'superseded' rather than
 * deleting it — the prior evidence stays on record) to approved, and — for
 * a trip_cluster carrying a destination action — appends the corresponding
 * rule.
 */
function approveProposal(library, db, proposalId) {
  const proposal = db.getProposal(proposalId);
  if (!proposal) throw new PatternDiscoveryError(`No such proposal: ${proposalId}`);
  if (proposal.status !== 'pending') throw new PatternDiscoveryError(`Proposal ${proposalId} is already ${proposal.status}`);

  if (proposal.kind === 'trip_cluster') {
    const cluster = db.getTripCluster(proposal.subjectId);
    if (cluster?.supersedesId) db.setTripClusterStatus(cluster.supersedesId, 'superseded');
    db.setTripClusterStatus(proposal.subjectId, 'approved');
  } else if (proposal.kind === 'camera_correction') {
    const correction = db.getCameraCorrection(proposal.subjectId);
    if (correction?.supersedesId) db.setCameraCorrectionStatus(correction.supersedesId, 'superseded');
    db.setCameraCorrectionStatus(proposal.subjectId, 'approved');
  } else {
    throw new PatternDiscoveryError(`Unknown proposal kind: ${proposal.kind}`);
  }

  db.setProposalStatus(proposalId, 'approved');

  const ruleLine = ruleLineFor(proposal);
  if (ruleLine) appendRuleLine(library, ruleLine);

  return db.getProposal(proposalId);
}

function rejectProposal(db, proposalId) {
  const proposal = db.getProposal(proposalId);
  if (!proposal) throw new PatternDiscoveryError(`No such proposal: ${proposalId}`);
  if (proposal.status !== 'pending') throw new PatternDiscoveryError(`Proposal ${proposalId} is already ${proposal.status}`);

  if (proposal.kind === 'trip_cluster') db.setTripClusterStatus(proposal.subjectId, 'rejected');
  else if (proposal.kind === 'camera_correction') db.setCameraCorrectionStatus(proposal.subjectId, 'rejected');

  db.setProposalStatus(proposalId, 'rejected');
  return db.getProposal(proposalId);
}

/**
 * Undo an *approved* proposal — the escape hatch for something Ghost Mode
 * ran automatically (or a human approved) that turns out to be wrong.
 * Reverses the rule line if one was appended, flips the proposal and its
 * subject back to rejected, and — per plan.md's graduated-trust design —
 * demotes that action type's trust back to 'ask' unconditionally: "undoing
 * is the clearest possible signal that trust was premature," not something
 * that waits to be offered the way a promotion does.
 */
function revertProposal(library, db, proposalId) {
  const proposal = db.getProposal(proposalId);
  if (!proposal) throw new PatternDiscoveryError(`No such proposal: ${proposalId}`);
  if (proposal.status !== 'approved') throw new PatternDiscoveryError(`Proposal ${proposalId} is not approved — nothing to revert`);

  if (proposal.kind === 'trip_cluster') {
    db.setTripClusterStatus(proposal.subjectId, 'rejected');
    const ruleLine = ruleLineFor(proposal);
    if (ruleLine) removeRuleLine(library, ruleLine);
  } else if (proposal.kind === 'camera_correction') {
    db.setCameraCorrectionStatus(proposal.subjectId, 'rejected');
  }

  db.setProposalStatus(proposalId, 'rejected');
  trust.setTrustLevel(proposal.kind, 'ask');
  db.appendAuditLog({ actionType: proposal.kind, subjectId: proposal.subjectId, decision: 'demoted', reason: `reverted ${proposalId}` });

  return db.getProposal(proposalId);
}

module.exports = {
  PatternDiscoveryError,
  runDiscoveryPass,
  approveProposal,
  rejectProposal,
  revertProposal,
  // exported for tests
  bridgeAmbiguousGaps,
  matchingExistingCluster,
  centroidOf,
  envelopeOf,
  VLM_MODEL,
};
