'use strict';

/**
 * Asking every paired machine the same question a local search just
 * answered, and merging the two into one list.
 *
 * A "peer" here is exactly a lib/connections.js connection — the same list
 * the desktop app's Connections screen already manages, reachable directly
 * on the LAN or over the relay, however that connection happens to be set
 * up. Nothing new is paired or trusted for this; a stored connection was
 * already a credential on another machine, and this is one more thing that
 * credential is used for.
 *
 * **Why this only ever runs for a local admin.** A connection's password
 * lives in the OS keychain, not the browser session — asking a peer to
 * search is asking it *as whatever account this connection is signed in
 * with there*, which may be a broader identity than the local account that
 * triggered the search. Letting any signed-in local viewer transitively
 * exercise a stored admin-on-another-machine credential would be exactly the
 * kind of boundary this project has gotten wrong before (the vault-blind
 * routes fixed after the Phase B audit). The caller (lib/server-app.js)
 * enforces this; this module does not re-check it, but does not trust that
 * it was skipped, either — it simply never runs without a secrets store.
 *
 * **Why results are cached, and what "cached" does not mean.** A file is
 * remembered in a small per-peer SQLite file (schema borrowed unchanged from
 * lib/index-db.js) whenever it comes back from a *live* query. That is not a
 * background mirror of the peer's whole library — nothing here ever asks a
 * peer for "everything", and a file that peer holds but that was never part
 * of a search result while both machines were online will not appear from
 * cache. The trade favours honesty over completeness: what is cached was
 * really seen, not synthesised, and is always labelled with when.
 */

const path = require('path');
const P = require('./paths');
const { IndexDb, dbRowToResult, resultToUpsertEntry } = require('./index-db');
const connectionsLib = require('./connections');

const DEFAULT_TIMEOUT_MS = 4000;

function peerCachePath(library, peerId) {
  return path.join(library, P.INTERNAL_DIR, 'peers', `${peerId}.db`);
}

/**
 * Settles when `factory()` does, or rejects first after `ms`.
 *
 * Deliberately not `Promise.race([factory(), timeout])`: the race's loser is
 * never cancelled, so if `factory()` were left unobserved after losing, a
 * peer that finally answers (or fails) after this function has already
 * moved on would surface as an unhandled rejection sometime later, for
 * seemingly no reason. Attaching the two-argument `.then` here means that
 * outcome is always observed, even when nothing is still waiting for it.
 */
function withTimeout(factory, ms, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(message));
    }, ms);

    factory().then(
      (value) => { clearTimeout(timer); if (!settled) { settled = true; resolve(value); } },
      (err) => { clearTimeout(timer); if (!settled) { settled = true; reject(err); } },
    );
  });
}

function toQueryString(params) {
  const qs = new URLSearchParams();
  if (params.text) qs.set('q', params.text);
  if (params.kind) qs.set('kind', params.kind);
  if (params.cameraMake) qs.set('camera', params.cameraMake);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.near) {
    qs.set('near_lat', String(params.near.lat));
    qs.set('near_lon', String(params.near.lon));
    if (params.radiusKm) qs.set('radius_km', String(params.radiusKm));
  }
  if (params.limit) qs.set('limit', String(params.limit));
  return qs.toString();
}

async function liveSearch({ config, conn, secrets, params }) {
  const host = await connectionsLib.connect(config, conn.id, { secrets });
  try {
    const body = await host.json(`/api/search?${toQueryString(params)}`);
    return Array.isArray(body?.results) ? body.results : [];
  } finally {
    // The relay-wrapped host exposes close(); a direct RemoteHost does not
    // need it and simply forgets its cookie. Both leave nothing running.
    host.signOut?.();
    host.close?.();
  }
}

/**
 * A peer's raw /api/search row, stripped down to one flat fact: this file,
 * these bytes, at this path, on this one machine. A peer that is itself an
 * admin account with its own connections configured returns rows that
 * already carry their own `locations` array — its own view of the world,
 * from a search this machine happened to make of it. That view is never
 * propagated; every row here is tagged exactly once, by the one machine
 * that was actually asked, not by whatever that machine additionally knew.
 */
function stripPeerRow(row) {
  const { locations: _peerOwnLocations, ...clean } = row;
  return clean;
}

function withLocation(row, location) {
  return { ...row, _location: location };
}

function taggedFromCache(cache, conn, params, error) {
  const rows = cache.search(params).map(dbRowToResult);
  return {
    results: rows.map((r) => withLocation(stripPeerRow(r), {
      source: conn.id, label: conn.label, path: r.path, reachable: false, cachedAt: conn.lastConnected || null,
    })),
    report: { id: conn.id, label: conn.label, reachable: false, error },
  };
}

