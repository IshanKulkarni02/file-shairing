/**
 * Phase O2's graduated trust wired into Discovery: auto-approving at
 * 'auto', logging without acting at 'ghost', and reverting an approved
 * proposal — which demotes trust back to 'ask' unconditionally.
 *
 * A separate file from test/pattern-discovery.mjs because trust levels
 * live in config.json, which lib/config.js resolves once from
 * LANSHARE_HOME at module load — every trust-touching test in this process
 * has to share that one location, so it is set up top-of-file exactly like
 * test/config.mjs and test/trust.mjs do, rather than mixed into the
 * existing suite where most tests never need it at all.
 *
 *   node test/pattern-discovery-trust.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const home = mkdtempSync(path.join(tmpdir(), 'lanshare-pd-trust-home-'));
process.env.LANSHARE_HOME = home;

const configLib = require(path.join(here, '..', 'lib', 'config.js'));
const trustLib = require(path.join(here, '..', 'lib', 'trust.js'));
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
  const library = mkdtempSync(path.join(tmpdir(), 'lanshare-pd-trust-'));
  roots.push(library);
  const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
  opened.push(db);
  return { library, db };
}

const T0 = Date.parse('2026-08-01T00:00:00.000Z');
const MIN = 60 * 1000;
const HOUR = 3600 * 1000;
let counter = 0;
function putFile(db, overrides = {}) {
  counter += 1;
  const hash = overrides.hash || `hash-${counter}`;
  db.upsert({
    relPath: `/Inbox/f${counter}.jpg`, size: 10, mtimeMs: 1, hash, kind: 'image', encrypted: 0,
    cameraMake: 'DJI', cameraModel: 'FC3582',
    capturedAt: new Date(T0).toISOString(), capturedAtBasis: 'utc',
    gpsLat: 32.24, gpsLon: 77.19,
    ...overrides,
    hash,
  });
  return hash;
}
const namedGeocode = (name) => ({ reverseGeocode: async () => name });

try {
  configLib.loadOrCreate();

  // --- 'ask' (default, no trust set) behaves exactly like before -----------

  {
    const { library, db } = scratch();
    for (let i = 0; i < 3; i++) putFile(db, { capturedAt: new Date(T0 + i * 10 * MIN).toISOString() });
    configLib.save({ ...configLib.load(), trust: {} });
    const result = await pd.runDiscoveryPass({ library, db, geocode: namedGeocode('X'), config: configLib.load() });
    check('at the default ask level, a proposal stays pending', result.proposed[0].proposal.status === 'pending');
    check('and no audit log entry is written for a plain ask decision', db.listAuditLog().length === 0);
  }

  // --- 'auto' trust auto-approves through the real approve path ------------

  {
    const { library, db } = scratch();
    for (let i = 0; i < 3; i++) putFile(db, { capturedAt: new Date(T0 + i * 10 * MIN).toISOString() });
    trustLib.setTrustLevel('trip_cluster', 'auto');
    const result = await pd.runDiscoveryPass({ library, db, geocode: namedGeocode('Ladakh'), config: configLib.load() });

    const proposal = result.proposed[0].proposal;
    check('at auto trust, the proposal comes back already approved', proposal.status === 'approved', proposal.status);
    check('the underlying cluster is approved too', db.getTripCluster(proposal.subjectId).status === 'approved');
    check('the rule was actually appended — auto-approval goes through the real approve path',
      sortRules.readRulesText(library).includes('when trip ='));

    const log = db.listAuditLog({ actionType: 'trip_cluster' });
    check('an audit log entry records the automatic decision',
      log.length === 1 && log[0].decision === 'auto-approved' && log[0].subjectId === proposal.subjectId, JSON.stringify(log));

    trustLib.setTrustLevel('trip_cluster', 'ask'); // reset for the next block
  }

  // --- 'ghost' trust logs without touching anything -------------------------

  {
    const { library, db } = scratch();
    for (let i = 0; i < 3; i++) putFile(db, { capturedAt: new Date(T0 + i * 10 * MIN).toISOString() });
    trustLib.setTrustLevel('trip_cluster', 'ghost');
    const result = await pd.runDiscoveryPass({ library, db, geocode: namedGeocode('Manali'), config: configLib.load() });

    const proposal = result.proposed[0].proposal;
    check('at ghost trust, the proposal stays pending — nothing is actually applied', proposal.status === 'pending', proposal.status);
    check('the underlying cluster stays proposed, not approved', db.getTripCluster(proposal.subjectId).status === 'proposed');
    check('no rule was appended', sortRules.readRulesText(library) === '');

    const log = db.listAuditLog({ actionType: 'trip_cluster' });
    check('an audit log entry records what would have happened',
      log.length === 1 && log[0].decision === 'ghost-logged', JSON.stringify(log));

    trustLib.setTrustLevel('trip_cluster', 'ask');
  }

  // --- camera_correction and trip_cluster trust are independent -----------

  {
    const { library, db } = scratch();
    const offsetSeconds = 20 * 60;
    for (let i = 0; i < 8; i++) {
      const baseT = T0 + i * HOUR;
      putFile(db, { capturedAt: new Date(baseT).toISOString(), capturedAtBasis: 'utc-gps', cameraMake: 'Apple', cameraModel: 'iPhone' });
      putFile(db, {
        capturedAt: new Date(baseT + offsetSeconds * 1000).toISOString(), capturedAtBasis: 'utc',
        cameraMake: 'DJI', cameraModel: 'Osmo Action 4', gpsLat: null, gpsLon: null,
      });
    }
    trustLib.setTrustLevel('camera_correction', 'auto');
    // trip_cluster stays at 'ask' — set explicitly so a leftover from an
    // earlier block in this same process can never leak into this one.
    trustLib.setTrustLevel('trip_cluster', 'ask');
    const result = await pd.runDiscoveryPass({ library, db, geocode: namedGeocode('X'), config: configLib.load() });

    const tripProposal = result.proposed.find((p) => p.proposal.kind === 'trip_cluster')?.proposal;
    const driftProposal = result.proposed.find((p) => p.proposal.kind === 'camera_correction')?.proposal;
    check('trip_cluster proposals are unaffected by camera_correction\'s trust level',
      tripProposal?.status === 'pending', tripProposal?.status);
    check('camera_correction proposals are auto-approved independently',
      driftProposal?.status === 'approved', driftProposal?.status);

    trustLib.setTrustLevel('camera_correction', 'ask');
  }

  // --- revertProposal: the undo-demotes-trust escape hatch -------------------

  {
    const { library, db } = scratch();
    for (let i = 0; i < 3; i++) putFile(db, { capturedAt: new Date(T0 + i * 10 * MIN).toISOString() });
    trustLib.setTrustLevel('trip_cluster', 'auto');
    const result = await pd.runDiscoveryPass({ library, db, geocode: namedGeocode('Spiti'), config: configLib.load() });
    const proposal = result.proposed[0].proposal;
    check('setup: the proposal really is auto-approved before reverting it', proposal.status === 'approved');
    check('setup: trust really is at auto before reverting', trustLib.getTrustLevel(configLib.load(), 'trip_cluster') === 'auto');

    const reverted = pd.revertProposal(library, db, proposal.id);
    check('reverting flips the proposal back to rejected', reverted.status === 'rejected');
    check('and the underlying cluster too', db.getTripCluster(proposal.subjectId).status === 'rejected');
    check('the appended rule is actually removed from the saved rules',
      !sortRules.readRulesText(library).includes('when trip ='), sortRules.readRulesText(library));
    check('trust for this action type is demoted straight back to ask, unconditionally',
      trustLib.getTrustLevel(configLib.load(), 'trip_cluster') === 'ask');

    const log = db.listAuditLog({ actionType: 'trip_cluster' });
    check('the demotion itself is on the audit trail',
      log.some((e) => e.decision === 'demoted' && e.subjectId === proposal.subjectId), JSON.stringify(log));

    check('reverting an already-reverted (non-approved) proposal is refused, not repeated', (() => {
      try { pd.revertProposal(library, db, proposal.id); return false; } catch (err) { return err instanceof pd.PatternDiscoveryError; }
    })());
  }

  {
    const { library, db } = scratch();
    check('reverting an unknown proposal id fails clearly', (() => {
      try { pd.revertProposal(library, db, 'nope'); return false; } catch (err) { return err instanceof pd.PatternDiscoveryError; }
    })());
  }

  {
    // A pending (never-approved) proposal cannot be "reverted" — reject it instead.
    const { library, db } = scratch();
    for (let i = 0; i < 3; i++) putFile(db, { capturedAt: new Date(T0 + i * 10 * MIN).toISOString() });
    const result = await pd.runDiscoveryPass({ library, db, geocode: namedGeocode('X'), config: configLib.load() });
    check('reverting a still-pending proposal is refused', (() => {
      try { pd.revertProposal(library, db, result.proposed[0].proposal.id); return false; } catch (err) { return err instanceof pd.PatternDiscoveryError; }
    })());
  }
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error during the test run -> ${err.stack || err.message}`);
} finally {
  for (const db of opened) {
    try { db.close(); } catch { /* already closed */ }
  }
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
