/**
 * lib/trip-clustering.js: the pure detection algorithms behind Phase O1's
 * Adaptive Pattern Engine — burst clustering, GPS interpolation, clock-drift
 * estimation, and the semantic-bridge tie-break. All synthetic fixtures; no
 * database, no disk, no network — see lib/pattern-discovery.js for where
 * this gets pointed at a real library.
 *
 *   node test/trip-clustering.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const tc = require(path.join(here, '..', 'lib', 'trip-clustering.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-08-01T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

function file(overrides = {}) {
  return {
    hash: `h-${Math.random().toString(36).slice(2)}`,
    capturedAt: iso(T0),
    capturedAtBasis: 'utc-gps',
    cameraMake: 'Apple', cameraModel: 'iPhone 15 Pro',
    gpsLat: 32.24, gpsLon: 77.19,
    ...overrides,
  };
}

// --- detectBursts: the core clustering algorithm ----------------------------

{
  // Two clearly separate trips: a burst of shots every ~20 minutes over two
  // days, five days of nothing, then another burst — the shape the whole
  // feature exists for.
  const tripA = [0, 20, 45, 70].map((min) => file({ hash: `a${min}`, capturedAt: iso(T0 + min * 60 * 1000) }));
  const tripB = [0, 25, 50].map((min) => file({
    hash: `b${min}`, capturedAt: iso(T0 + 5 * DAY + min * 60 * 1000),
  }));
  const { clusters, boundaries } = tc.detectBursts([...tripA, ...tripB]);

  check('two trips separated by five days of nothing are detected as two clusters',
    clusters.length === 2, JSON.stringify(clusters.map((c) => c.files.length)));
  check('the first cluster contains exactly trip A\'s files',
    clusters[0]?.files.length === 4, clusters[0]?.files.length);
  check('the second cluster contains exactly trip B\'s files',
    clusters[1]?.files.length === 3, clusters[1]?.files.length);
  check('exactly one boundary was crossed', boundaries.length === 1, boundaries.length);
  check('the boundary is recorded with the real gap that triggered it',
    boundaries[0]?.gapMs > 4 * DAY, boundaries[0]?.gapMs);
}

{
  // Everything within one burst — no gap ever big enough to count as
  // between-trips — must stay one cluster, not fragment on ordinary
  // variation in shooting pace.
  const files = [0, 10, 40, 45, 120, 125, 300].map((min) => file({ capturedAt: iso(T0 + min * 60 * 1000) }));
  const { clusters } = tc.detectBursts(files);
  check('varying but ordinary gaps within a single session stay one cluster', clusters.length === 1, clusters.length);
}

{
  // Self-relative adaptation, in the direction that actually matters: a
  // person whose normal within-trip rhythm has ~5-hour gaps between bursts
  // (already bigger than the flat 4h floor on its own) should not have
  // *every* one of those ordinary gaps treated as a trip boundary once the
  // running mean has adapted to that rhythm — only a gap genuinely larger
  // than what's typical for them, like a real multi-day gap, should split.
  const rhythmGapMin = 5 * 60; // 5 hours, bigger than the bare 4h floor
  const sameTrip = [];
  for (let i = 0; i < 6; i++) sameTrip.push(file({ capturedAt: iso(T0 + i * rhythmGapMin * 60 * 1000) }));
  const nextTrip = [0, 20, 40].map((min) => file({
    capturedAt: iso(T0 + 6 * rhythmGapMin * 60 * 1000 + 6 * DAY + min * 60 * 1000), // a real 6-day gap
  }));
  const { clusters } = tc.detectBursts([...sameTrip, ...nextTrip]);
  check('once the running mean adapts to a person\'s normal ~5h rhythm, those ordinary gaps do not fragment one trip',
    clusters.length === 2 && clusters[0].files.length === 6, JSON.stringify(clusters.map((c) => c.files.length)));
  check('a genuinely much larger gap (six days) still splits, even once the mean has adapted upward',
    clusters[1]?.files.length === 3, JSON.stringify(clusters));
}

{
  // The bootstrap fix itself: a library where *no* gap is ever below the
  // floor (nobody ever shoots two things within the same few hours) must
  // still eventually recognise a much-larger gap as a real boundary, not
  // deadlock into treating every single gap as one forever.
  const evenlySpread = [];
  for (let i = 0; i < 5; i++) evenlySpread.push(file({ capturedAt: iso(T0 + i * 5 * HOUR) })); // every 5h, first trip
  const laterTrip = [0, 1].map((h) => file({ capturedAt: iso(T0 + 5 * 5 * HOUR + 10 * DAY + h * HOUR) }));
  const { clusters } = tc.detectBursts([...evenlySpread, ...laterTrip]);
  check('a rhythm with no gap ever below the floor still bootstraps and detects the real, much larger boundary',
    clusters.length === 2, JSON.stringify(clusters.map((c) => c.files.length)));
}

{
  // A single stray photo with days of silence on both sides is not a "trip"
  // on its own — minFilesPerCluster (default 2) filters it out rather than
  // proposing a one-file cluster nobody would want to approve. Embedded in
  // a real multi-file trip (rather than tested alone) so the running mean
  // has an actual "typical gap" to establish before judging the stray file
  // against it — three mutually-distant singletons with nothing else in the
  // dataset have no such baseline to learn from and are a genuinely
  // ambiguous case, not what this is meant to prove.
  const realTrip = [0, 15, 30, 45].map((min) => file({ capturedAt: iso(T0 + min * 60 * 1000) }));
  const strayPhoto = file({ capturedAt: iso(T0 + 10 * DAY) });
  const laterTrip = [0, 10, 20].map((min) => file({ capturedAt: iso(T0 + 20 * DAY + min * 60 * 1000) }));
  const { clusters } = tc.detectBursts([...realTrip, strayPhoto, ...laterTrip]);
  check('a stray single file between two real trips is not itself proposed as a trip',
    clusters.length === 2 && !clusters.some((c) => c.files.length === 1), JSON.stringify(clusters.map((c) => c.files.length)));
}

{
  // Multi-camera pooling: a drone, an action cam and a phone shooting the
  // same afternoon, interleaved — this is the actual scenario the feature
  // is for, not an edge case.
  const files = [
    file({ hash: 'drone1', cameraMake: 'DJI', cameraModel: 'FC3582', capturedAt: iso(T0) }),
    file({ hash: 'phone1', cameraMake: 'Apple', cameraModel: 'iPhone 15 Pro', capturedAt: iso(T0 + 5 * 60 * 1000) }),
    file({ hash: 'action1', cameraMake: 'DJI', cameraModel: 'Osmo Action 4', capturedAt: iso(T0 + 9 * 60 * 1000) }),
    file({ hash: 'drone2', cameraMake: 'DJI', cameraModel: 'FC3582', capturedAt: iso(T0 + 15 * 60 * 1000) }),
  ];
  const { clusters } = tc.detectBursts(files);
  check('files from three different cameras interleaved in time pool into one burst',
    clusters.length === 1 && clusters[0].files.length === 4, JSON.stringify(clusters));
}

{
  const withGaps = [file({ capturedAt: null }), file({ capturedAt: undefined }), file({ hash: null, capturedAt: iso(T0) })];
  const { clusters } = tc.detectBursts(withGaps);
  check('files with no capture time or no hash are excluded rather than crashing the sort', clusters.length === 0);
}

{
  // Deliberately unsorted input — detectBursts must sort internally, not
  // assume the caller already did (lib/index-db.js's filesForClustering()
  // already orders by captured_at, but this function should not depend on
  // that being true forever).
  const files = [file({ capturedAt: iso(T0 + 10 * 60 * 1000) }), file({ capturedAt: iso(T0) }), file({ capturedAt: iso(T0 + 5 * 60 * 1000) })];
  const { clusters } = tc.detectBursts(files);
  check('unsorted input is still clustered correctly',
    clusters.length === 1 && clusters[0].startsAt === iso(T0), JSON.stringify(clusters[0]));
}

// --- interpolateLocations: spatial anchoring for non-GPS cameras -----------

{
  const before = file({ hash: 'gps-before', capturedAt: iso(T0), gpsLat: 32.0, gpsLon: 77.0, capturedAtBasis: 'utc-gps' });
  const after = file({ hash: 'gps-after', capturedAt: iso(T0 + 2 * HOUR), gpsLat: 32.2, gpsLon: 77.2, capturedAtBasis: 'utc-gps' });
  const middle = file({
    hash: 'no-gps', capturedAt: iso(T0 + HOUR), gpsLat: null, gpsLon: null, capturedAtBasis: 'utc', cameraMake: 'DJI', cameraModel: 'Osmo Action 4',
  });

  const results = tc.interpolateLocations([before, middle, after]);
  check('a GPS-less file bracketed by two GPS-bearing neighbours gets a location', results.length === 1, JSON.stringify(results));
  const r = results[0];
  check('interpolated at the midpoint in time lands at the midpoint in space',
    Math.abs(r.lat - 32.1) < 1e-9 && Math.abs(r.lon - 77.1) < 1e-9, JSON.stringify(r));
  check('confidence is between 0 and 1', r.confidence > 0 && r.confidence <= 1, r.confidence);
  check('the method is recorded as gps-interpolation, distinguishing it from a real GPS fact', r.method === 'gps-interpolation');
}

{
  // Only a "before" bracket, no "after" — left unlocated rather than
  // nearest-neighbour guessed.
  const before = file({ hash: 'gps-before', capturedAt: iso(T0), gpsLat: 32.0, gpsLon: 77.0 });
  const middle = file({ hash: 'no-gps', capturedAt: iso(T0 + HOUR), gpsLat: null, gpsLon: null, capturedAtBasis: 'utc' });
  const results = tc.interpolateLocations([before, middle]);
  check('a file with only one bracket (no "after") is left unlocated, not guessed', results.length === 0, JSON.stringify(results));
}

{
  const before = file({ hash: 'a', capturedAt: iso(T0), gpsLat: 32.0, gpsLon: 77.0 });
  const already = file({ hash: 'b', capturedAt: iso(T0 + HOUR), gpsLat: 40.0, gpsLon: 90.0 }); // has its own real GPS
  const after = file({ hash: 'c', capturedAt: iso(T0 + 2 * HOUR), gpsLat: 32.2, gpsLon: 77.2 });
  const results = tc.interpolateLocations([before, already, after]);
  check('a file that already has real GPS is left untouched, never overwritten with a guess',
    !results.some((r) => r.hash === 'b'), JSON.stringify(results));
}

{
  const before = file({ hash: 'a', capturedAt: iso(T0), gpsLat: 32.0, gpsLon: 77.0 });
  const naive = file({
    hash: 'naive', capturedAt: iso(T0 + HOUR), gpsLat: null, gpsLon: null, capturedAtBasis: 'local-naive',
  });
  const after = file({ hash: 'c', capturedAt: iso(T0 + 2 * HOUR), gpsLat: 32.2, gpsLon: 77.2 });
  const results = tc.interpolateLocations([before, naive, after]);
  check('a local-naive-basis file is never interpolated — its time cannot be trusted closely enough to anchor a guess',
    results.length === 0, JSON.stringify(results));
}

{
  // Two points 500km apart, only 10 minutes apart in time — no ground
  // vehicle covers that, so the implied-speed check must refuse to
  // interpolate rather than place the file at a physically impossible spot.
  const before = file({ hash: 'a', capturedAt: iso(T0), gpsLat: 32.0, gpsLon: 77.0, capturedAtBasis: 'utc-gps' });
  const after = file({ hash: 'c', capturedAt: iso(T0 + 10 * 60 * 1000), gpsLat: 36.5, gpsLon: 77.0, capturedAtBasis: 'utc-gps' }); // ~500km north
  const middle = file({ hash: 'mid', capturedAt: iso(T0 + 5 * 60 * 1000), gpsLat: null, gpsLon: null, capturedAtBasis: 'utc' });
  const results = tc.interpolateLocations([before, middle, after]);
  check('a physically implausible implied speed between brackets refuses to interpolate, rather than placing a guess',
    results.length === 0, JSON.stringify(results));
}

// --- estimateDrift: cross-hardware clock drift -----------------------------

{
  // A DJI action cam consistently running 20 minutes ahead of GPS-verified
  // phone shots, paired closely in time across several distinct moments.
  // Kept under half the 1-hour spacing between baseline shots deliberately
  // — a bigger offset would alias to the *next* baseline shot being nearer
  // in time than the intended one, which is a real, inherent limit of
  // nearest-neighbour pairing (the offset being measured must be smaller
  // than half the gap between baseline anchors), not a bug to test around.
  const offsetSeconds = 20 * 60;
  const files = [];
  for (let i = 0; i < 8; i++) {
    const baseT = T0 + i * HOUR;
    files.push(file({
      hash: `phone${i}`, capturedAt: iso(baseT), capturedAtBasis: 'utc-gps', cameraMake: 'Apple', cameraModel: 'iPhone 15 Pro',
    }));
    files.push(file({
      hash: `action${i}`, capturedAt: iso(baseT + offsetSeconds * 1000), capturedAtBasis: 'utc',
      cameraMake: 'DJI', cameraModel: 'Osmo Action 4', gpsLat: null, gpsLon: null,
    }));
  }
  const result = tc.estimateDrift(files, 'DJI', 'Osmo Action 4');
  check('a consistent offset across enough paired shots is detected', result !== null, JSON.stringify(result));
  check('the estimated offset matches the real, synthetic drift', Math.abs(result.offsetSeconds - offsetSeconds) < 1, result?.offsetSeconds);
  check('evidence and sample counts are both reported', result.evidenceCount === 8 && result.sampleCount === 8, JSON.stringify(result));
  check('the effective range spans the evidence window', result.effectiveFrom < result.effectiveTo || result.evidenceCount === 1);
}

{
  // Only two matching pairs — under the default minEvidence of 5 — must not
  // propose a correction off a handful of coincidences.
  const files = [
    file({ hash: 'p1', capturedAt: iso(T0), capturedAtBasis: 'utc-gps', cameraMake: 'Apple', cameraModel: 'iPhone' }),
    file({
      hash: 'c1', capturedAt: iso(T0 + 3600 * 1000), capturedAtBasis: 'utc', cameraMake: 'DJI', cameraModel: 'FC3582', gpsLat: null, gpsLon: null,
    }),
  ];
  const result = tc.estimateDrift(files, 'DJI', 'FC3582');
  check('too little evidence yields no correction, not a low-confidence guess', result === null);
}

{
  // Eight pairs, but the deltas are all over the place — no real drift, just
  // noise (or two cameras with genuinely unrelated, non-simultaneous
  // shooting). The dual bar's consistency requirement must reject this.
  const files = [];
  for (let i = 0; i < 8; i++) {
    files.push(file({
      hash: `p${i}`, capturedAt: iso(T0 + i * HOUR), capturedAtBasis: 'utc-gps', cameraMake: 'Apple', cameraModel: 'iPhone',
    }));
    // Deltas alternating between two different values, neither dominant —
    // no shared offset. Both stay under half the 1-hour baseline spacing so
    // nearest-neighbour pairing matches each candidate to its intended
    // same-index baseline shot rather than aliasing to the next one.
    files.push(file({
      hash: `c${i}`, capturedAt: iso(T0 + i * HOUR + (i % 2 === 0 ? 60 : 1500) * 1000), capturedAtBasis: 'utc',
      cameraMake: 'DJI', cameraModel: 'FC3582', gpsLat: null, gpsLon: null,
    }));
  }
  const result = tc.estimateDrift(files, 'DJI', 'FC3582');
  check('inconsistent deltas with no shared offset yield no correction', result === null, JSON.stringify(result));
}

{
  const files = [file({ cameraMake: 'DJI', cameraModel: 'FC3582', capturedAtBasis: 'utc', gpsLat: null, gpsLon: null })];
  check('no baseline (GPS-verified) files at all yields no correction',
    tc.estimateDrift(files, 'DJI', 'FC3582') === null);
}

{
  const files = [file({ cameraMake: 'Apple', cameraModel: 'iPhone', capturedAtBasis: 'utc-gps' })];
  check('no files at all from the candidate camera yields no correction',
    tc.estimateDrift(files, 'DJI', 'FC3582') === null);
}

// --- candidateCameras --------------------------------------------------------

{
  const files = [
    file({ cameraMake: 'DJI', cameraModel: 'FC3582' }),
    file({ cameraMake: 'DJI', cameraModel: 'FC3582' }), // duplicate pair
    file({ cameraMake: 'DJI', cameraModel: 'Osmo Action 4' }),
    file({ cameraMake: 'Apple', cameraModel: 'iPhone 15 Pro' }),
    file({ cameraMake: null, cameraModel: null }),
  ];
  const cameras = tc.candidateCameras(files);
  check('each distinct camera make/model pair appears exactly once',
    cameras.length === 3, JSON.stringify(cameras));
  check('a file with neither make nor model contributes no candidate',
    !cameras.some((c) => c.cameraMake === null && c.cameraModel === null), JSON.stringify(cameras));
}

// --- isAmbiguousGap / tagsOverlap: the semantic bridge tie-break -----------

{
  check('a gap right at the threshold is ambiguous', tc.isAmbiguousGap({ gapMs: 100, thresholdMs: 100 }));
  check('a gap at exactly half the threshold is (just) ambiguous', tc.isAmbiguousGap({ gapMs: 50, thresholdMs: 100 }));
  check('a gap at exactly 1.5x the threshold is (just) ambiguous', tc.isAmbiguousGap({ gapMs: 150, thresholdMs: 100 }));
  check('a gap comfortably under half the threshold is not ambiguous — clearly not a boundary',
    !tc.isAmbiguousGap({ gapMs: 10, thresholdMs: 100 }));
  check('a gap comfortably over 1.5x the threshold is not ambiguous — clearly a boundary',
    !tc.isAmbiguousGap({ gapMs: 1000, thresholdMs: 100 }));
}

{
  check('tag sets sharing a term overlap', tc.tagsOverlap(['tent', 'motorcycle'], ['campfire', 'Motorcycle']));
  check('tag sets sharing nothing do not overlap', !tc.tagsOverlap(['tent'], ['beach']));
  check('an empty tag set never overlaps', !tc.tagsOverlap([], ['tent']) && !tc.tagsOverlap(['tent'], []));
  check('non-array input is handled without throwing', !tc.tagsOverlap(null, ['tent']) && !tc.tagsOverlap(['tent'], undefined));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
