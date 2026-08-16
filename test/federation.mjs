/**
 * lib/federation.js in isolation: merging by content hash, falling back to a
 * peer's cache when it cannot be reached live, and never hanging past its
 * own timeout regardless of how slow (or how eventually-successful) the real
 * connection attempt turns out to be.
 *
 * lib/connections.js's connect() is monkey-patched here rather than really
 * dialled — there is no real second machine in this file, only the merge and
 * caching logic around wherever a connection attempt lands. test/run-all.mjs
 * has a companion suite that spins up two real servers for the parts that
 * only a real HTTP round trip can prove.
 *
 *   node test/federation.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const federation = require(path.join(here, '..', 'lib', 'federation.js'));
const connectionsLib = require(path.join(here, '..', 'lib', 'connections.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

// A real unhandled rejection anywhere in this file is itself a failure — it
// is exactly the bug withTimeout() exists to prevent, so it is treated as
// one rather than left to crash the process with no test attribution.
let unhandled = null;
process.on('unhandledRejection', (err) => { unhandled = err; });

// ---------------------------------------------------------------------------
// mergeByHash — pure function, no I/O
// ---------------------------------------------------------------------------

const loc = (source, path_, extra = {}) => ({ source, label: source, path: path_, reachable: true, cachedAt: null, ...extra });
const tagged = (fields, location) => ({ ...fields, _location: location });

{
  const a = tagged({ hash: 'h1', path: '/A/one.jpg', name: 'one.jpg', capturedAt: '2026-01-01' }, loc('local', '/A/one.jpg'));
  const b = tagged({ hash: 'h2', path: '/B/two.jpg', name: 'two.jpg', capturedAt: '2026-02-01' }, loc('local', '/B/two.jpg'));
  const merged = federation.mergeByHash([a, b]);
  check('two different hashes stay as two separate results', merged.length === 2, JSON.stringify(merged));
  check('each keeps exactly its own single location', merged.every((m) => m.locations.length === 1));
  check('a result with only one location has it marked primary',
    merged.every((m) => m.locations[0].primary === true));
}

{
  const local = tagged({ hash: 'shared', path: '/Local/photo.jpg', name: 'photo.jpg', capturedAt: '2026-01-01' }, loc('local', '/Local/photo.jpg'));
  const peer = tagged({ hash: 'shared', path: '/Remote/photo.jpg', name: 'photo.jpg', capturedAt: '2026-01-01' }, loc('peer1', '/Remote/photo.jpg'));
  const merged = federation.mergeByHash([local, peer]);
  check('the same hash from local and a peer merges into one result', merged.length === 1, JSON.stringify(merged));
  check('the merged result names both locations', merged[0].locations.length === 2, JSON.stringify(merged[0]));
  check('both source machines are represented',
    new Set(merged[0].locations.map((l) => l.source)).size === 2, JSON.stringify(merged[0].locations));
}

{
  const p1 = tagged({ hash: 'h', path: '/P1/x.jpg', name: 'x.jpg', capturedAt: '2026-01-01' }, loc('peer1', '/P1/x.jpg'));
  const p2 = tagged({ hash: 'h', path: '/P2/x.jpg', name: 'x.jpg', capturedAt: '2026-01-01' }, loc('peer2', '/P2/x.jpg'));
  const p3 = tagged({ hash: 'h', path: '/P3/x.jpg', name: 'x.jpg', capturedAt: '2026-01-01' }, loc('peer3', '/P3/x.jpg'));
  const merged = federation.mergeByHash([p1, p2, p3]);
  check('three machines sharing one file produce one result naming all three',
    merged.length === 1 && merged[0].locations.length === 3, JSON.stringify(merged));
}

{
  const a = tagged({ hash: null, path: '/A/mystery', name: 'mystery', capturedAt: '2026-01-01' }, loc('local', '/A/mystery'));
  const b = tagged({ hash: null, path: '/B/mystery', name: 'mystery', capturedAt: '2026-01-01' }, loc('peer1', '/B/mystery'));
  const merged = federation.mergeByHash([a, b]);
  check('two hash-less rows are never merged into each other, even if identical otherwise',
    merged.length === 2, JSON.stringify(merged));
}

{
  // Local arrives last in the input array — rank must not depend on order.
  const cachedPeer = tagged(
    { hash: 'h', path: '/Peer/stale.jpg', name: 'stale-name.jpg', capturedAt: '2020-01-01' },
    loc('peer1', '/Peer/stale.jpg', { reachable: false, cachedAt: '2026-01-01' }),
  );
  const local = tagged(
    { hash: 'h', path: '/Local/fresh.jpg', name: 'fresh-name.jpg', capturedAt: '2026-06-01' },
    loc('local', '/Local/fresh.jpg'),
  );
  const merged = federation.mergeByHash([cachedPeer, local]);
  check('local metadata wins over a cached peer even when the peer row came first in the input',
    merged[0].name === 'fresh-name.jpg' && merged[0].path === '/Local/fresh.jpg', JSON.stringify(merged[0]));
  check('the lower-ranked location is still listed, just not primary', merged[0].locations.length === 2);

  const primaries = merged[0].locations.filter((l) => l.primary === true);
  check('exactly one location is marked primary', primaries.length === 1, JSON.stringify(merged[0].locations));
  check('the primary location is the local one, matching the top-level fields',
    primaries[0]?.source === 'local' && primaries[0]?.path === merged[0].path, JSON.stringify(primaries[0]));
  check('the cached peer location is explicitly not primary',
    merged[0].locations.find((l) => l.source === 'peer1').primary !== true);
}

{
  const reachable = tagged(
    { hash: 'h', path: '/Live/photo.jpg', name: 'live-name.jpg', capturedAt: '2026-01-01' },
    loc('peer1', '/Live/photo.jpg', { reachable: true }),
  );
  const cached = tagged(
    { hash: 'h', path: '/Cached/photo.jpg', name: 'cached-name.jpg', capturedAt: '2026-01-01' },
    loc('peer2', '/Cached/photo.jpg', { reachable: false, cachedAt: '2025-01-01' }),
  );
  const merged = federation.mergeByHash([cached, reachable]);
  check('a reachable peer wins over a cached one when there is no local copy',
    merged[0].name === 'live-name.jpg', JSON.stringify(merged[0]));
}

{
  const older = tagged({ hash: 'h1', path: '/a', name: 'a', capturedAt: '2020-01-01' }, loc('local', '/a'));
  const newer = tagged({ hash: 'h2', path: '/b', name: 'b', capturedAt: '2026-01-01' }, loc('local', '/b'));
  const merged = federation.mergeByHash([older, newer]);
  check('without a GPS search, results sort newest first', merged[0].path === '/b' && merged[1].path === '/a');
}

{
  const far = tagged({ hash: 'h1', path: '/far', name: 'far', capturedAt: '2026-01-01', distanceKm: 50 }, loc('local', '/far'));
  const near = tagged({ hash: 'h2', path: '/near', name: 'near', capturedAt: '2020-01-01', distanceKm: 1 }, loc('local', '/near'));
  const merged = federation.mergeByHash([far, near], { near: { lat: 0, lon: 0 } });
  check('a GPS search sorts nearest first, overriding capture date', merged[0].path === '/near' && merged[1].path === '/far');
}

// ---------------------------------------------------------------------------
// federatedSearch — connections.connect() mocked, real cache files on disk
// ---------------------------------------------------------------------------

function scratchLibrary() {
  return mkdtempSync(path.join(tmpdir(), 'lanshare-federation-'));
}

const realConnect = connectionsLib.connect;
function mockConnect(fn) { connectionsLib.connect = fn; }
function restoreConnect() { connectionsLib.connect = realConnect; }

const availableSecrets = { available: true, decrypt: () => 'unused', encrypt: (s) => s };
const unavailableSecrets = { available: false, decrypt: () => null };

async function run() {
  {
    const library = scratchLibrary();
    let called = false;
    mockConnect(async () => { called = true; return { json: async () => ({ results: [] }) }; });
    const { results, peers } = await federation.federatedSearch({
      library, config: { connections: [] }, secrets: availableSecrets,
      localResults: [{ path: '/x.jpg', name: 'x.jpg', hash: 'h', capturedAt: null }],
      params: {},
    });
    check('zero configured connections: local results pass through untouched',
      results.length === 1 && results[0].locations[0].source === 'local');
    check('zero configured connections: no peer report, no connection attempted',
      peers.length === 0 && !called);
    restoreConnect();
    rmSync(library, { recursive: true, force: true });
  }

  {
    const library = scratchLibrary();
    let called = false;
    mockConnect(async () => { called = true; return { json: async () => ({ results: [] }) }; });
    const { results, peers } = await federation.federatedSearch({
      library, config: { connections: [{ id: 'p1', label: 'Peer One' }] }, secrets: unavailableSecrets,
      localResults: [], params: {},
    });
    check('no usable secrets store: never attempts a live connection', !called);
    check('no usable secrets store: peer reported unreachable, with an empty (never-seen) cache',
      peers.length === 1 && peers[0].reachable === false && results.length === 0, JSON.stringify(peers));
    restoreConnect();
    rmSync(library, { recursive: true, force: true });
  }

  {
    const library = scratchLibrary();
    const conn = { id: 'p2', label: 'Peer Two', lastConnected: '2026-01-01T00:00:00.000Z' };
    let liveCalls = 0;
    mockConnect(async () => {
      liveCalls++;
      return {
        json: async () => ({
          results: [{ path: '/Remote/photo.jpg', name: 'photo.jpg', kind: 'image', size: 10, mtime: 1, hash: 'abc', encrypted: false }],
        }),
        signOut() {}, close() {},
      };
    });

    const live = await federation.federatedSearch({
      library, config: { connections: [conn] }, secrets: availableSecrets, localResults: [], params: {},
    });
    check('a reachable peer contributes its result, tagged reachable',
      live.results.length === 1 && live.results[0].locations[0].reachable === true, JSON.stringify(live.results));
    check('the peer report says reachable', live.peers[0].reachable === true);

    // Now the same peer is unreachable. The row seen a moment ago during the
    // live call above must still be findable, from the cache it was written
    // into as a side effect of that call — not from a second live attempt.
    mockConnect(async () => { throw new Error('offline'); });
    const offline = await federation.federatedSearch({
      library, config: { connections: [conn] }, secrets: availableSecrets, localResults: [], params: {},
    });
    check('once unreachable, the same file is still found — from cache',
      offline.results.length === 1 && offline.results[0].path === '/Remote/photo.jpg', JSON.stringify(offline.results));
    check('the cached result is honestly marked unreachable, with when it was last seen',
      offline.results[0].locations[0].reachable === false
      && offline.results[0].locations[0].cachedAt === conn.lastConnected, JSON.stringify(offline.results[0].locations[0]));
    check('the peer report also says unreachable this time, with a reason', offline.peers[0].reachable === false && Boolean(offline.peers[0].error));
    check('exactly one live call happened across both searches (the second used cache, not a retry)', liveCalls === 1);

    restoreConnect();
    rmSync(library, { recursive: true, force: true });
  }

  {
    // A peer whose connect() takes far longer than the caller is willing to
    // wait must not make the whole search wait for it — and must not leave
    // an unhandled rejection behind when it eventually does settle.
    const library = scratchLibrary();
    const conn = { id: 'p3', label: 'Slow Peer' };
    let slowSettled = false;
    mockConnect(() => new Promise((resolve) => {
      setTimeout(() => {
        slowSettled = true;
        resolve({ json: async () => ({ results: [] }) });
      }, 400);
    }));

    const started = Date.now();
    const { peers } = await federation.federatedSearch({
      library, config: { connections: [conn] }, secrets: availableSecrets, localResults: [],
      params: {}, timeoutMs: 60,
    });
    const elapsed = Date.now() - started;
    check('a slow peer times out quickly rather than being waited out', elapsed < 300, `${elapsed}ms`);
    check('the timed-out peer is reported unreachable', peers[0].reachable === false);

    await new Promise((r) => setTimeout(r, 500));
    check('the slow connection did eventually settle in the background', slowSettled);
    check('and settling late produced no unhandled rejection', unhandled === null, String(unhandled));

    restoreConnect();
    rmSync(library, { recursive: true, force: true });
  }
}

try {
  await run();
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error during the test run -> ${err.stack || err.message}`);
} finally {
  restoreConnect();
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
