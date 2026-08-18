/**
 * A minimal, correct EXIF/TIFF fixture builder, shared by every test that
 * needs a real photo with real metadata in it.
 *
 * Built byte-for-byte against the TIFF/EXIF spec rather than produced with a
 * library and trusted — sharp's own EXIF writer turned out not to honour
 * half of what it is asked to write (it silently recomputes
 * PixelXDimension/PixelYDimension from the real image, drops GPS entirely,
 * and ignores Orientation and DateTimeOriginal), which surfaced only because
 * an earlier version of these tests trusted it. This exists once, here,
 * rather than once per test file, so a fixture bug gets fixed everywhere it
 * is used rather than needing to be independently rediscovered in each copy
 * — which is exactly what happened the first time this was duplicated.
 */

const TAG = {
  MAKE: 0x010f, MODEL: 0x0110, ORIENTATION: 0x0112,
  EXIF_IFD: 0x8769, GPS_IFD: 0x8825,
  DATE_TIME_ORIGINAL: 0x9003, PIXEL_X: 0xa002, PIXEL_Y: 0xa003,
  GPS_LAT_REF: 0x0001, GPS_LAT: 0x0002, GPS_LON_REF: 0x0003, GPS_LON: 0x0004,
  GPS_TIME_STAMP: 0x0007, GPS_DATE_STAMP: 0x001d,
};
const TYPE = { ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5 };

function field(tag, type, value) { return { tag, type, value }; }

function buildTiff(ifd0Fields, extraIfds = {}) {
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const rational = (num, den) => Buffer.concat([u32(num), u32(den)]);

  const order = ['ifd0', ...Object.keys(extraIfds)];
  const fieldSets = { ifd0: ifd0Fields, ...extraIfds };

  const ifdSize = (fields) => 2 + fields.length * 12 + 4;
  let cursor = 8;
  const ifdOffset = {};
  for (const name of order) {
    ifdOffset[name] = cursor;
    cursor += ifdSize(fieldSets[name]);
  }

  const overflow = [];
  let overflowCursor = cursor;
  function sizeOf(f) {
    if (f.type === TYPE.ASCII) return f.value.length + 1;
    if (f.type === TYPE.RATIONAL) return 8 * (f.value.length / 2);
    return 4;
  }
  for (const name of order) {
    for (const f of fieldSets[name]) {
      if (f.pointsTo) continue;
      const size = sizeOf(f);
      if (size > 4) {
        f._overflowOffset = overflowCursor;
        overflow.push(f);
        overflowCursor += size;
      }
    }
  }

  const header = Buffer.concat([Buffer.from('II'), u16(0x2a), u32(8)]);
  const ifdBufs = [];
  for (const name of order) {
    const fields = fieldSets[name];
    const parts = [u16(fields.length)];
    for (const f of fields) {
      let count = 1;
      let valueBytes;
      if (f.pointsTo) {
        count = 1;
        valueBytes = u32(ifdOffset[f.pointsTo]);
      } else if (f.type === TYPE.ASCII) {
        count = f.value.length + 1;
        const raw = Buffer.concat([Buffer.from(f.value, 'ascii'), Buffer.from([0])]);
        valueBytes = f._overflowOffset !== undefined ? u32(f._overflowOffset) : Buffer.concat([raw, Buffer.alloc(4 - raw.length)]);
      } else if (f.type === TYPE.RATIONAL) {
        count = f.value.length / 2;
        valueBytes = f._overflowOffset !== undefined ? u32(f._overflowOffset) : rational(f.value[0], f.value[1]);
      } else if (f.type === TYPE.SHORT) {
        valueBytes = Buffer.concat([u16(f.value), Buffer.alloc(2)]);
      } else if (f.type === TYPE.LONG) {
        valueBytes = u32(f.value);
      } else {
        valueBytes = Buffer.alloc(4);
      }
      parts.push(u16(f.tag), u16(f.type), u32(count), valueBytes);
    }
    parts.push(u32(0));
    ifdBufs.push(Buffer.concat(parts));
  }

  const overflowBufs = overflow.map((f) => {
    if (f.type === TYPE.ASCII) return Buffer.concat([Buffer.from(f.value, 'ascii'), Buffer.from([0])]);
    if (f.type === TYPE.RATIONAL) {
      const parts = [];
      for (let i = 0; i < f.value.length; i += 2) parts.push(rational(f.value[i], f.value[i + 1]));
      return Buffer.concat(parts);
    }
    return Buffer.alloc(0);
  });

  return { tiff: Buffer.concat([header, ...ifdBufs, ...overflowBufs]) };
}

