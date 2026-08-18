'use strict';

/**
 * Reading what a camera already wrote into a file, so a rule can act on it.
 *
 * "Drone shots go in the drone folder" is not a judgement call — a DJI stamps
 * its model into every file. A rule reading that field is exact, instant and
 * testable; nothing here is inferred or guessed. That is the whole point of
 * building this before anything AI-shaped: metadata answers the question
 * outright, so guessing is never necessary for it.
 *
 * No EXIF library is used. The format is a bounded, well-documented binary
 * structure, and every camera/phone file this app will ever see is untrusted
 * input — something a person uploaded, not something this app wrote — so the
 * parser is held to the same rule as lib/frames.js: never throw, never trust
 * a length or offset without checking it against the buffer first, and never
 * loop on data an attacker controls. A malformed photo must degrade to "no
 * metadata", not take down whatever is indexing the library.
 */

const { spawn } = require('child_process');
const ffmpeg = require('./ffmpeg.js');

// ---------------------------------------------------------------------------
// JPEG / EXIF
// ---------------------------------------------------------------------------

const TIFF_TAG = {
  MAKE: 0x010f,
  MODEL: 0x0110,
  ORIENTATION: 0x0112,
  EXIF_IFD: 0x8769,
  GPS_IFD: 0x8825,
};
const EXIF_TAG = {
  DATE_TIME_ORIGINAL: 0x9003,
  PIXEL_X: 0xa002,
  PIXEL_Y: 0xa003,
};
const GPS_TAG = {
  LAT_REF: 0x0001,
  LAT: 0x0002,
  LON_REF: 0x0003,
  LON: 0x0004,
  TIME_STAMP: 0x0007,
  DATE_STAMP: 0x001d,
};

/** Bytes per EXIF field type, 0 for anything not read here. */
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

/**
 * Find the EXIF payload inside a JPEG: the bytes after "Exif\0\0" in the
 * first APP1 segment. Walks the marker chain rather than searching for the
 * signature blindly, since a thumbnail or a photo *of* a JPEG file can
 * contain that byte sequence without it meaning what it looks like.
 */
function findExifSegment(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;

  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) return null; // not a marker where one was expected
    const marker = buf[pos + 1];
    // SOS (start of scan): metadata markers are always before this, so
    // whatever follows is compressed image data, not more segments.
    if (marker === 0xda) return null;
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { pos += 2; continue; }

    if (pos + 4 > buf.length) return null;
    const length = buf.readUInt16BE(pos + 2);
    if (length < 2 || pos + 2 + length > buf.length) return null;

    if (marker === 0xe1) { // APP1
      const body = buf.subarray(pos + 4, pos + 2 + length);
      if (body.length >= 6 && body.toString('ascii', 0, 6) === 'Exif\0\0') {
        return body.subarray(6);
      }
    }
    pos += 2 + length;
  }
  return null;
}

/**
 * A cursor over one byte order's worth of reads, bounds-checked throughout.
 *
 * Every read16/read32 here is unchecked on purpose — callers must ask ok16
 * or ok32 first. That split is what lets readIfd check an entry once and
 * then read its fields without re-checking each one.
 */
function tiffReader(buf, littleEndian) {
  const inBounds = (offset, size) => offset >= 0 && offset + size <= buf.length;
  return {
    ok16: (o) => inBounds(o, 2),
    ok32: (o) => inBounds(o, 4),
    read16: (o) => (littleEndian ? buf.readUInt16LE(o) : buf.readUInt16BE(o)),
    read32: (o) => (littleEndian ? buf.readUInt32LE(o) : buf.readUInt32BE(o)),
    inBounds,
  };
}

/**
 * One IFD's worth of tags, as { tagNumber: {type, count, valueOrOffset, entryOffset} }.
 * Bounds-checked entry by entry; a truncated or lying entry count yields
 * however many entries actually fit rather than reading past the buffer.
 */
function readIfd(buf, r, ifdOffset) {
  const tags = new Map();
  if (!r.ok16(ifdOffset)) return tags;

  const count = r.read16(ifdOffset);
  const maxByLength = Math.floor((buf.length - (ifdOffset + 2)) / 12);
  const safeCount = Math.min(count, Math.max(0, maxByLength));

  for (let i = 0; i < safeCount; i++) {
    const entryOffset = ifdOffset + 2 + i * 12;
    if (!r.ok32(entryOffset + 8)) break;
    const tag = r.read16(entryOffset);
    const type = r.read16(entryOffset + 2);
    const rawCount = r.read32(entryOffset + 4);
    tags.set(tag, { type, count: rawCount, entryOffset });
  }
  return tags;
}

