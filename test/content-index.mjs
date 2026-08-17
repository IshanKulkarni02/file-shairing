/**
 * lib/content-index.js's orchestration: which hashes get embedded, that a
 * second run only picks up what changed, and that a permanently-broken file
 * cannot wedge the whole batch. The real model is never involved here —
 * embedImageFile is injected — because proving CLIP's own embeddings are
 * meaningful is test/clip.mjs's job; this file's job is proving the loop
 * around it is correct regardless of what the embedder returns.
 *
 *   node test/content-index.mjs
 */

import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync,
} from 'node:fs';
import { stat as fsStat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { IndexDb } = require(path.join(here, '..', 'lib', 'index-db.js'));
const { buildContentIndex, BATCH_SIZE } = require(path.join(here, '..', 'lib', 'content-index.js'));
const clipLib = require(path.join(here, '..', 'lib', 'clip.js'));
const thumbs = require(path.join(here, '..', 'lib', 'thumbs.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms — likely stuck in a loop`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const roots = [];
function scratchLibrary() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lanshare-content-index-'));
  roots.push(dir);
  return dir;
}

async function writeJpeg(absPath, r, g, b) {
  mkdirSync(path.dirname(absPath), { recursive: true });
  const buf = await sharp({
    create: {
      width: 64, height: 64, channels: 3, background: { r, g, b },
    },
  }).jpeg().toBuffer();
  writeFileSync(absPath, buf);
}

/** A fake embedder: deterministic per hash-of-path, no model, no I/O beyond what's given. */
function fakeEmbedder({ fail: failFor = new Set() } = {}) {
  const calls = [];
  const fn = async (absPath) => {
    calls.push(absPath);
    if (failFor.has(absPath)) throw new Error('synthetic embedding failure');
    return new Float32Array(clipLib.EMBEDDING_DIMS).fill(0.1);
  };
  fn.calls = calls;
  return fn;
}

try {
  // --- a clean run embeds every eligible file exactly once --------------------

  {
    const library = scratchLibrary();
    await writeJpeg(path.join(library, 'a.jpg'), 200, 20, 20);
    await writeJpeg(path.join(library, 'b.jpg'), 20, 200, 20);
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));

    db.upsert({
      relPath: '/a.jpg', size: 1, mtimeMs: Date.now(), hash: 'hash-a', kind: 'image', encrypted: false,
    });
    db.upsert({
      relPath: '/b.jpg', size: 1, mtimeMs: Date.now(), hash: 'hash-b', kind: 'image', encrypted: false,
    });
    db.upsert({
      relPath: '/vault/c.jpg', size: 1, mtimeMs: Date.now(), hash: 'hash-c', kind: 'image', encrypted: true,
    });

    const embedder = fakeEmbedder();
    const progressEvents = [];
    const report = await buildContentIndex({
      library, db, embedImageFile: embedder, onProgress: (p) => progressEvents.push(p),
    });

    // The vault file's exclusion itself is index-db.mjs's job to prove
    // (hashesNeedingEmbedding() filters encrypted=1 at the SQL level); what
    // matters here is that this module's loop only ever processes what that
    // query hands it — so exactly 2 calls, not 3, is the meaningful check.
    check('the embedder was called exactly twice — never for the vault file', embedder.calls.length === 2,
      embedder.calls.length);
    check('both non-encrypted files were embedded', report.embedded === 2, report.embedded);
    check('nothing failed', report.failed.length === 0, JSON.stringify(report.failed));
    check('total reflects the embeddable universe, excluding the vault file', report.total === 2, report.total);
    check('progress events actually fired', progressEvents.length >= 2);
    check('the final progress event is marked done', progressEvents.at(-1).done === true);
    check('both hashes are now stored', db.countEmbedded(clipLib.MODEL_ID) === 2);

    // --- resumability: a second run does no redundant work ---------------------

    const secondReport = await buildContentIndex({ library, db, embedImageFile: embedder });
    check('a second run finds nothing left to embed', secondReport.embedded === 2 && embedder.calls.length === 2,
      `embedded=${secondReport.embedded} calls=${embedder.calls.length}`);

    db.close();
  }

  // --- a new file added later is picked up without re-touching old ones -------

  {
    const library = scratchLibrary();
    await writeJpeg(path.join(library, 'a.jpg'), 200, 20, 20);
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    db.upsert({
      relPath: '/a.jpg', size: 1, mtimeMs: Date.now(), hash: 'hash-a', kind: 'image', encrypted: false,
    });

    const embedder = fakeEmbedder();
    await buildContentIndex({ library, db, embedImageFile: embedder });
    check('one file embedded so far', embedder.calls.length === 1);

    await writeJpeg(path.join(library, 'new.jpg'), 20, 20, 200);
    db.upsert({
      relPath: '/new.jpg', size: 1, mtimeMs: Date.now(), hash: 'hash-new', kind: 'image', encrypted: false,
    });
    await buildContentIndex({ library, db, embedImageFile: embedder });
    // Thumbnail cache paths are content-hashed, not filename-based, so
    // identity is checked through the database's own idea of what got
    // embedded rather than by guessing at a path string.
    check('the second run embeds exactly one more file', embedder.calls.length === 2, embedder.calls.length);
    check('specifically the newly-added hash, not a re-embed of the old one',
      db.getEmbedding('hash-new', clipLib.MODEL_ID) !== null);

    db.close();
  }

  // --- a permanently-failing file is recorded, not looped on forever ----------

  {
    const library = scratchLibrary();
    await writeJpeg(path.join(library, 'good.jpg'), 200, 20, 20);
    await writeJpeg(path.join(library, 'bad.jpg'), 20, 20, 200);
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    db.upsert({
      relPath: '/good.jpg', size: 1, mtimeMs: Date.now(), hash: 'hash-good', kind: 'image', encrypted: false,
    });
    db.upsert({
      relPath: '/bad.jpg', size: 1, mtimeMs: Date.now(), hash: 'hash-bad', kind: 'image', encrypted: false,
    });

    // The embedder is only ever handed a *thumbnail* path (content-index.js
    // reuses lib/thumbs.js's cache, never the original file), so "make this
    // one file fail" means precomputing the real, cached thumbnail path here
    // and matching on that — buildContentIndex's own thumbs.get() call below
    // resolves to the exact same cache key (relPath + mtime + size + variant)
    // and hits this now-warm cache, so the two converge on one identical path.
    const badAbsPath = path.join(library, 'bad.jpg');
    const badThumbPath = await thumbs.get(library, badAbsPath, '/bad.jpg', await fsStat(badAbsPath), 'grid');
    const embedder = fakeEmbedder({ fail: new Set([badThumbPath]) });

    const report = await withTimeout(
      buildContentIndex({ library, db, embedImageFile: embedder }),
      15000,
      'buildContentIndex with one permanently-failing file',
    );

    check('the good file still got embedded', report.embedded === 1, report.embedded);
    check('the bad file is reported as failed, not silently dropped',
      report.failed.length === 1 && report.failed[0].hash === 'hash-bad', JSON.stringify(report.failed));
    check('the bad file was attempted exactly once, not retried in a loop',
      embedder.calls.filter((p) => p === badThumbPath).length === 1, embedder.calls.length);

    // Calling it again (as a person clicking "build" a second time would)
    // retries the failure fresh rather than remembering it forever — the
    // same "a cached failure cannot self-correct" reasoning lib/geocode.js
    // already applies to its own lookups.
    const secondReport = await withTimeout(
      buildContentIndex({ library, db, embedImageFile: embedder }),
      15000,
      'a second buildContentIndex call after a prior failure',
    );
    check('a later run retries the previously-failed file rather than remembering the failure forever',
      secondReport.failed.length === 1 && secondReport.failed[0].hash === 'hash-bad');

    db.close();
  }

  // --- a file present in the index but missing on disk fails cleanly ----------

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    db.upsert({
      relPath: '/ghost.jpg', size: 1, mtimeMs: Date.now(), hash: 'hash-ghost', kind: 'image', encrypted: false,
    });

    const embedder = fakeEmbedder();
    const report = await withTimeout(
      buildContentIndex({ library, db, embedImageFile: embedder }),
      15000,
      'buildContentIndex over a file missing from disk',
    );
    check('a file the index knows about but that no longer exists on disk is reported as failed',
      report.failed.length === 1 && report.failed[0].hash === 'hash-ghost', JSON.stringify(report.failed));
    check('and the run still completes rather than throwing', report.embedded === 0);

    db.close();
  }

  check('BATCH_SIZE is a sane positive number', Number.isInteger(BATCH_SIZE) && BATCH_SIZE > 0, BATCH_SIZE);
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error during the test run -> ${err.stack || err.message}`);
} finally {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
