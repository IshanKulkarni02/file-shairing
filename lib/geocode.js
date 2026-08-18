'use strict';

/**
 * Turning a place name a rule mentions — "Manali" — into coordinates a file's
 * own GPS metadata can actually be compared against.
 *
 * Uses OpenStreetMap's Nominatim, the one geocoder that needs no account, no
 * API key, and no billing relationship before a single line of this could be
 * tested — the same reasoning Phase J chose the relay over GitHub for.
 * Nominatim's usage policy asks for two things in return: a real User-Agent
 * identifying the application, and no more than one request per second. Both
 * are honoured here, not left to whoever calls this.
 *
 * A resolved place is cached to disk (a city's coordinates do not move) so
 * the same rule set never re-resolves the same name twice, and so a
 * dry-run or a re-application of the same rules costs no network calls at
 * all after the first time each place was ever seen.
 *
 * Never throws for an ordinary failure — no network, the service is down,
 * the place does not exist. lib/sort-rules.js's contract for a "gps near"
 * clause is that an unresolvable place simply never matches, not that the
 * whole sort blows up because one place name was misspelled.
 */

const fs = require('fs');
const path = require('path');

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const USER_AGENT = `LANShare/${require('../package.json').version} (personal self-hosted photo library)`;
const DEFAULT_MIN_INTERVAL_MS = 1000;
const CACHE_FILENAME = path.join('.lanshare', 'geocode-cache.json');
// A separate file, not a second section of the same cache: forward keys are
// place names and reverse keys are rounded coordinates, two different
// keyspaces that have no reason to ever collide or be read together.
const REVERSE_CACHE_FILENAME = path.join('.lanshare', 'reverse-geocode-cache.json');

function cachePath(library) {
  return path.join(library, CACHE_FILENAME);
}

function reverseCachePath(library) {
  return path.join(library, REVERSE_CACHE_FILENAME);
}

function loadCache(library) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(library), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveCache(library, cache) {
  const file = cachePath(library);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 1));
  fs.renameSync(tmp, file);
}

/** Normalises a place name into a stable cache key — matching is meant to be forgiving of case and stray spaces, not exact-string. */
function cacheKey(place) {
  return place.trim().toLowerCase();
}

