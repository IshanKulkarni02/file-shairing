/**
 * lib/trust.js: trust-level storage and promotion-eligibility evidence,
 * against a real (scratch) config.json and a real IndexDb for the proposal/
 * audit-log history promotion is computed from.
 *
 *   node test/trust.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const home = mkdtempSync(path.join(tmpdir(), 'lanshare-trust-'));
process.env.LANSHARE_HOME = home;

const configLib = require(path.join(here, '..', 'lib', 'config.js'));
const trust = require(path.join(here, '..', 'lib', 'trust.js'));
const { IndexDb } = require(path.join(here, '..', 'lib', 'index-db.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

try {
  configLib.loadOrCreate();

  // --- level storage -----------------------------------------------------

  check('an action type with no stored level defaults to ask',
    trust.getTrustLevel(configLib.load(), 'trip_cluster') === 'ask');

  trust.setTrustLevel('trip_cluster', 'ghost');
  check('setTrustLevel persists and getTrustLevel reads it back',
    trust.getTrustLevel(configLib.load(), 'trip_cluster') === 'ghost');

  check('a different action type is unaffected',
    trust.getTrustLevel(configLib.load(), 'camera_correction') === 'ask');

  trust.setTrustLevel('trip_cluster', 'auto');
  check('a level can be raised again', trust.getTrustLevel(configLib.load(), 'trip_cluster') === 'auto');

  check('an unknown level is refused, not silently stored', (() => {
    try { trust.setTrustLevel('trip_cluster', 'sometimes'); return false; } catch (err) { return err instanceof trust.TrustError; }
  })());

  check('getTrustLevel tolerates a config with no trust key at all', trust.getTrustLevel({}, 'trip_cluster') === 'ask');
  check('and a completely empty config object', trust.getTrustLevel(undefined, 'trip_cluster') === 'ask');

  // --- promotion eligibility ------------------------------------------------

  {
    const dbDir = mkdtempSync(path.join(tmpdir(), 'lanshare-trust-db-'));
    const db = new IndexDb(path.join(dbDir, 'index.db'));
    try {
      configLib.save({ ...configLib.load(), trust: {} });

      let el = trust.promotionEligibility(db, configLib.load(), 'trip_cluster');
      check('with no history at all, ask is not yet eligible for promotion',
        el.currentLevel === 'ask' && el.eligibleFor === null, JSON.stringify(el));

      // Two approvals — under the threshold of 3.
      for (let i = 0; i < 2; i++) {
        db.createProposal({ id: `p${i}`, kind: 'trip_cluster', subjectId: `c${i}`, ast: {}, summary: 's' });
        db.setProposalStatus(`p${i}`, 'approved');
      }
      el = trust.promotionEligibility(db, configLib.load(), 'trip_cluster');
      check('two approvals is not yet enough to offer promotion',
        el.eligibleFor === null && el.evidence.consecutiveApprovals === 2, JSON.stringify(el));

      // A third approval crosses the threshold.
      db.createProposal({ id: 'p2', kind: 'trip_cluster', subjectId: 'c2', ast: {}, summary: 's' });
      db.setProposalStatus('p2', 'approved');
      el = trust.promotionEligibility(db, configLib.load(), 'trip_cluster');
      check('three consecutive approvals with no rejection offers promotion to ghost',
        el.eligibleFor === 'ghost', JSON.stringify(el));

      // A rejection breaks the streak — only counts what's newer than it.
      db.createProposal({ id: 'p3', kind: 'trip_cluster', subjectId: 'c3', ast: {}, summary: 's' });
      db.setProposalStatus('p3', 'rejected');
      db.createProposal({ id: 'p4', kind: 'trip_cluster', subjectId: 'c4', ast: {}, summary: 's' });
      db.setProposalStatus('p4', 'approved');
      el = trust.promotionEligibility(db, configLib.load(), 'trip_cluster');
      check('a rejection resets the streak — only the one approval after it counts',
        el.evidence.consecutiveApprovals === 1, JSON.stringify(el));

      // A different action type has its own independent history.
      el = trust.promotionEligibility(db, configLib.load(), 'camera_correction');
      check('a different action type has its own, unrelated streak',
        el.evidence.consecutiveApprovals === 0, JSON.stringify(el));

      // Ghost -> auto, based on ghost-logged evidence, not approvals.
      trust.setTrustLevel('trip_cluster', 'ghost');
      el = trust.promotionEligibility(db, configLib.load(), 'trip_cluster');
      check('at ghost level, eligibility is based on ghost logs, not approvals',
        el.currentLevel === 'ghost' && el.eligibleFor === null, JSON.stringify(el));

      for (let i = 0; i < 5; i++) {
        db.appendAuditLog({ actionType: 'trip_cluster', subjectId: `g${i}`, decision: 'ghost-logged' });
      }
      el = trust.promotionEligibility(db, configLib.load(), 'trip_cluster');
      check('five ghost-logged decisions offers promotion to auto',
        el.eligibleFor === 'auto', JSON.stringify(el));

      // A demotion resets the ghost-log streak too.
      db.appendAuditLog({ actionType: 'trip_cluster', subjectId: 'demote-1', decision: 'demoted' });
      db.appendAuditLog({ actionType: 'trip_cluster', subjectId: 'g5', decision: 'ghost-logged' });
      el = trust.promotionEligibility(db, configLib.load(), 'trip_cluster');
      check('a demotion resets the ghost-log streak', el.evidence.ghostLogs === 1, JSON.stringify(el));

      // Auto has nothing left to be promoted to.
      trust.setTrustLevel('trip_cluster', 'auto');
      el = trust.promotionEligibility(db, configLib.load(), 'trip_cluster');
      check('auto is never offered a further promotion', el.eligibleFor === null && el.currentLevel === 'auto');
    } finally {
      db.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  }
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error during the test run -> ${err.stack || err.message}`);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
