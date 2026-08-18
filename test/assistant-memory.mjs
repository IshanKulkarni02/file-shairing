/**
 * lib/assistant-memory.js: retrieval over remembered instruction/rule
 * pairs — keyword-overlap ranking, corrections weighted higher, a recent
 * correction always surfaced regardless of topic — against a real IndexDb.
 *
 *   node test/assistant-memory.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const memory = require(path.join(here, '..', 'lib', 'assistant-memory.js'));
const { IndexDb } = require(path.join(here, '..', 'lib', 'index-db.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

const roots = [];
const opened = [];
function scratchDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lanshare-assistant-memory-'));
  roots.push(dir);
  const db = new IndexDb(path.join(dir, '.lanshare', 'index.db'));
  opened.push(db);
  return db;
}

try {
  // --- tokenize / overlapScore, the primitives ------------------------------

  check('tokenize lowercases and strips punctuation', JSON.stringify(memory.tokenize('Drone shots -> /Drone!')) === JSON.stringify(['drone', 'shots', 'drone']));
  check('tokenize drops stopwords and single characters', !memory.tokenize('put my a photos').includes('a') && !memory.tokenize('put my photos').includes('my'));
  check('overlapScore counts shared tokens', memory.overlapScore(['drone', 'shots'], ['drone', 'video']) === 1);
  check('overlapScore is zero for no shared tokens', memory.overlapScore(['drone'], ['ride']) === 0);

  // --- closestExamples: no history at all -----------------------------------

  {
    const db = scratchDb();
    check('with no memory at all, nothing is retrieved', memory.closestExamples(db, 'drone shots').length === 0);
  }

  // --- topical relevance ------------------------------------------------------

  {
    const db = scratchDb();
    db.rememberInstruction({ instruction: 'drone shots go in /Drone', ruleText: 'when camera.make = "DJI" -> /Drone' });
    db.rememberInstruction({ instruction: 'iphone videos go in /Phone', ruleText: 'when camera.make = "Apple" and kind = video -> /Phone' });
    db.rememberInstruction({ instruction: 'sort by trip and camera', ruleText: 'when kind = image -> /Rides/{trip}/{camera}' });

    const examples = memory.closestExamples(db, 'put all my drone footage in the drone folder');
    check('the topically closest example ranks first', examples[0]?.instruction === 'drone shots go in /Drone', JSON.stringify(examples));

    const irrelevant = memory.closestExamples(db, 'xyzzy plugh qwerty');
    check('a query sharing no vocabulary with any memory returns nothing, not padding with unrelated history',
      irrelevant.length === 0, JSON.stringify(irrelevant));
  }

  // --- corrections are weighted higher at equal topical overlap --------------

  {
    const db = scratchDb();
    db.rememberInstruction({ instruction: 'sort ride photos by camera', ruleText: 'when kind = image -> /Rides/{camera}' });
    db.rememberInstruction({
      instruction: 'sort ride photos by camera', ruleText: 'when kind = image -> /Rides/{trip}/{day}/{camera}', isCorrection: true,
    });

    const examples = memory.closestExamples(db, 'sort ride photos by camera', { limit: 1 });
    check('at equal keyword overlap, the correction outranks the plain acceptance',
      examples[0]?.isCorrection === true, JSON.stringify(examples));
  }

  // --- a recent correction is always included, regardless of topic -----------

  {
    const db = scratchDb();
    for (let i = 0; i < 3; i++) {
      db.rememberInstruction({ instruction: `drone footage rule number ${i}`, ruleText: `when camera.make = "DJI" -> /Drone${i}` });
    }
    db.rememberInstruction({
      instruction: 'completely unrelated topic about audio files', ruleText: 'when kind = audio -> /Music', isCorrection: true,
    });

    const examples = memory.closestExamples(db, 'more drone footage sorting', { limit: 2 });
    check('the recent correction is included even though it shares no vocabulary with the query',
      examples.some((e) => e.isCorrection), JSON.stringify(examples));
  }

  // --- limit is respected -----------------------------------------------------

  {
    const db = scratchDb();
    for (let i = 0; i < 6; i++) {
      db.rememberInstruction({ instruction: `drone rule ${i}`, ruleText: `when camera.make = "DJI" -> /D${i}` });
    }
    check('limit caps the number of examples returned', memory.closestExamples(db, 'drone rule', { limit: 3 }).length === 3);
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
