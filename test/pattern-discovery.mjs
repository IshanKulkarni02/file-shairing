/**
 * lib/pattern-discovery.js: the Ghost Mode loop end to end against a real
 * IndexDb and a real (scratch) library directory — detecting trips and
 * camera drift, auto-attaching new files to already-approved trips, and
 * approving a proposal into an actual saved rule.
 *
 *   node test/pattern-discovery.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const pd = require(path.join(here, '..', 'lib', 'pattern-discovery.js'));
const sortRules = require(path.join(here, '..', 'lib', 'sort-rules.js'));
const { IndexDb } = require(path.join(here, '..', 'lib', 'index-db.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

const roots = [];
const opened = [];
function scratch() {
  const library = mkdtempSync(path.join(tmpdir(), 'lanshare-pattern-discovery-'));
  roots.push(library);
  const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
  opened.push(db);
  return { library, db };
}

const T0 = Date.parse('2026-08-01T00:00:00.000Z');
const HOUR = 3600 * 1000;
const MIN = 60 * 1000;

let counter = 0;
function putFile(db, overrides = {}) {
  counter += 1;
  const hash = overrides.hash || `hash-${counter}`;
  db.upsert({
    relPath: `/Inbox/f${counter}.jpg`, size: 10, mtimeMs: 1, hash, kind: 'image', encrypted: 0,
    cameraMake: 'DJI', cameraModel: 'FC3582',
    capturedAt: new Date(T0).toISOString(), capturedAtBasis: 'utc',
    gpsLat: null, gpsLon: null,
    ...overrides,
    hash,
  });
  return hash;
}

const noGeocode = { reverseGeocode: async () => null };
const namedGeocode = (name) => ({ reverseGeocode: async () => name });

try {
  // --- a first pass detects a new trip and proposes it ----------------------

  {
    const { library, db } = scratch();
    for (let i = 0; i < 5; i++) {
      putFile(db, { capturedAt: new Date(T0 + i * 15 * MIN).toISOString(), gpsLat: 32.24, gpsLon: 77.19 });
    }

    const result = await pd.runDiscoveryPass({ library, db, geocode: namedGeocode('Manali') });
    check('a real burst of files produces exactly one trip_cluster proposal',
      result.proposed.length === 1 && result.proposed[0].proposal.kind === 'trip_cluster', JSON.stringify(result.proposed));

    const proposal = result.proposed[0].proposal;
    check('the proposal is pending', proposal.status === 'pending');
    check('the AST carries the move action the user\'s own spec asked for',
      proposal.ast.action.kind === 'move' && proposal.ast.action.destination === '/Rides/{trip}/{day}/{camera}',
      JSON.stringify(proposal.ast));
    check('the AST\'s proposed label comes from the reverse-geocoded centroid',
      proposal.ast.proposedLabel.startsWith('Manali_'), proposal.ast.proposedLabel);
    check('the summary is a human-readable one-liner, not raw JSON',
      typeof proposal.summary === 'string' && proposal.summary.includes('5 files'), proposal.summary);

    const cluster = db.getTripCluster(proposal.subjectId);
    check('a matching trip_clusters row exists, starting proposed', cluster?.status === 'proposed');
    check('all 5 files are recorded as members', db.tripClusterMembers(cluster.id).length === 5);
  }

  // --- re-running does not spam duplicate proposals for the same cluster ----

  {
    const { library, db } = scratch();
    for (let i = 0; i < 4; i++) putFile(db, { capturedAt: new Date(T0 + i * 10 * MIN).toISOString() });

    const first = await pd.runDiscoveryPass({ library, db, geocode: noGeocode });
    const second = await pd.runDiscoveryPass({ library, db, geocode: noGeocode });
    check('the first pass proposes the cluster', first.proposed.length === 1);
    check('a second pass over the same, still-pending cluster proposes nothing new',
      second.proposed.length === 0, JSON.stringify(second.proposed));
  }

  // --- approving applies the rule; rejecting does not ------------------------

  {
    const { library, db } = scratch();
    for (let i = 0; i < 3; i++) {
      putFile(db, { capturedAt: new Date(T0 + i * 10 * MIN).toISOString(), gpsLat: 34.15, gpsLon: 77.58 });
    }
    const { proposed } = await pd.runDiscoveryPass({ library, db, geocode: namedGeocode('Ladakh') });
    const proposalId = proposed[0].proposal.id;

    const approved = pd.approveProposal(library, db, proposalId);
    check('approving flips the proposal to approved', approved.status === 'approved');
    check('and flips the underlying cluster to approved too', db.getTripCluster(proposed[0].proposal.subjectId).status === 'approved');

    const rulesText = sortRules.readRulesText(library);
    check('a matching rule was actually appended to the saved rules',
      rulesText.includes('when trip = "Ladakh_2026-08" -> /Rides/{trip}/{day}/{camera}'), rulesText);

    check('approving an already-decided proposal is refused, not silently repeated', (() => {
      try { pd.approveProposal(library, db, proposalId); return false; } catch (err) { return err instanceof pd.PatternDiscoveryError; }
    })());

    // A second approve-worthy proposal, rejected instead.
    for (let i = 0; i < 3; i++) putFile(db, { capturedAt: new Date(T0 + 20 * HOUR + i * 10 * MIN).toISOString() });
    const { proposed: second } = await pd.runDiscoveryPass({ library, db, geocode: noGeocode });
    const rejected = pd.rejectProposal(db, second[0].proposal.id);
    check('rejecting flips the proposal to rejected', rejected.status === 'rejected');
    check('and the underlying cluster too', db.getTripCluster(second[0].proposal.subjectId).status === 'rejected');
    check('rejecting never touches the saved rules file',
      sortRules.readRulesText(library) === rulesText);

    // Running Discovery again must not re-propose the just-rejected cluster.
    const { proposed: third } = await pd.runDiscoveryPass({ library, db, geocode: noGeocode });
    check('a rejected cluster is not re-proposed on the next pass', third.length === 0, JSON.stringify(third));
  }

  // --- auto-attach: a new file inside an approved trip's envelope ------------

  {
    const { library, db } = scratch();
    for (let i = 0; i < 4; i++) {
      putFile(db, { capturedAt: new Date(T0 + i * 15 * MIN).toISOString(), gpsLat: 32.24, gpsLon: 77.19 });
    }
    const { proposed } = await pd.runDiscoveryPass({ library, db, geocode: namedGeocode('Manali') });
    pd.approveProposal(library, db, proposed[0].proposal.id);
    const clusterId = proposed[0].proposal.subjectId;

    // A new card import lands a file that clearly belongs: same camera,
    // inside the approved date range, inside the approved GPS envelope.
    putFile(db, { capturedAt: new Date(T0 + 30 * MIN).toISOString(), gpsLat: 32.245, gpsLon: 77.195 });
    const result = await pd.runDiscoveryPass({ library, db, geocode: noGeocode });

    check('the new file auto-attaches to the already-approved trip rather than generating a fresh proposal',
      result.autoAttached.length === 1 && result.autoAttached[0].clusterId === clusterId, JSON.stringify(result));
    check('no new proposal was created for it', result.proposed.length === 0, JSON.stringify(result.proposed));
    check('the trip now has one more member', db.tripClusterMembers(clusterId).length === 5);
    check('the new member is recorded with reason auto-attach',
      db.tripClusterMembers(clusterId).find((m) => m.reason === 'auto-attach') !== undefined);
  }

  {
    // A file from a different camera and location, well outside the
    // approved trip's envelope even though it happens to land in the same
    // rough calendar window — must NOT silently attach to the wrong trip.
    const { library, db } = scratch();
    for (let i = 0; i < 4; i++) {
      putFile(db, {
        capturedAt: new Date(T0 + i * 15 * MIN).toISOString(), gpsLat: 32.24, gpsLon: 77.19,
        cameraMake: 'DJI', cameraModel: 'FC3582',
      });
    }
    const { proposed } = await pd.runDiscoveryPass({ library, db, geocode: namedGeocode('Manali') });
    pd.approveProposal(library, db, proposed[0].proposal.id);
    const clusterId = proposed[0].proposal.subjectId;

    putFile(db, {
      capturedAt: new Date(T0 + 40 * MIN).toISOString(), gpsLat: 12.9, gpsLon: 77.6, // Bangalore, not Manali
      cameraMake: 'Apple', cameraModel: 'iPhone 15 Pro',
    });
    const result = await pd.runDiscoveryPass({ library, db, geocode: noGeocode });
    check('a file from an unrelated camera and location does not auto-attach to an unrelated approved trip',
      result.autoAttached.length === 0, JSON.stringify(result.autoAttached));
    check('the approved trip\'s membership is untouched', db.tripClusterMembers(clusterId).length === 4);
  }

  // --- camera drift proposals --------------------------------------------------

  {
    const { library, db } = scratch();
    const offsetSeconds = 20 * 60;
    for (let i = 0; i < 8; i++) {
      const baseT = T0 + i * HOUR;
      putFile(db, {
        capturedAt: new Date(baseT).toISOString(), capturedAtBasis: 'utc-gps',
        cameraMake: 'Apple', cameraModel: 'iPhone 15 Pro', gpsLat: 32.24, gpsLon: 77.19,
      });
      putFile(db, {
        capturedAt: new Date(baseT + offsetSeconds * 1000).toISOString(), capturedAtBasis: 'utc',
        cameraMake: 'DJI', cameraModel: 'Osmo Action 4', gpsLat: null, gpsLon: null,
      });
    }
    const result = await pd.runDiscoveryPass({ library, db, geocode: noGeocode });
    const driftProposal = result.proposed.find((p) => p.proposal.kind === 'camera_correction');
    check('a consistently offset action cam produces a camera_correction proposal', Boolean(driftProposal), JSON.stringify(result.proposed.map((p) => p.proposal.kind)));
    check('the AST carries the camera identity and offset', driftProposal?.proposal.ast.cameraModel === 'Osmo Action 4'
      && Math.abs(driftProposal.proposal.ast.offsetSeconds - offsetSeconds) < 1, JSON.stringify(driftProposal?.proposal.ast));

    const approved = pd.approveProposal(library, db, driftProposal.proposal.id);
    check('approving a camera_correction proposal approves the underlying correction',
      db.getCameraCorrection(driftProposal.proposal.subjectId).status === 'approved');
    check('but appends no rule text — a correction applies via the resolver, not a standing rule',
      sortRules.readRulesText(library) === '', JSON.stringify(sortRules.readRulesText(library)));
    void approved;
  }

  // --- semantic bridging across an ambiguous gap ------------------------------

  {
    const { library, db } = scratch();
    // Two bursts 100 minutes apart — with a floor of 60min and a running
    // mean seeded at 30min (from the two within-burst gaps either side),
    // the threshold here is max(60min, 3*30min) = 90min, and 100min sits
    // just inside the [45min, 135min] ambiguous band around it (verified
    // directly against detectBursts()/isAmbiguousGap() before writing this
    // fixture, rather than assumed) — a real tie-break case, not a clear
    // boundary and not clearly one continuous burst either.
    // beforeHash/afterHash are the two files immediately either side of the
    // gap itself — the *last* file of the first burst and the *first* file
    // of the second, which is what a boundary's beforeHash/afterHash always
    // refer to (not simply "the first and last file of the whole dataset").
    putFile(db, { capturedAt: new Date(T0).toISOString() });
    const beforeHash = putFile(db, { capturedAt: new Date(T0 + 30 * MIN).toISOString() });
    const afterHash = putFile(db, { capturedAt: new Date(T0 + 130 * MIN).toISOString() });
    putFile(db, { capturedAt: new Date(T0 + 160 * MIN).toISOString() });

    const tagImage = async (hash) => (hash === beforeHash || hash === afterHash ? ['tent', 'motorcycle'] : []);
    const result = await pd.runDiscoveryPass({
      library, db, geocode: noGeocode, tagImage, clusterOptions: { minGapMs: 60 * MIN, k: 3 },
    });

    check('a bridged ambiguous gap merges into a single trip proposal, not two',
      result.proposed.filter((p) => p.proposal.kind === 'trip_cluster').length === 1, JSON.stringify(result.proposed));
    const cluster = result.proposed.find((p) => p.proposal.kind === 'trip_cluster')?.cluster;
    check('the merged cluster contains all four files', db.tripClusterMembers(cluster.id).length === 4);
    check('the tags actually got persisted for reuse by a future pass',
      JSON.stringify(db.getContentTags(beforeHash, pd.VLM_MODEL)) === JSON.stringify(['tent', 'motorcycle']));
  }

  {
    // The same shape, but the two sides share no tag — must stay two trips,
    // not merge just because the gap was ambiguous in size.
    const { library, db } = scratch();
    putFile(db, { capturedAt: new Date(T0).toISOString() });
    const beforeHash = putFile(db, { capturedAt: new Date(T0 + 30 * MIN).toISOString() });
    const afterHash = putFile(db, { capturedAt: new Date(T0 + 130 * MIN).toISOString() });
    putFile(db, { capturedAt: new Date(T0 + 160 * MIN).toISOString() });

    const tagImage = async (hash) => (hash === beforeHash ? ['beach'] : hash === afterHash ? ['mountains'] : []);
    const result = await pd.runDiscoveryPass({
      library, db, geocode: noGeocode, tagImage, clusterOptions: { minGapMs: 60 * MIN, k: 3 },
    });
    check('an ambiguous gap with no shared tag stays two separate trip proposals',
      result.proposed.filter((p) => p.proposal.kind === 'trip_cluster').length === 2, JSON.stringify(result.proposed));
  }

  {
    // With no tagImage supplied and nothing pre-tagged, an ambiguous gap
    // must simply stay unbridged (a real split) — never a hang, never a
    // fabricated bridge from nothing.
    const { library, db } = scratch();
    putFile(db, { capturedAt: new Date(T0).toISOString() });
    putFile(db, { capturedAt: new Date(T0 + 30 * MIN).toISOString() });
    putFile(db, { capturedAt: new Date(T0 + 130 * MIN).toISOString() });
    putFile(db, { capturedAt: new Date(T0 + 160 * MIN).toISOString() });

    const result = await pd.runDiscoveryPass({ library, db, geocode: noGeocode, clusterOptions: { minGapMs: 60 * MIN, k: 3 } });
    check('with no tagging capability at all, an ambiguous gap defaults to staying split',
      result.proposed.filter((p) => p.proposal.kind === 'trip_cluster').length === 2, JSON.stringify(result.proposed));
  }

  // --- runDiscoveryPass requires a real db ------------------------------------

  {
    let threw = false;
    try { await pd.runDiscoveryPass({ library: '/nowhere' }); } catch (err) { threw = err instanceof pd.PatternDiscoveryError; }
    check('running Discovery without a db throws a clear PatternDiscoveryError, not a crash deep inside', threw);
  }
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error during the test run -> ${err.stack || err.message}`);
} finally {
  for (const db of opened) {
    try { db.close(); } catch { /* already closed */ }
  }
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