function wrapAsJpeg(tiff, { padTo = 0 } = {}) {
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(body.length + 2);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), length, body, Buffer.from([0xff, 0xd9])]);
  // Padding is inserted as a harmless COM (comment) segment before EOI, so a
  // test can force two fixtures to differ in file size without touching the
  // EXIF bytes being asserted on — useful when what is under test is size-
  // based change detection, not EXIF parsing itself.
  if (!padTo || jpeg.length >= padTo) return jpeg;
  const padding = padTo - jpeg.length - 4;
  if (padding < 0) return jpeg;
  const comLength = Buffer.alloc(2);
  comLength.writeUInt16BE(padding + 2);
  const com = Buffer.concat([Buffer.from([0xff, 0xfe]), comLength, Buffer.alloc(padding)]);
  return Buffer.concat([jpeg.subarray(0, jpeg.length - 2), com, jpeg.subarray(jpeg.length - 2)]);
}

function toDms(decimal) {
  const abs = Math.abs(decimal);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = (minFloat - min) * 60;
  return [deg, 1, min, 1, Math.round(sec * 1000), 1000];
}

/**
 * A realistic photo: any of make, model, orientation, capture date, GPS,
 * pixel dimensions. Every field is optional; only what is passed is written.
 */
function realisticJpeg({
  make, model, orientation, dateTimeOriginal, lat, latRef, lon, lonRef,
  gpsDateStamp, gpsTimeStamp, pixelWidth, pixelHeight, padTo,
} = {}) {
  const ifd0 = [];
  if (make) ifd0.push(field(TAG.MAKE, TYPE.ASCII, make));
  if (model) ifd0.push(field(TAG.MODEL, TYPE.ASCII, model));
  if (orientation !== undefined) ifd0.push(field(TAG.ORIENTATION, TYPE.SHORT, orientation));

  const extra = {};
  const exifFields = [];
  if (dateTimeOriginal) exifFields.push(field(TAG.DATE_TIME_ORIGINAL, TYPE.ASCII, dateTimeOriginal));
  if (pixelWidth !== undefined) exifFields.push(field(TAG.PIXEL_X, TYPE.LONG, pixelWidth));
  if (pixelHeight !== undefined) exifFields.push(field(TAG.PIXEL_Y, TYPE.LONG, pixelHeight));
  if (exifFields.length) {
    extra.exifIfd = exifFields;
    ifd0.push({ tag: TAG.EXIF_IFD, type: TYPE.LONG, pointsTo: 'exifIfd' });
  }

  if (lat !== undefined && lon !== undefined) {
    extra.gpsIfd = [
      field(TAG.GPS_LAT_REF, TYPE.ASCII, latRef),
      field(TAG.GPS_LAT, TYPE.RATIONAL, toDms(lat)),
      field(TAG.GPS_LON_REF, TYPE.ASCII, lonRef),
      field(TAG.GPS_LON, TYPE.RATIONAL, toDms(lon)),
    ];
    // GPSDateStamp/GPSTimeStamp are the fix's own UTC clock — separate from
    // DateTimeOriginal, which is the camera's local-time clock with no
    // offset recorded. Only written when a test asks for them, since most
    // fixtures are testing something else and a GPS fix without a time
    // stamp (some real cameras) needs to stay representable too.
    if (gpsDateStamp) extra.gpsIfd.push(field(TAG.GPS_DATE_STAMP, TYPE.ASCII, gpsDateStamp));
    if (gpsTimeStamp) {
      const [h, m, s] = gpsTimeStamp;
      extra.gpsIfd.push(field(TAG.GPS_TIME_STAMP, TYPE.RATIONAL, [h, 1, m, 1, s, 1]));
    }
    ifd0.push({ tag: TAG.GPS_IFD, type: TYPE.LONG, pointsTo: 'gpsIfd' });
  }

  const { tiff } = buildTiff(ifd0, extra);
  return wrapAsJpeg(tiff, { padTo });
}

export { realisticJpeg, buildTiff, wrapAsJpeg, field, toDms, TAG, TYPE };