function loadReverseCache(library) {
  try {
    const parsed = JSON.parse(fs.readFileSync(reverseCachePath(library), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveReverseCache(library, cache) {
  const file = reverseCachePath(library);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 1));
  fs.renameSync(tmp, file);
}

/**
 * Buckets coordinates to ~110m (3 decimal places) so nearby points within
 * the same trip share one cache entry and one network call, rather than
 * every slightly-different GPS reading paying for its own reverse lookup —
 * exactly the granularity a trip name needs, not exact-point precision.
 */
function reverseCacheKey(lat, lon) {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

/**
 * The most specific settlement-level name Nominatim's address breakdown
 * offers, falling back to broader regions and finally to the first segment
 * of the full formatted address — good enough for a proposed trip label
 * ("Manali"), not a full postal address.
 */
function placeNameFromAddress(body) {
  const addr = body?.address || {};
  const specific = addr.city || addr.town || addr.village || addr.hamlet
    || addr.county || addr.state_district || addr.state;
  if (specific) return specific;
  const display = typeof body?.display_name === 'string' ? body.display_name : '';
  const first = display.split(',')[0]?.trim();
  return first || null;
}

async function fetchOne(place, { fetchImpl }) {
  const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(place)}`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
  } catch {
    return null; // no network, DNS failure, timeout — never fatal
  }
  if (!res.ok) return null;

  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const first = Array.isArray(body) ? body[0] : null;
  if (!first) return null;

  const lat = Number(first.lat);
  const lon = Number(first.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

/**
 * Resolve every place in `places` to `{lat, lon}` or null, cached to disk
 * under `library`. Only places not already cached ever touch the network,
 * and even those are spaced at least `minIntervalMs` apart — Nominatim's
 * own policy, not a number picked at random.
 *
 * @returns {Promise<Map<string, {lat:number, lon:number} | null>>} keyed by
 *   the *original* place strings passed in, in the same order.
 */
async function resolveMany(places, {
  library, fetchImpl = (...args) => fetch(...args), minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
} = {}) {
  const cache = loadCache(library);
  const result = new Map();
  let changed = false;
  let lastRequestAt = 0;

  for (const place of places) {
    const key = cacheKey(place);
    if (Object.prototype.hasOwnProperty.call(cache, key)) {
      result.set(place, cache[key]);
      continue;
    }

    const waitFor = lastRequestAt + minIntervalMs - Date.now();
    // eslint-disable-next-line no-await-in-loop
    if (waitFor > 0) await new Promise((resolve) => { setTimeout(resolve, waitFor); });
    lastRequestAt = Date.now();

    // eslint-disable-next-line no-await-in-loop
    const point = await fetchOne(place, { fetchImpl });
    result.set(place, point);
    // Only a real resolution is cached. A miss might be a misspelled place
    // that will never resolve, but it might just as easily be Nominatim
    // being unreachable this one time — and unlike a successful lookup, a
    // cached failure has no way to ever self-correct. Retrying costs one
    // more request the next time this place is evaluated, which only
    // happens when someone is actively working with rules, never on a
    // background loop.
    if (point) {
      cache[key] = point;
      changed = true;
    }
  }

  if (changed) saveCache(library, cache);
  return result;
}

/** Resolve a single place. Prefer resolveMany() when resolving several — it shares one cache load/save and one throttle across all of them. */
async function resolvePlace(place, options) {
  const resolved = await resolveMany([place], options);
  return resolved.get(place) ?? null;
}

async function fetchReverseOne(lat, lon, { fetchImpl }) {
  const url = `${NOMINATIM_REVERSE_URL}?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=10`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
  } catch {
    return null; // no network, DNS failure, timeout — never fatal
  }
  if (!res.ok) return null;

  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  return placeNameFromAddress(body);
}

/**
 * Reverse-geocode several centroids — the inverse of resolveMany(), with its
 * own cache keyspace (rounded coordinates rather than place-name strings)
 * and the same discipline: only a cache miss ever touches the network, spaced
 * at least `minIntervalMs` apart, and only a real resolution is cached — an
 * unreachable Nominatim today should not permanently deny a name to a trip
 * that could resolve fine tomorrow.
 *
 * @returns {Promise<Array<string|null>>} one name per input point, in order.
 */
async function reverseGeocodeMany(points, {
  library, fetchImpl = (...args) => fetch(...args), minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
} = {}) {
  const cache = loadReverseCache(library);
  const result = [];
  let changed = false;
  let lastRequestAt = 0;

  for (const { lat, lon } of points) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { result.push(null); continue; }
    const key = reverseCacheKey(lat, lon);
    if (Object.prototype.hasOwnProperty.call(cache, key)) {
      result.push(cache[key]);
      continue;
    }

    const waitFor = lastRequestAt + minIntervalMs - Date.now();
    // eslint-disable-next-line no-await-in-loop
    if (waitFor > 0) await new Promise((resolve) => { setTimeout(resolve, waitFor); });
    lastRequestAt = Date.now();

    // eslint-disable-next-line no-await-in-loop
    const name = await fetchReverseOne(lat, lon, { fetchImpl });
    result.push(name);
    if (name) {
      cache[key] = name;
      changed = true;
    }
  }

  if (changed) saveReverseCache(library, cache);
  return result;
}

/**
 * Reverse-geocode a single centroid, for suggesting a trip's label from its
 * GPS centroid. Prefer reverseGeocodeMany() when resolving several — it
 * shares one cache load/save and one throttle across all of them, the same
 * relationship resolvePlace() has to resolveMany().
 *
 * Never throws: a trip with no resolvable name still gets proposed in Ghost
 * Mode, just without a suggested label, exactly like an unresolvable "gps
 * near" place simply never matches rather than failing the whole sort.
 */
async function reverseGeocode(lat, lon, options) {
  const [name] = await reverseGeocodeMany([{ lat, lon }], options);
  return name ?? null;
}

module.exports = {
  resolveMany, resolvePlace, loadCache, saveCache, cachePath,
  reverseGeocode, reverseGeocodeMany, loadReverseCache, saveReverseCache, reverseCachePath,
  USER_AGENT,
};