async function searchOnePeer({ library, config, conn, secrets, params, timeoutMs }) {
  const cache = new IndexDb(peerCachePath(library, conn.id));
  try {
    if (!secrets?.available) {
      return taggedFromCache(cache, conn, params, 'No saved password for this machine on this session');
    }

    let results;
    try {
      results = await withTimeout(
        () => liveSearch({ config, conn, secrets, params }),
        timeoutMs,
        `${conn.label || conn.id} did not answer in time`,
      );
    } catch (err) {
      return taggedFromCache(cache, conn, params, err.message);
    }

    // Cached for the next time this machine is unreachable. A row with no
    // hash is not stored — hash is the only key this cache is ever looked up
    // by, via the exact same merge that ran to produce `results` just now.
    for (const result of results) {
      if (result.hash) cache.upsert(resultToUpsertEntry(result));
    }
    return {
      results: results.map((r) => withLocation(stripPeerRow(r), {
        source: conn.id, label: conn.label, path: r.path, reachable: true, cachedAt: null,
      })),
      report: { id: conn.id, label: conn.label, reachable: true },
    };
  } finally {
    cache.close();
  }
}

function localLocation(row) {
  return { source: 'local', label: 'This machine', path: row.path, reachable: true, cachedAt: null };
}

/** local < a peer answering live < a peer answered from cache. */
function rankOf(location) {
  if (location.source === 'local') return 0;
  return location.reachable ? 1 : 2;
}

/**
 * Group tagged rows by content hash into one result per distinct file, each
 * naming everywhere it was found. A row with no hash — should not happen for
 * a successfully-indexed file, but never assumed — is never merged with
 * anything: two results that merely look similar is a safer failure than one
 * result quietly conflating two different files.
 *
 * The top-level fields (name, kind, size, capturedAt, ...) come from the
 * best-ranked location in the group, so a peer's possibly-stale cached
 * metadata never shadows what a reachable machine — local or not — reports
 * right now.
 */
function mergeByHash(taggedRows, { near = null } = {}) {
  const groups = new Map();
  const standalone = [];

  for (const row of taggedRows) {
    // `locations` is excluded along with `_location`, not just overwritten
    // afterwards: a peer that is itself admin-and-federated (talking to it
    // live is calling its own /api/search) reports rows that already carry
    // their own `locations` array, describing *that machine's* view of the
    // world. Left in `fields`, Object.assign(entry, fields) below would
    // clobber the array this function is building with that stale one the
    // moment this row is ranked best — which is not hypothetical, it is
    // exactly what happens on every two-server search once the peer is
    // itself an admin account, i.e. in the ordinary case.
    const { _location: location, locations: _peerOwnLocations, ...fields } = row;
    if (!fields.hash) {
      standalone.push({ ...fields, locations: [{ ...location, primary: true }] });
      continue;
    }
    let entry = groups.get(fields.hash);
    if (!entry) {
      entry = { ...fields, locations: [], _rank: Infinity };
      groups.set(fields.hash, entry);
    }
    entry.locations.push(location);
    const rank = rankOf(location);
    if (rank < entry._rank) {
      Object.assign(entry, fields);
      entry._rank = rank;
      // The top-level fields (name, path, ...) just above came from this
      // location, so the client can tell which of possibly several entries
      // in `locations` those fields actually describe, instead of guessing.
      for (const l of entry.locations) delete l.primary;
      location.primary = true;
    }
  }

  const merged = [...groups.values(), ...standalone];
  for (const entry of merged) delete entry._rank;

  merged.sort(near
    ? (a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity)
    : (a, b) => (b.capturedAt || '').localeCompare(a.capturedAt || '') || (a.path || '').localeCompare(b.path || ''));

  return merged;
}

/**
 * Search every paired machine and merge with what was already found
 * locally. Always runs the merge, even with zero peers configured — the
 * same pass is also what collapses two local copies of one file (uploaded
 * twice, say) into a single result naming both paths, which is worth having
 * regardless of federation.
 */
async function federatedSearch({ library, config, secrets, localResults, params, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const localTagged = localResults.map((r) => withLocation(r, localLocation(r)));
  const connectionList = config.connections || [];

  if (!connectionList.length) {
    return { results: mergeByHash(localTagged, { near: params.near }), peers: [] };
  }

  const outcomes = await Promise.all(connectionList.map((conn) =>
    searchOnePeer({ library, config, conn, secrets, params, timeoutMs })));

  // Each outcome's results are already tagged with their own location —
  // searchOnePeer() is the one place responsible for that — so they join
  // the local ones directly rather than being tagged a second time here.
  const peerTagged = outcomes.flatMap((outcome) => outcome.results);

  return {
    results: mergeByHash([...localTagged, ...peerTagged], { near: params.near }),
    peers: outcomes.map((outcome) => outcome.report),
  };
}

module.exports = { federatedSearch, mergeByHash, peerCachePath, DEFAULT_TIMEOUT_MS };
