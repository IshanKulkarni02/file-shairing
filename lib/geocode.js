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
const USER_AGENT = `LANShare/${require('../package.json').version} (personal self-hosted photo library)`;
const DEFAULT_MIN_INTERVAL_MS = 1000;
const CACHE_FILENAME = path.join('.lanshare', 'geocode-cache.json');

function cachePath(library) {
  return path.join(library, CACHE_FILENAME);
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

module.exports = { resolveMany, resolvePlace, loadCache, saveCache, cachePath, USER_AGENT };
