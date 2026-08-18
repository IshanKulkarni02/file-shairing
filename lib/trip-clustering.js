'use strict';

/**
 * The Adaptive Pattern Engine's pure detection logic: turning a pile of
 * timestamped, hash-identified files into candidate trips, filling in a
 * non-GPS camera's location from its GPS-bearing neighbours, and estimating
 * whether one camera model's clock is consistently offset from the rest.
 *
 * Deliberately pure — every function here takes plain data in and returns
 * plain data out, no database, no disk, no network. lib/pattern-discovery.js
 * is where this gets pointed at a real IndexDb and turned into
 * trip_clusters/camera_corrections/rule_proposals rows; keeping the two
 * apart is what makes the actual algorithm testable with synthetic fixtures
 * rather than only provable by running the whole background loop.
 *
 * Every file this operates on is expected to carry: hash, capturedAt (ISO
 * string), capturedAtBasis ('utc' | 'utc-gps' | 'local-naive' | null),
 * cameraMake, cameraModel, gpsLat, gpsLon — the same shape
 * lib/index-db.js's filesForClustering() and dbRowToResult() both produce.
 */

const { haversineKm } = require('./index-db');

// ---------------------------------------------------------------------------
// Time-density burst clustering
// ---------------------------------------------------------------------------

const DEFAULT_MIN_GAP_MS = 4 * 3600 * 1000; // 4 hours — a floor for a still-noisy early mean
const DEFAULT_BURST_K = 3; // "how many times bigger than typical counts as between trips"
const DEFAULT_MIN_FILES_PER_CLUSTER = 2;

/**
 * Self-relative adaptive burst detection, pooling every camera's timestamps
 * into one chronological sequence — a trip is a high-density burst across
 * *any* devices, surrounded by days of near-zero activity, which is exactly
 * what a flat "12 hour gap" number cannot adapt to across different people's
 * shooting habits.
 *
 * A running mean of *ordinary* (non-boundary) gaps is kept via Welford's
 * algorithm — no external stats library, just one extra pass over the same
 * gaps already being computed. A gap becomes a boundary when it exceeds
 * `max(minGapMs, k * runningMean)`; a boundary gap is deliberately excluded
 * from updating the mean afterward, since folding a huge between-trips gap
 * into the "typical" baseline would make the threshold drift upward and the
 * detector progressively less sensitive over a long scan.
 *
 * The running mean is seeded from the *median* gap, not the first one seen.
 * A first-gap seed sounds simpler but has a real failure mode: if that one
 * gap happens to be large (the library's first two files, chronologically,
 * are from two actually-separate events), it inflates the threshold enough
 * to swallow the next several genuinely-separate gaps into one bogus
 * cluster. The median is robust to that in the case that actually matters —
 * a dataset that is mostly one shooting rhythm with occasional large breaks
 * — because it reflects the *typical* gap, not whichever gap happened to
 * come first.
 *
 * @returns {{clusters: Array<{files, startsAt, endsAt}>, boundaries: Array<{beforeHash, afterHash, gapMs, thresholdMs}>}}
 *   `boundaries` records every split point with the gap and threshold that
 *   decided it — lib/pattern-discovery.js uses this to find boundaries
 *   worth a semantic-bridge check (see isAmbiguousGap below) without
 *   re-deriving the running mean itself.
 */
function detectBursts(files, {
  minGapMs = DEFAULT_MIN_GAP_MS, k = DEFAULT_BURST_K, minFilesPerCluster = DEFAULT_MIN_FILES_PER_CLUSTER,
} = {}) {
  const sorted = files
    .filter((f) => f.capturedAt && f.hash)
    .map((f) => ({ ...f, _t: Date.parse(f.capturedAt) }))
    .filter((f) => Number.isFinite(f._t))
    .sort((a, b) => a._t - b._t);

  const clusters = [];
  const boundaries = [];

  if (!sorted.length) return { clusters, boundaries };

  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i]._t - sorted[i - 1]._t);
  let mean = gaps.length ? median(gaps) : 0;
  let count = gaps.length ? 1 : 0;

  let current = [sorted[0]];
  const flush = () => {
    if (current.length >= minFilesPerCluster) {
      clusters.push({
        files: current.map(({ _t, ...rest }) => rest),
        startsAt: new Date(current[0]._t).toISOString(),
        endsAt: new Date(current[current.length - 1]._t).toISOString(),
      });
    }
    current = [];
  };

  for (let i = 1; i < sorted.length; i++) {
    const gap = gaps[i - 1];
    const thresholdMs = Math.max(minGapMs, k * mean);
    if (gap > thresholdMs) {
      boundaries.push({
        beforeHash: sorted[i - 1].hash, afterHash: sorted[i].hash, gapMs: gap, thresholdMs,
      });
      flush();
    } else {
      count += 1;
      mean += (gap - mean) / count;
    }
    current.push(sorted[i]);
  }
  flush();

  return { clusters, boundaries };
}

