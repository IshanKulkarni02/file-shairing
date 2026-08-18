/**
 * lib/assistant-tools.js: the tool inventory the assistant loop hands to
 * the model, against a real IndexDb and a real (scratch) library —
 * especially the trust-gating in invokeTool(), which is the part that
 * makes graduated trust actually apply to a general write tool, not just
 * Ghost Mode's own two proposal kinds.
 *
 *   node test/assistant-tools.mjs
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const tools = require(path.join(here, '..', 'lib', 'assistant-tools.js'));
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
  const library = mkdtempSync(path.join(tmpdir(), 'lanshare-assistant-tools-'));
  roots.push(library);
  const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
  opened.push(db);
  return { library, db };
}

function putFile(library, db, relPath, overrides = {}) {
  const abs = path.join(library, ...relPath.split('/').filter(Boolean));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, 'x');
  db.upsert({
    relPath, size: 1, mtimeMs: 1, hash: overrides.hash || relPath, kind: 'image', encrypted: 0,
    cameraMake: 'DJI', cameraModel: 'FC3582', capturedAt: '2026-08-01T10:00:00.000Z', capturedAtBasis: 'utc',
    gpsLat: null, gpsLon: null,
    ...overrides,
  });
}

try {
  // --- the schema surface --------------------------------------------------

  {
    const schemas = tools.toolSchemas();
    check('every tool has a name, description and parameters schema',
      schemas.every((s) => s.type === 'function' && s.function.name && s.function.description && s.function.parameters));
    check('read and write tools are both present',
      schemas.some((s) => s.function.name === 'search_library') && schemas.some((s) => s.function.name === 'save_rule'));
  }

  // --- read tools always just run -------------------------------------------

  {
    const { library, db } = scratch();
    putFile(library, db, '/Inbox/a.jpg');
    putFile(library, db, '/Inbox/b.jpg', { hash: 'h2', cameraMake: 'Apple', cameraModel: 'iPhone' });

    const described = await tools.invokeTool('describe_library', {}, { db });
    check('describe_library never runs the preview path', described.ranFor === 'real');
    check('describe_library reports the real camera set',
      described.result.cameras.includes('DJI FC3582') && described.result.cameras.includes('Apple iPhone'),
      JSON.stringify(described.result));

    const searched = await tools.invokeTool('search_library', { cameraMake: 'DJI' }, { db });
    check('search_library filters correctly', searched.result.results.length === 1
      && searched.result.results[0].path === '/Inbox/a.jpg', JSON.stringify(searched.result));

    let threw = false;
    try { await tools.invokeTool('not_a_real_tool', {}, { db }); } catch (err) { threw = err instanceof tools.AssistantToolError; }
    check('invoking an unknown tool throws AssistantToolError', threw);
  }

  {
    // detect_trips is a read-only preview of Discovery's own clustering —
    // must never write a trip_clusters row.
    const { library, db } = scratch();
    for (let i = 0; i < 4; i++) {
      putFile(library, db, `/Inbox/f${i}.jpg`, { hash: `h${i}`, capturedAt: new Date(Date.parse('2026-08-01T00:00:00Z') + i * 10 * 60 * 1000).toISOString() });
    }
    const result = await tools.invokeTool('detect_trips', {}, { db });
    check('detect_trips finds a candidate cluster', result.result.candidateTrips.length === 1, JSON.stringify(result.result));
    check('detect_trips writes nothing to the database', db.listTripClusters('proposed').length === 0);
  }

  {
    const { library, db } = scratch();
    sortRules.saveRulesText(library, 'when kind = image -> /Photos');
    const result = await tools.invokeTool('list_rules', {}, { library });
    check('list_rules reads back exactly what was saved',
      result.result.text === 'when kind = image -> /Photos' && result.result.ruleCount === 1, JSON.stringify(result.result));
  }

  {
    const { library, db } = scratch();
    putFile(library, db, '/Inbox/a.jpg');
    const result = await tools.invokeTool('preview_rule', { text: 'when kind = image -> /Sorted' }, { library, db });
    check('preview_rule computes a real plan without moving anything',
      result.result.moves.some((m) => m.path === '/Inbox/a.jpg'), JSON.stringify(result.result));
    check('and the file has not actually moved',
      require('node:fs').existsSync(path.join(library, 'Inbox', 'a.jpg')));
  }

  // --- write tools: trust-gated preview vs execute --------------------------

  {
    const { library, db } = scratch();
    putFile(library, db, '/Inbox/a.jpg');

    const asked = await tools.invokeTool('save_rule', { text: 'when kind = image -> /Photos' }, { library, db }, 'ask');
    check('at ask, save_rule returns a preview, not a real save', asked.ranFor === 'preview' && asked.trustLevel === 'ask');
    check('nothing was actually saved', sortRules.readRulesText(library) === '');
    check('no audit log entry for a plain ask decision', db.listAuditLog().length === 0);

    const ghosted = await tools.invokeTool('save_rule', { text: 'when kind = image -> /Photos' }, { library, db }, 'ghost');
    check('at ghost, save_rule still returns a preview, not a real save', ghosted.ranFor === 'preview' && ghosted.trustLevel === 'ghost');
    check('still nothing saved', sortRules.readRulesText(library) === '');
    check('but a ghost-logged audit entry is written',
      db.listAuditLog({ actionType: 'save_rule' }).some((e) => e.decision === 'ghost-logged'));

    const autoed = await tools.invokeTool('save_rule', { text: 'when kind = image -> /Photos' }, { library, db }, 'auto');
    check('at auto, save_rule actually executes', autoed.ranFor === 'real', JSON.stringify(autoed));
    check('the rule is genuinely saved this time', sortRules.readRulesText(library).includes('when kind = image'));
    check('an auto-approved audit entry is written',
      db.listAuditLog({ actionType: 'save_rule' }).some((e) => e.decision === 'auto-approved'));
  }

  {
    // apply_rules: preview must not move the file; execute must.
    const { library, db } = scratch();
    putFile(library, db, '/Inbox/a.jpg');
    sortRules.saveRulesText(library, 'when kind = image -> /Sorted');

    const preview = await tools.invokeTool('apply_rules', {}, { library, db }, 'ask');
    check('apply_rules at ask previews the move', preview.result.moves.some((m) => m.path === '/Inbox/a.jpg'));
    check('and does not actually move it', require('node:fs').existsSync(path.join(library, 'Inbox', 'a.jpg')));

    const executed = await tools.invokeTool('apply_rules', {}, { library, db }, 'auto');
    check('apply_rules at auto actually moves the file',
      executed.result.batch.moved.some((m) => m.from === '/Inbox/a.jpg'), JSON.stringify(executed.result));
    check('the file is genuinely gone from its old location',
      !require('node:fs').existsSync(path.join(library, 'Inbox', 'a.jpg')));
    check('and genuinely exists at the new one',
      require('node:fs').existsSync(path.join(library, 'Sorted', 'a.jpg')));
  }

  {
    // run_once: a one-off rule, never saved, only applied.
    const { library, db } = scratch();
    putFile(library, db, '/Inbox/a.jpg');
    const executed = await tools.invokeTool('run_once', { text: 'when kind = image -> /Once' }, { library, db }, 'auto');
    check('run_once at auto moves the file', executed.result.batch.moved.some((m) => m.from === '/Inbox/a.jpg'));
    check('but never saves a standing rule', sortRules.readRulesText(library) === '');
  }

  {
    // undo_last: always allowed, regardless of trust level passed.
    const { library, db } = scratch();
    putFile(library, db, '/Inbox/a.jpg');
    await tools.invokeTool('run_once', { text: 'when kind = image -> /Once' }, { library, db }, 'auto');
    const undone = await tools.invokeTool('undo_last', {}, { library, db }, 'ask'); // trust level irrelevant here
    check('undo_last runs for real even at "ask" — an escape hatch needing permission is not one',
      undone.ranFor === 'real' && undone.result.restored.includes('/Inbox/a.jpg'), JSON.stringify(undone));
    check('the file is genuinely back', require('node:fs').existsSync(path.join(library, 'Inbox', 'a.jpg')));
  }

  {
    // A malformed rule from the model must fail exactly like a hand-typed one would.
    const { library, db } = scratch();
    let threw = false;
    try { await tools.invokeTool('save_rule', { text: 'this is not a valid rule' }, { library, db }, 'ask'); } catch (err) { threw = true; }
    check('an unparseable rule draft throws rather than being silently accepted', threw);
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
