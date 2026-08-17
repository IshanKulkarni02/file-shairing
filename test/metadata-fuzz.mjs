/**
 * The EXIF parser against deliberately hostile input.
 *
 * lib/metadata.js parses binary that came from a file somebody uploaded —
 * the most untrusted input this app handles. Its own header promises it
 * will "never throw, never trust a length or offset without checking it,
 * and never loop on data an attacker controls", and a malformed photo must
 * degrade to "no metadata" rather than taking down whatever is indexing the
 * library. Reading the code can suggest that holds; only throwing a large
 * number of malformed files at it actually demonstrates it.
 *
 * Deterministic despite being a fuzzer: the generator is seeded, so a
 * failure here reproduces exactly rather than being a rumour about a
 * build that once went red.
 *
 *   node test/metadata-fuzz.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { realisticJpeg } from './helpers/exif-fixture.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const metadata = require(path.join(here, '..', 'lib', 'metadata.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

/** xorshift32 — small, seeded, and identical on every machine and Node version. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

const EMPTY_KEYS = [
  'make', 'model', 'orientation', 'dateTimeOriginal',
  'gpsLatitude', 'gpsLongitude', 'pixelWidth', 'pixelHeight',
];

/** Every field must be null or a sane primitive — never NaN, Infinity, or an object. */
function resultIsSane(result) {
  if (!result || typeof result !== 'object') return false;
  for (const key of EMPTY_KEYS) {
    if (!(key in result)) return false;
    const v = result[key];
    if (v === null) continue;
    if (typeof v === 'string') continue;
    if (typeof v === 'number' && Number.isFinite(v)) continue;
    return false;
  }
  return true;
}

const rand = rng(0xC0FFEE);
const byte = () => Math.floor(rand() * 256);

function randomBuffer(len) {
  const b = Buffer.alloc(len);
  for (let i = 0; i < len; i++) b[i] = byte();
  return b;
}

try {
  // --- pure noise -----------------------------------------------------------

  {
    let threw = null;
    let insane = 0;
    for (let i = 0; i < 3000; i++) {
      const buf = randomBuffer(Math.floor(rand() * 512));
      try {
        if (!resultIsSane(metadata.parseJpegExif(buf))) insane++;
      } catch (err) {
        threw = { i, err };
        break;
      }
    }
    check('3000 random buffers never throw', threw === null,
      threw && `iteration ${threw.i}: ${threw.err.message}`);
    check('and every result has the full null-shaped field set', insane === 0, `${insane} malformed results`);
  }

  // --- noise that starts like a real JPEG, so the marker walk actually runs --

  {
    let threw = null;
    for (let i = 0; i < 3000; i++) {
      const body = randomBuffer(Math.floor(rand() * 400) + 8);
      // A real SOI, then arbitrary bytes: this gets past the first gate in
      // findExifSegment and exercises the marker chain on hostile data.
      const buf = Buffer.concat([Buffer.from([0xff, 0xd8]), body]);
      try {
        metadata.parseJpegExif(buf);
      } catch (err) {
        threw = { i, err };
        break;
      }
    }
    check('3000 JPEG-shaped random buffers never throw', threw === null,
      threw && `iteration ${threw.i}: ${threw.err.message}`);
  }

  // --- a real EXIF file, then every single byte corrupted in turn ------------
  // The nastiest case for a bounds bug: structurally valid enough to walk
  // deep into the IFD chain, with one field lying about a length or offset.

  {
    const valid = realisticJpeg({
      make: 'DJI', model: 'FC3582',
      dateTimeOriginal: '2026:03:15 10:30:00',
      lat: 48.8566, latRef: 'N', lon: 2.3522, lonRef: 'E',
      pixelWidth: 4000, pixelHeight: 3000,
    });

    const baseline = metadata.parseJpegExif(valid);
    check('the uncorrupted fixture still parses correctly',
      baseline.make === 'DJI' && baseline.pixelWidth === 4000, JSON.stringify(baseline));

    let threw = null;
    let insane = 0;
    // Every byte, flipped to three different values — exhaustive over
    // position rather than sampled, since the header is where the dangerous
    // lengths and offsets live.
    for (let pos = 0; pos < valid.length && !threw; pos++) {
      for (const replacement of [0x00, 0xff, 0x7f]) {
        const corrupted = Buffer.from(valid);
        corrupted[pos] = replacement;
        try {
          if (!resultIsSane(metadata.parseJpegExif(corrupted))) insane++;
        } catch (err) {
          threw = { pos, replacement, err };
          break;
        }
      }
    }
    check(`every single-byte corruption of a real EXIF file (${valid.length * 3} variants) never throws`,
      threw === null,
      threw && `byte ${threw.pos} -> 0x${threw.replacement.toString(16)}: ${threw.err.message}`);
    check('and none produced NaN, Infinity or a non-primitive field', insane === 0, `${insane} bad results`);
  }

  // --- truncation at every length -------------------------------------------

  {
    const valid = realisticJpeg({ make: 'Canon', model: 'EOS R5', lat: 10, latRef: 'N', lon: 20, lonRef: 'E' });
    let threw = null;
    for (let len = 0; len <= valid.length && !threw; len++) {
      try {
        metadata.parseJpegExif(valid.subarray(0, len));
      } catch (err) {
        threw = { len, err };
      }
    }
    check(`truncating a real EXIF file at all ${valid.length + 1} lengths never throws`,
      threw === null, threw && `length ${threw.len}: ${threw.err.message}`);
  }

  // --- a parser that finishes, on input designed to make it loop ------------
  // A lying IFD entry count is the classic way to walk a parser off the end
  // or spin it; readIfd clamps to what actually fits.

  {
    const started = Date.now();
    for (let i = 0; i < 500; i++) {
      // "Exif\0\0" + a TIFF header claiming an absurd IFD offset and count.
      const tiff = Buffer.alloc(64);
      tiff.write('II', 0, 'ascii');
      tiff.writeUInt16LE(0x002a, 2);
      tiff.writeUInt32LE(8, 4);
      tiff.writeUInt16LE(0xffff, 8); // 65535 entries in a 64-byte buffer
      const exif = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
      const app1 = Buffer.alloc(4);
      app1[0] = 0xff; app1[1] = 0xe1;
      app1.writeUInt16BE(exif.length + 2, 2);
      metadata.parseJpegExif(Buffer.concat([Buffer.from([0xff, 0xd8]), app1, exif]));
    }
    const elapsed = Date.now() - started;
    check('an IFD claiming 65535 entries in a 64-byte buffer finishes promptly, 500 times over',
      elapsed < 2000, `${elapsed}ms`);
  }
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error during the fuzz run -> ${err.stack || err.message}`);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