// ---------------------------------------------------------------------------
// Spatial anchoring: GPS interpolation for a non-GPS camera
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SPEED_KMH = 150; // a plausible ground-transport ceiling
// Interpolation needs a trustworthy time anchor on every point involved — a
// 'local-naive' timestamp (no timezone recorded) cannot be compared against
// another camera's clock closely enough to mean anything.
const TRUSTWORTHY_BASIS = new Set(['utc', 'utc-gps']);

/**
 * Fills in a location for every GPS-less file in `clusterFiles` by linearly
 * interpolating between its nearest GPS-bearing neighbours in time — from
 * *any* camera, which is the point: Camera A's action-cam footage borrows
 * position from Camera B's phone shots fifteen minutes either side of it.
 *
 * Requires both a before *and* an after bracket; a file with GPS-bearing
 * neighbours on only one side is left unlocated rather than nearest-neighbour
 * guessed — the point this engine has to keep is that a stored location is
 * either a fact or a bounded, sanity-checked estimate, never a shrug.
 *
 * The implied-speed check (distance between brackets ÷ elapsed time) catches
 * what a flat distance cap cannot: two points close in kilometres but not
 * reachable in the time between them — a bay, a canyon, a one-way road. A
 * bracket pair that fails it is skipped, not clamped to the nearest plausible
 * point; a physically-impossible pair says more about the brackets picked
 * than about where the file in between actually was.
 *
 * @returns {Array<{hash, lat, lon, confidence, method}>}
 */