/** The bytes an entry's value lives in — inline if it fits in 4 bytes, else at an offset. */
function entryBytes(buf, r, entry) {
  const size = (TYPE_SIZE[entry.type] || 1) * entry.count;
  if (size <= 4) return { offset: entry.entryOffset + 8, length: size };
  if (!r.ok32(entry.entryOffset + 8)) return null;
  const offset = r.read32(entry.entryOffset + 8);
  if (!r.inBounds(offset, size)) return null;
  return { offset, length: size };
}

function readAscii(buf, r, entry) {
  const loc = entryBytes(buf, r, entry);
  if (!loc) return null;
  // EXIF ASCII fields are NUL-terminated; trailing padding is not part of
  // the string, and the terminator must not end up in a value used later to
  // build a folder name.
  const raw = buf.toString('latin1', loc.offset, loc.offset + loc.length);
  const nul = raw.indexOf('\0');
  return (nul === -1 ? raw : raw.slice(0, nul)).trim() || null;
}

/** One RATIONAL (8 bytes: LONG numerator / LONG denominator). Zero denominator is invalid, not infinity. */
function readRational(buf, littleEndian, offset) {
  const num = littleEndian ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
  const den = littleEndian ? buf.readUInt32LE(offset + 4) : buf.readUInt32BE(offset + 4);
  if (den === 0) return null;
  return num / den;
}

/** Three RATIONALs (degrees, minutes, seconds) → decimal degrees. */
function readDms(buf, r, littleEndian, entry) {
  const loc = entryBytes(buf, r, entry);
  if (!loc || loc.length < 24) return null;
  const deg = readRational(buf, littleEndian, loc.offset);
  const min = readRational(buf, littleEndian, loc.offset + 8);
  const sec = readRational(buf, littleEndian, loc.offset + 16);
  if (deg === null || min === null || sec === null) return null;
  return deg + min / 60 + sec / 3600;
}

/** Three RATIONALs (hour, minute, second) — GPSTimeStamp, always UTC per the EXIF spec. */
function readTimeTriplet(buf, r, littleEndian, entry) {
  const loc = entryBytes(buf, r, entry);
  if (!loc || loc.length < 24) return null;
  const h = readRational(buf, littleEndian, loc.offset);
  const m = readRational(buf, littleEndian, loc.offset + 8);
  const s = readRational(buf, littleEndian, loc.offset + 16);
  if (h === null || m === null || s === null) return null;
  return { h, m, s };
}

/**
 * Parse a JPEG's EXIF block into the handful of fields a sorting rule can
 * act on. Never throws: a photo this cannot make sense of comes back with
 * every field null, which is indistinguishable from "no EXIF" to a caller —
 * exactly the degradation a corrupt or unusual file should get.
 */
