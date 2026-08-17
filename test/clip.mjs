/**
 * lib/clip.js against the real local model — no fake, no injected response.
 *
 * Unlike lib/nl-rules.js's Ollama dependency (a server this app never runs
 * itself, genuinely unreachable in any test environment), CLIP inference
 * runs in-process: the only external dependency is a one-time model download
 * from Hugging Face, which a real network connection satisfies exactly once
 * per machine (subsequent runs and the rest of this suite reuse the cache).
 * That makes a real test both possible and the right call here — this file
 * is deliberately not a fake-model test the way test/nl-rules.mjs had to be.
 *
 * Slow (a several-hundred-MB download on a cold cache) — registered with
 * slow:true in test/run-all.mjs so `--quick` skips it.
 *
 *   node test/clip.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  mkdtempSync, writeFileSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const HOME = mkdtempSync(path.join(tmpdir(), 'lanshare-clip-test-'));
process.env.LANSHARE_HOME = HOME;

const clip = require(path.join(here, '..', 'lib', 'clip.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function norm(v) {
  return Math.sqrt(dot(v, v));
}

async function solidJpeg(name, r, g, b) {
  const buf = await sharp({
    create: {
      width: 128, height: 128, channels: 3, background: { r, g, b },
    },
  }).jpeg().toBuffer();
  const p = path.join(HOME, name);
  writeFileSync(p, buf);
  return p;
}

try {
  // --- the model cache lives under LANSHARE_HOME's server state, not node_modules ---

  check('cacheDir points inside this test\'s LANSHARE_HOME, not node_modules',
    clip.cacheDir().startsWith(HOME) && !clip.cacheDir().includes('node_modules'), clip.cacheDir());
  check('isCached is false before anything has been loaded', clip.isCached() === false);

  // --- real embeddings, real ranking --------------------------------------
  // Solid colours are about as unambiguous as CLIP gets: a real, deterministic
  // correctness check rather than a vibes-based "it probably works".

  const redPath = await solidJpeg('red.jpg', 220, 20, 20);
  const bluePath = await solidJpeg('blue.jpg', 20, 20, 220);

  const redEmb = await clip.embedImageFile(redPath);
  const blueEmb = await clip.embedImageFile(bluePath);
  const redText = await clip.embedText('a photo of the color red');
  const blueText = await clip.embedText('a photo of the color blue');

  check('the model is marked cached once it has actually loaded', clip.isCached() === true);
  check('an image embedding has the documented dimensionality',
    redEmb.length === clip.EMBEDDING_DIMS, String(redEmb.length));
  check('a text embedding has the same dimensionality as an image embedding',
    redText.length === clip.EMBEDDING_DIMS, String(redText.length));
  check('embeddings are unit-normalized (image)', Math.abs(norm(redEmb) - 1) < 1e-3, String(norm(redEmb)));
  check('embeddings are unit-normalized (text)', Math.abs(norm(redText) - 1) < 1e-3, String(norm(redText)));

  const simRedRed = dot(redEmb, redText);
  const simRedBlue = dot(redEmb, blueText);
  const simBlueRed = dot(blueEmb, redText);
  const simBlueBlue = dot(blueEmb, blueText);

  check('a red image ranks "red" text above "blue" text', simRedRed > simRedBlue,
    `red-red=${simRedRed.toFixed(4)} red-blue=${simRedBlue.toFixed(4)}`);
  check('a blue image ranks "blue" text above "red" text', simBlueBlue > simBlueRed,
    `blue-blue=${simBlueBlue.toFixed(4)} blue-red=${simBlueRed.toFixed(4)}`);
  check('a red image is closer to a "red" query than a blue image is', simRedRed > simBlueRed,
    `red-red=${simRedRed.toFixed(4)} blue-red=${simBlueRed.toFixed(4)}`);

  // --- determinism ----------------------------------------------------------

  const redEmbAgain = await clip.embedImageFile(redPath);
  const maxDiff = Math.max(...redEmb.map((v, i) => Math.abs(v - redEmbAgain[i])));
  check('embedding the same file twice gives the same vector', maxDiff < 1e-5, String(maxDiff));

  // --- concurrent load (ensureModel's whole reason to exist) ----------------

  {
    const freshHome = mkdtempSync(path.join(tmpdir(), 'lanshare-clip-test-concurrent-'));
    // A brand-new process-wide state is not achievable without re-requiring
    // the module in a subprocess, which would also re-download the model.
    // What is actually exercised here — and the part that would misbehave if
    // ensureModel() started a second load instead of sharing the first — is
    // that concurrent embedding calls right now do not throw or corrupt each
    // other's output, using the module's already-loaded singleton.
    const greenPath = path.join(freshHome, 'green.jpg');
    writeFileSync(greenPath, await sharp({
      create: {
        width: 64, height: 64, channels: 3, background: {
          r: 20, g: 200, b: 20,
        },
      },
    }).jpeg().toBuffer());

    const [a, b] = await Promise.all([clip.embedImageFile(greenPath), clip.embedImageFile(greenPath)]);
    check('concurrent embed calls both resolve to the same vector', dot(a, b) > 0.9999, String(dot(a, b)));
    rmSync(freshHome, { recursive: true, force: true });
  }

  // --- a file that cannot be decoded fails clearly, not silently -----------

  {
    const badPath = path.join(HOME, 'not-an-image.jpg');
    writeFileSync(badPath, Buffer.from('this is not image data'));
    let rejected = null;
    try {
      await clip.embedImageFile(badPath);
    } catch (err) {
      rejected = err;
    }
    check('a file that is not a real image throws rather than returning garbage', rejected instanceof Error, String(rejected));
  }

  check('the model cache directory actually exists on disk after loading', existsSync(clip.cacheDir()));
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error during the test run -> ${err.stack || err.message}`);
} finally {
  rmSync(HOME, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