function interpolateLocations(clusterFiles, { maxSpeedKmh = DEFAULT_MAX_SPEED_KMH } = {}) {
  const timed = clusterFiles
    .filter((f) => f.hash && f.capturedAt)
    .map((f) => ({ ...f, _t: Date.parse(f.capturedAt) }))
    .filter((f) => Number.isFinite(f._t))
    .sort((a, b) => a._t - b._t);

  const hasGps = (f) => Number.isFinite(f.gpsLat) && Number.isFinite(f.gpsLon);
  const results = [];

  for (let i = 0; i < timed.length; i++) {
    const f = timed[i];
    if (hasGps(f) || !TRUSTWORTHY_BASIS.has(f.capturedAtBasis)) continue;

    let before = null;
    for (let j = i - 1; j >= 0; j--) {
      if (hasGps(timed[j]) && TRUSTWORTHY_BASIS.has(timed[j].capturedAtBasis)) { before = timed[j]; break; }
    }
    let after = null;
    for (let j = i + 1; j < timed.length; j++) {
      if (hasGps(timed[j]) && TRUSTWORTHY_BASIS.has(timed[j].capturedAtBasis)) { after = timed[j]; break; }
    }
    if (!before || !after) continue;

    const spanMs = after._t - before._t;
    if (spanMs <= 0) continue;

    const distanceKm = haversineKm(before.gpsLat, before.gpsLon, after.gpsLat, after.gpsLon);
    const elapsedHours = spanMs / 3_600_000;
    const impliedSpeedKmh = distanceKm / elapsedHours;
    if (impliedSpeedKmh > maxSpeedKmh) continue;

    const frac = (f._t - before._t) / spanMs;
    results.push({
      hash: f.hash,
      lat: before.gpsLat + (after.gpsLat - before.gpsLat) * frac,
      lon: before.gpsLon + (after.gpsLon - before.gpsLon) * frac,
      confidence: 1 / (1 + elapsedHours),
      method: 'gps-interpolation',
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Cross-hardware clock drift estimation
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PAIR_GAP_MS = 2 * 3600 * 1000; // how close in time two shots must be to compare at all
const DEFAULT_MIN_EVIDENCE = 5;
const DEFAULT_MIN_EVIDENCE_RATIO = 0.3; // evidence must not be cherry-picked from a much larger noisy pool
const DEFAULT_CONSISTENCY_TOLERANCE_S = 5 * 60;
// Only a GPS-fix-verified instant is trusted as ground truth to measure
// another camera's drift against — an ordinary video 'utc' timestamp could
// itself be the thing that's wrong, which is exactly the problem this
// function exists to catch, so it cannot also serve as the baseline.
const BASELINE_BASIS = 'utc-gps';

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Whether `cameraMake`/`cameraModel`'s clock is consistently offset from
 * GPS-verified baseline shots, and by how much — or null if the evidence
 * does not clear a dual bar: at least `minEvidence` pairs must agree closely
 * with each other (`consistencyToleranceS`), *and* those agreeing pairs must
 * be at least `minEvidenceRatio` of every pair examined, not a handful of
 * lucky matches cherry-picked out of a much larger noisy pool.
 *
 * Every candidate shot is paired with its nearest baseline shot in time
 * (within `maxPairGapMs` — brute-force nearest-neighbour, the same
 * complexity budget lib/clip.js's search already accepts at this library
 * scale). The offset is the *median* of the agreeing deltas — robust to a
 * stray mismatched pair — not the mean.
 *
 * @returns {{cameraMake, cameraModel, offsetSeconds, evidenceCount, sampleCount, effectiveFrom, effectiveTo}|null}
 */
function estimateDrift(files, cameraMake, cameraModel, {
  maxPairGapMs = DEFAULT_MAX_PAIR_GAP_MS,
  minEvidence = DEFAULT_MIN_EVIDENCE,
  minEvidenceRatio = DEFAULT_MIN_EVIDENCE_RATIO,
  consistencyToleranceS = DEFAULT_CONSISTENCY_TOLERANCE_S,
} = {}) {
  const withTime = (arr) => arr
    .map((f) => ({ ...f, _t: Date.parse(f.capturedAt) }))
    .filter((f) => Number.isFinite(f._t));

  const isCandidateCamera = (f) => f.cameraMake === cameraMake && f.cameraModel === cameraModel;

  const candidates = withTime(files.filter((f) => isCandidateCamera(f)
    && (f.capturedAtBasis === 'utc' || f.capturedAtBasis === 'utc-gps')));
  const baseline = withTime(files.filter((f) => !isCandidateCamera(f) && f.capturedAtBasis === BASELINE_BASIS));

  if (!candidates.length || !baseline.length) return null;

  const pairs = [];
  for (const c of candidates) {
    let nearest = null;
    let nearestGap = Infinity;
    for (const b of baseline) {
      const gap = Math.abs(b._t - c._t);
      if (gap < nearestGap) { nearestGap = gap; nearest = b; }
    }
    if (nearest && nearestGap <= maxPairGapMs) {
      pairs.push({ file: c, deltaSeconds: (c._t - nearest._t) / 1000 });
    }
  }

  const sampleCount = pairs.length;
  if (!sampleCount) return null;

  const roughMedian = median(pairs.map((p) => p.deltaSeconds));
  const evidence = pairs.filter((p) => Math.abs(p.deltaSeconds - roughMedian) <= consistencyToleranceS);
  const evidenceCount = evidence.length;

  if (evidenceCount < minEvidence || evidenceCount / sampleCount < minEvidenceRatio) return null;

  const capturedAts = evidence.map((p) => p.file.capturedAt).sort();
  return {
    cameraMake,
    cameraModel,
    offsetSeconds: median(evidence.map((p) => p.deltaSeconds)),
    evidenceCount,
    sampleCount,
    effectiveFrom: capturedAts[0],
    effectiveTo: capturedAts[capturedAts.length - 1],
  };
}

/** Every distinct (cameraMake, cameraModel) pair present in `files`, as candidates for estimateDrift(). */
function candidateCameras(files) {
  const seen = new Map();
  for (const f of files) {
    if (!f.cameraMake && !f.cameraModel) continue;
    const key = `${f.cameraMake ?? ''} ${f.cameraModel ?? ''}`;
    if (!seen.has(key)) seen.set(key, { cameraMake: f.cameraMake ?? null, cameraModel: f.cameraModel ?? null });
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Semantic bridging across an ambiguous gap
// ---------------------------------------------------------------------------

const AMBIGUOUS_GAP_LOW = 0.5;
const AMBIGUOUS_GAP_HIGH = 1.5;

/**
 * A boundary is genuinely ambiguous — worth a VLM tag check rather than a
 * flat accept/reject — when its gap is neither obviously a boundary nor
 * obviously not one: within half to one-and-a-half times the threshold that
 * decided it. Comfortably under or over that band needs no second opinion.
 */
function isAmbiguousGap({ gapMs, thresholdMs }) {
  return gapMs >= thresholdMs * AMBIGUOUS_GAP_LOW && gapMs <= thresholdMs * AMBIGUOUS_GAP_HIGH;
}

/**
 * Whether two files' visual tags share a recurring, concrete term — "tent",
 * "Himalayan 450" — the signal that an ambiguous time gap is still the same
 * continuous event rather than two unrelated ones. Plain case-insensitive
 * set intersection: this is a tie-break over an already-ambiguous boundary,
 * not a similarity ranking, so anything more elaborate is answering a
 * question nobody asked here.
 */
function tagsOverlap(tagsA, tagsB) {
  if (!Array.isArray(tagsA) || !Array.isArray(tagsB) || !tagsA.length || !tagsB.length) return false;
  const setA = new Set(tagsA.map((t) => String(t).toLowerCase()));
  return tagsB.some((t) => setA.has(String(t).toLowerCase()));
}

module.exports = {
  detectBursts,
  interpolateLocations,
  estimateDrift,
  candidateCameras,
  isAmbiguousGap,
  tagsOverlap,
  DEFAULT_MIN_GAP_MS,
  DEFAULT_BURST_K,
  DEFAULT_MIN_FILES_PER_CLUSTER,
  DEFAULT_MAX_SPEED_KMH,
  DEFAULT_MAX_PAIR_GAP_MS,
  DEFAULT_MIN_EVIDENCE,
  DEFAULT_MIN_EVIDENCE_RATIO,
  DEFAULT_CONSISTENCY_TOLERANCE_S,
};