function parseJpegExif(buffer) {
  const empty = {
    make: null, model: null, orientation: null,
    dateTimeOriginal: null, gpsLatitude: null, gpsLongitude: null,
    gpsDateTimeUTC: null, pixelWidth: null, pixelHeight: null,
  };

  try {
    const exif = findExifSegment(buffer);
    if (!exif || exif.length < 8) return empty;

    const order = exif.toString('ascii', 0, 2);
    if (order !== 'II' && order !== 'MM') return empty;
    const littleEndian = order === 'II';
    const magic = littleEndian ? exif.readUInt16LE(2) : exif.readUInt16BE(2);
    if (magic !== 0x002a) return empty;
    const ifd0Offset = littleEndian ? exif.readUInt32LE(4) : exif.readUInt32BE(4);

    const r = {
      ok16: (o) => o >= 0 && o + 2 <= exif.length,
      ok32: (o) => o >= 0 && o + 4 <= exif.length,
      read16: (o) => (littleEndian ? exif.readUInt16LE(o) : exif.readUInt16BE(o)),
      read32: (o) => (littleEndian ? exif.readUInt32LE(o) : exif.readUInt32BE(o)),
      inBounds: (o, size) => o >= 0 && o + size <= exif.length,
    };

    const ifd0 = readIfd(exif, r, ifd0Offset);
    const make = ifd0.has(TIFF_TAG.MAKE) ? readAscii(exif, r, ifd0.get(TIFF_TAG.MAKE)) : null;
    const model = ifd0.has(TIFF_TAG.MODEL) ? readAscii(exif, r, ifd0.get(TIFF_TAG.MODEL)) : null;
    const orientationEntry = ifd0.get(TIFF_TAG.ORIENTATION);
    const orientation = orientationEntry
      ? (littleEndian
        ? exif.readUInt16LE(orientationEntry.entryOffset + 8)
        : exif.readUInt16BE(orientationEntry.entryOffset + 8))
      : null;

    let dateTimeOriginal = null;
    let pixelWidth = null;
    let pixelHeight = null;
    const exifIfdEntry = ifd0.get(TIFF_TAG.EXIF_IFD);
    if (exifIfdEntry) {
      const exifIfdOffset = littleEndian
        ? exif.readUInt32LE(exifIfdEntry.entryOffset + 8)
        : exif.readUInt32BE(exifIfdEntry.entryOffset + 8);
      if (r.inBounds(exifIfdOffset, 2)) {
        const subIfd = readIfd(exif, r, exifIfdOffset);
        if (subIfd.has(EXIF_TAG.DATE_TIME_ORIGINAL)) {
          dateTimeOriginal = readAscii(exif, r, subIfd.get(EXIF_TAG.DATE_TIME_ORIGINAL));
        }
        if (subIfd.has(EXIF_TAG.PIXEL_X)) {
          const e = subIfd.get(EXIF_TAG.PIXEL_X);
          pixelWidth = e.type === 3
            ? (littleEndian ? exif.readUInt16LE(e.entryOffset + 8) : exif.readUInt16BE(e.entryOffset + 8))
            : (littleEndian ? exif.readUInt32LE(e.entryOffset + 8) : exif.readUInt32BE(e.entryOffset + 8));
        }
        if (subIfd.has(EXIF_TAG.PIXEL_Y)) {
          const e = subIfd.get(EXIF_TAG.PIXEL_Y);
          pixelHeight = e.type === 3
            ? (littleEndian ? exif.readUInt16LE(e.entryOffset + 8) : exif.readUInt16BE(e.entryOffset + 8))
            : (littleEndian ? exif.readUInt32LE(e.entryOffset + 8) : exif.readUInt32BE(e.entryOffset + 8));
        }
      }
    }

    let gpsLatitude = null;
    let gpsLongitude = null;
    let gpsDateTimeUTC = null;
    const gpsIfdEntry = ifd0.get(TIFF_TAG.GPS_IFD);
    if (gpsIfdEntry) {
      const gpsIfdOffset = littleEndian
        ? exif.readUInt32LE(gpsIfdEntry.entryOffset + 8)
        : exif.readUInt32BE(gpsIfdEntry.entryOffset + 8);
      if (r.inBounds(gpsIfdOffset, 2)) {
        const gpsIfd = readIfd(exif, r, gpsIfdOffset);
        const latRef = gpsIfd.has(GPS_TAG.LAT_REF) ? readAscii(exif, r, gpsIfd.get(GPS_TAG.LAT_REF)) : null;
        const lonRef = gpsIfd.has(GPS_TAG.LON_REF) ? readAscii(exif, r, gpsIfd.get(GPS_TAG.LON_REF)) : null;
        const lat = gpsIfd.has(GPS_TAG.LAT) ? readDms(exif, r, littleEndian, gpsIfd.get(GPS_TAG.LAT)) : null;
        const lon = gpsIfd.has(GPS_TAG.LON) ? readDms(exif, r, littleEndian, gpsIfd.get(GPS_TAG.LON)) : null;
        if (lat !== null) gpsLatitude = latRef === 'S' ? -lat : lat;
        if (lon !== null) gpsLongitude = lonRef === 'W' ? -lon : lon;

        // GPSDateStamp + GPSTimeStamp are the fix's own clock, always UTC per
        // the EXIF spec — unlike DateTimeOriginal, which is the camera's
        // local clock with no offset recorded. When both are present they
        // are a genuine, timezone-independent instant; a photo with no GPS
        // fix has no such anchor and stays naive-local (see lib/indexer.js).
        const dateStampEntry = gpsIfd.get(GPS_TAG.DATE_STAMP);
        const gpsDateStamp = dateStampEntry ? readAscii(exif, r, dateStampEntry) : null;
        const timeStampEntry = gpsIfd.get(GPS_TAG.TIME_STAMP);
        const gpsTime = timeStampEntry ? readTimeTriplet(exif, r, littleEndian, timeStampEntry) : null;
        const dateMatch = gpsDateStamp ? /^(\d{4}):(\d{2}):(\d{2})$/.exec(gpsDateStamp) : null;
        if (dateMatch && gpsTime
          && Number.isFinite(gpsTime.h) && Number.isFinite(gpsTime.m) && Number.isFinite(gpsTime.s)) {
          const hh = String(Math.trunc(gpsTime.h)).padStart(2, '0');
          const mm = String(Math.trunc(gpsTime.m)).padStart(2, '0');
          const ss = String(Math.trunc(gpsTime.s)).padStart(2, '0');
          gpsDateTimeUTC = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T${hh}:${mm}:${ss}Z`;
        }
      }
    }

    return {
      make, model, orientation, dateTimeOriginal,
      gpsLatitude, gpsLongitude, gpsDateTimeUTC, pixelWidth, pixelHeight,
    };
  } catch {
    // Any unexpected shape — a field type this does not handle, an
    // arithmetic surprise — degrades to "nothing extracted" rather than
    // interrupting whatever is indexing the library.
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Video, via ffprobe
// ---------------------------------------------------------------------------

/**
 * Apple's QuickTime location tag: "+37.3318-122.0311+000.000/" (ISO 6709).
 * iPhones and many drones — including DJI, which records QuickTime MOV/MP4 —
 * write this into com.apple.quicktime.location.ISO6709 regardless of which
 * app is reading it back.
 */
function parseIso6709(text) {
  if (typeof text !== 'string') return null;
  const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(text.trim());
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

/**
 * Video capture time and GPS via ffprobe's format tags. A separate call from
 * lib/ffmpeg.js's `probe()` — that one is on the hot path for thumbnails and
 * deliberately asks for only what a thumbnail needs; this asks for more and
 * is only ever called once per file, during indexing.
 */
function probeVideoMetadata(file) {
  const { ffprobe } = ffmpeg.tools();
  if (!ffprobe) return Promise.resolve(emptyVideoMeta());

  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_entries', 'format=duration:format_tags=creation_time,location,com.apple.quicktime.location.ISO6709,make,model,com.apple.quicktime.make,com.apple.quicktime.model:stream=width,height:stream_tags=creation_time',
      file,
    ];
    const proc = spawn(ffprobe, args, { windowsHide: true });
    let out = '';
    proc.stdout.on('data', (chunk) => { out += chunk; });
    proc.on('error', () => resolve(emptyVideoMeta()));
    proc.on('close', (code) => {
      if (code !== 0) return resolve(emptyVideoMeta());
      try {
        const data = JSON.parse(out);
        const tags = data.format?.tags || {};
        const streamTags = (data.streams || []).map((s) => s.tags || {}).find((t) => t.creation_time) || {};
        const creationTime = tags.creation_time || streamTags.creation_time || null;

        const iso6709 = tags['com.apple.quicktime.location.ISO6709'] || tags.location || null;
        const gps = parseIso6709(iso6709);

        // Best-effort: not every action cam writes either namespace, in
        // which case both stay null and this file simply carries no camera
        // identity — no wrong guess, just no signal (see lib/indexer.js).
        const cameraMake = tags.make || tags['com.apple.quicktime.make'] || null;
        const cameraModel = tags.model || tags['com.apple.quicktime.model'] || null;

        resolve({
          dateTimeOriginal: creationTime,
          gpsLatitude: gps?.lat ?? null,
          gpsLongitude: gps?.lon ?? null,
          cameraMake, cameraModel,
          pixelWidth: Number(data.streams?.[0]?.width) || null,
          pixelHeight: Number(data.streams?.[0]?.height) || null,
        });
      } catch {
        resolve(emptyVideoMeta());
      }
    });
    setTimeout(() => proc.kill('SIGKILL'), 20000).unref();
  });
}

function emptyVideoMeta() {
  return {
    dateTimeOriginal: null, gpsLatitude: null, gpsLongitude: null,
    cameraMake: null, cameraModel: null, pixelWidth: null, pixelHeight: null,
  };
}

module.exports = {
  parseJpegExif,
  probeVideoMetadata,
  parseIso6709,
  // exported for tests
  findExifSegment,
};
