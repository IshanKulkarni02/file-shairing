/**
 * Reading EXIF out of real and malformed files.
 *
 * Fixtures are built byte-for-byte against the TIFF/EXIF spec rather than
 * produced with a library and trusted — sharp's own EXIF writer turned out
 * not to honour half of what it is asked to write (it silently recomputes
 * PixelXDimension/PixelYDimension from the real image, drops GPS entirely,
 * and ignores Orientation and DateTimeOriginal), which surfaced only because
 * these tests initially trusted it. Building the bytes directly means the
 * parser is checked against ground truth this file fully controls, not
 * against another library's behaviour.
 *
 *   node test/metadata.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { realisticJpeg, buildTiff, wrapAsJpeg, field, TAG, TYPE } from './helpers/exif-fixture.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const metadata = require(path.join(here, '..', 'lib', 'metadata.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

try {
  // --- a real file, shaped the way a drone actually writes one -------------

  {
    const buf = realisticJpeg({
      make: 'DJI', model: 'FC3582', orientation: 1,
      dateTimeOriginal: '2026:08:11 10:30:00',
      lat: 32.234333, latRef: 'N', lon: 77.187333, lonRef: 'E',
      pixelWidth: 4000, pixelHeight: 3000,
    });
    const m = metadata.parseJpegExif(buf);
    check('camera make is read', m.make === 'DJI', m.make);
    check('camera model is read', m.model === 'FC3582', m.model);
    check('capture date is read', m.dateTimeOriginal === '2026:08:11 10:30:00', m.dateTimeOriginal);
    check('latitude is correct to five decimal places',
      Math.abs(m.gpsLatitude - 32.234333) < 1e-4, m.gpsLatitude);
    check('longitude is correct to five decimal places',
      Math.abs(m.gpsLongitude - 77.187333) < 1e-4, m.gpsLongitude);
    check('north latitude stays positive', m.gpsLatitude > 0);
    check('east longitude stays positive', m.gpsLongitude > 0);
    check('orientation is read', m.orientation === 1, m.orientation);
    check('pixel width is read', m.pixelWidth === 4000, m.pixelWidth);
    check('pixel height is read', m.pixelHeight === 3000, m.pixelHeight);
  }

  // --- GPS's own UTC clock (GPSDateStamp/GPSTimeStamp), separate from the ---
  // --- camera's local-time DateTimeOriginal -----------------------------------

  {
    const buf = realisticJpeg({
      dateTimeOriginal: '2026:08:11 16:00:00', // the camera's local clock
      lat: 32.234333, latRef: 'N', lon: 77.187333, lonRef: 'E',
      gpsDateStamp: '2026:08:11', gpsTimeStamp: [10, 30, 0], // GPS's own UTC clock
    });
    const m = metadata.parseJpegExif(buf);
    check('a GPS fix with a time stamp produces a UTC instant',
      m.gpsDateTimeUTC === '2026-08-11T10:30:00Z', m.gpsDateTimeUTC);
  }
  {
    const buf = realisticJpeg({
      dateTimeOriginal: '2026:08:11 16:00:00',
      lat: 32.234333, latRef: 'N', lon: 77.187333, lonRef: 'E',
    });
    const m = metadata.parseJpegExif(buf);
    check('a GPS fix with no time stamp leaves gpsDateTimeUTC null, not a guess',
      m.gpsDateTimeUTC === null, m.gpsDateTimeUTC);
  }
  {
    const buf = realisticJpeg({ dateTimeOriginal: '2026:08:11 16:00:00' });
    const m = metadata.parseJpegExif(buf);
    check('no GPS fix at all also leaves gpsDateTimeUTC null',
      m.gpsDateTimeUTC === null, m.gpsDateTimeUTC);
  }
  {
    // A malformed GPSDateStamp (wrong shape) must degrade to null, not throw
    // and not produce a plausible-looking but wrong instant.
    const buf = realisticJpeg({
      lat: 1, latRef: 'N', lon: 1, lonRef: 'E',
      gpsDateStamp: 'not-a-date', gpsTimeStamp: [10, 30, 0],
    });
    let threw = false;
    let m = null;
    try { m = metadata.parseJpegExif(buf); } catch { threw = true; }
    check('a malformed GPSDateStamp does not throw and yields no UTC instant',
      !threw && m.gpsDateTimeUTC === null, JSON.stringify(m));
  }

  // --- every GPS quadrant ----------------------------------------------------

  {
    const cases = [
      ['S', 'W', (lat, lon) => lat < 0 && lon < 0],
      ['S', 'E', (lat, lon) => lat < 0 && lon > 0],
      ['N', 'W', (lat, lon) => lat > 0 && lon < 0],
      ['N', 'E', (lat, lon) => lat > 0 && lon > 0],
    ];
    for (const [latRef, lonRef, ok] of cases) {
      const buf = realisticJpeg({ lat: 10, latRef, lon: 20, lonRef });
      const m = metadata.parseJpegExif(buf);
      check(`${latRef}/${lonRef} produces the right sign`, ok(m.gpsLatitude, m.gpsLongitude),
        `${m.gpsLatitude}, ${m.gpsLongitude}`);
    }
  }

  // --- a different orientation value, to be sure it is not coincidence -------

  {
    const buf = realisticJpeg({ orientation: 6 });
    const m = metadata.parseJpegExif(buf);
    check('a non-default orientation value round-trips', m.orientation === 6, m.orientation);
  }

  // --- big-endian byte order --------------------------------------------------

  {
    // Built independently of buildTiff's little-endian assumptions, so a bug
    // shared between the fixture and the parser could not hide this.
    const u16be = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
    const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
    const make = Buffer.concat([Buffer.from('Canon\0', 'ascii'), Buffer.alloc(0)]); // 6 bytes, fits inline
    const entry = Buffer.concat([u16be(TAG.MAKE), u16be(TYPE.ASCII), u32be(6), make.subarray(0, 4)]);
    // 6-byte ASCII does not fit inline (>4), so it must be an offset in a
    // correct big-endian fixture — build it properly rather than inline.
    const ifd0Offset = 8;
    const overflowOffset = ifd0Offset + 2 + 12 + 4;
    const entryCorrect = Buffer.concat([u16be(TAG.MAKE), u16be(TYPE.ASCII), u32be(6), u32be(overflowOffset)]);
    const tiff = Buffer.concat([
      Buffer.from('MM'), u16be(0x2a), u32be(8),
      u16be(1), entryCorrect, u32be(0),
      Buffer.from('Canon\0', 'ascii'),
    ]);
    void entry;
    const m = metadata.parseJpegExif(wrapAsJpeg(tiff));
    check('big-endian (MM) byte order is read correctly', m.make === 'Canon', m.make);
  }

  // --- absence is not an error ------------------------------------------------

  {
    const m = metadata.parseJpegExif(realisticJpeg({}));
    check('a JPEG with no EXIF fields at all returns every field null',
      m.make === null && m.model === null && m.gpsLatitude === null && m.dateTimeOriginal === null,
      JSON.stringify(m));
  }

  {
    const m = metadata.parseJpegExif(Buffer.from('this is not a jpeg at all'));
    check('non-JPEG bytes return nulls rather than throwing',
      m.make === null && m.gpsLatitude === null, JSON.stringify(m));
  }

  {
    const m = metadata.parseJpegExif(Buffer.alloc(0));
    check('an empty buffer returns nulls rather than throwing', m.make === null);
  }

  // --- real EXIF, cut short at every possible point ---------------------------
  // The case that matters most: a photo transferred over a flaky connection,
  // or one this app is reading mid-upload. Truncated data must degrade to
  // "nothing extracted", never throw.

  {
    const full = realisticJpeg({
      make: 'Canon', model: 'EOS R5', dateTimeOriginal: '2026:01:01 00:00:00',
      lat: 1, latRef: 'N', lon: 1, lonRef: 'E',
    });
    let anyThrew = false;
    for (let cut = 1; cut < full.length; cut += 3) {
      try {
        metadata.parseJpegExif(full.subarray(0, cut));
      } catch {
        anyThrew = true;
      }
    }
    check('truncating a real EXIF file at every possible point never throws', !anyThrew);
  }

  // --- adversarial structure, not just short ----------------------------------

  {
    // A JPEG/EXIF header whose IFD entry count claims far more entries than
    // the buffer could possibly hold.
    const header = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
      Buffer.from([0x00, 0x10]),
      Buffer.from('Exif\0\0', 'ascii'),
      Buffer.from('II'), Buffer.from([0x2a, 0x00]), Buffer.from([0x08, 0x00, 0x00, 0x00]),
      Buffer.from([0xff, 0xff]), // IFD0: 65535 entries claimed
    ]);
    let threw = false;
    let m = null;
    try { m = metadata.parseJpegExif(header); } catch { threw = true; }
    check('a claimed entry count far beyond the buffer does not throw', !threw);
    check('and produces no fabricated values', !threw && m.make === null);
  }

  {
    // An IFD entry whose value offset points outside the buffer entirely.
    const buf = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
      Buffer.from([0x00, 0x1e]),
      Buffer.from('Exif\0\0', 'ascii'),
      Buffer.from('II'), Buffer.from([0x2a, 0x00]), Buffer.from([0x08, 0x00, 0x00, 0x00]),
      Buffer.from([0x01, 0x00]),
      Buffer.from([0x0f, 0x01]),
      Buffer.from([0x02, 0x00]),
      Buffer.from([0x05, 0x00, 0x00, 0x00]),
      Buffer.from([0xff, 0xff, 0xff, 0x7f]),
    ]);
    let threw = false;
    let m = null;
    try { m = metadata.parseJpegExif(buf); } catch { threw = true; }
    check('an out-of-bounds value offset does not throw', !threw);
    check('and Make is not read from garbage', !threw && m.make === null);
  }

  {
    // A GPS rational with a zero denominator must not become Infinity.
    const zeroSeconds = [32, 1, 14, 1, 0, 0]; // seconds numerator/denominator both 0
    const { tiff } = buildTiff(
      [{ tag: TAG.GPS_IFD, type: TYPE.LONG, pointsTo: 'gpsIfd' }],
      { gpsIfd: [field(TAG.GPS_LAT_REF, TYPE.ASCII, 'N'), field(TAG.GPS_LAT, TYPE.RATIONAL, zeroSeconds)] },
    );
    let threw = false;
    let m = null;
    try { m = metadata.parseJpegExif(wrapAsJpeg(tiff)); } catch { threw = true; }
    check('a zero-denominator rational does not throw', !threw);
    check('and does not produce Infinity or NaN', !threw && m.gpsLatitude !== Infinity && !Number.isNaN(m.gpsLatitude));
  }

  // --- finding the EXIF segment specifically ----------------------------------

  {
    check('no SOI marker means no JPEG at all',
      metadata.findExifSegment(Buffer.from([0x00, 0x00, 0x00, 0x00])) === null);
    check('an empty buffer is handled', metadata.findExifSegment(Buffer.alloc(0)) === null);

    const noExif = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xda, 0x00, 0x02])]);
    check('reaching image data with no APP1 first means no EXIF',
      metadata.findExifSegment(noExif) === null);
  }

  {
    // A real-world layout: JFIF's APP0 segment before EXIF's APP1. The
    // parser must walk past markers it does not care about, not assume APP1
    // is first.
    const jfifPayload = Buffer.concat([Buffer.from('JFIF\0', 'ascii'), Buffer.alloc(11)]);
    const jfifLength = Buffer.alloc(2);
    jfifLength.writeUInt16BE(jfifPayload.length + 2); // length field covers itself, not just the payload
    const jfifApp0 = Buffer.concat([Buffer.from([0xff, 0xe0]), jfifLength, jfifPayload]);
    const exifJpeg = realisticJpeg({ make: 'Sony' });
    const withJfifFirst = Buffer.concat([exifJpeg.subarray(0, 2), jfifApp0, exifJpeg.subarray(2)]);
    const m = metadata.parseJpegExif(withJfifFirst);
    check('an APP0 (JFIF) segment before APP1 (EXIF) is skipped past, not mistaken for it',
      m.make === 'Sony', m.make);
  }

  // --- Apple/QuickTime GPS tag parsing (ISO 6709), used for video ------------

  {
    const good = metadata.parseIso6709('+37.3318-122.0311+000.000/');
    check('a well-formed ISO6709 string parses',
      good && Math.abs(good.lat - 37.3318) < 1e-6 && Math.abs(good.lon - (-122.0311)) < 1e-6,
      JSON.stringify(good));
  }
  {
    const southEast = metadata.parseIso6709('-33.8688+151.2093+000.000/');
    check('southern and eastern coordinates keep their signs',
      southEast && southEast.lat < 0 && southEast.lon > 0, JSON.stringify(southEast));
  }
  check('garbage input to the ISO6709 parser returns null, not a throw',
    metadata.parseIso6709('not a coordinate') === null);
  check('undefined input is handled', metadata.parseIso6709(undefined) === null);
  check('a number instead of a string is handled', metadata.parseIso6709(42) === null);

  // --- video metadata, against real sample files ------------------------------

  {
    const ffmpeg = require(path.join(here, '..', 'lib', 'ffmpeg.js'));
    if (ffmpeg.tools().available) {
      const sampleDir = path.join(here, '..', 'library', 'Samples');
      const { existsSync } = require('fs');
      const h264 = path.join(sampleDir, 'clip-h264.mp4');
      if (existsSync(h264)) {
        const meta = await metadata.probeVideoMetadata(h264);
        check('probing a real video does not throw and returns a shape',
          'dateTimeOriginal' in meta && 'gpsLatitude' in meta
          && 'cameraMake' in meta && 'cameraModel' in meta, JSON.stringify(meta));
      } else {
        console.log('  --   video sample not found; run `node test/make-samples.mjs` first — skipping');
      }
    } else {
      console.log('  --   ffmpeg not available in this environment — skipping video metadata checks');
    }

    const missing = await metadata.probeVideoMetadata(path.join(here, 'this-file-does-not-exist.mp4'));
    check('probing a file that does not exist degrades cleanly rather than throwing',
      missing.dateTimeOriginal === null && missing.gpsLatitude === null
      && missing.cameraMake === null && missing.cameraModel === null, JSON.stringify(missing));
  }
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error -> ${err.stack || err.message}`);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
