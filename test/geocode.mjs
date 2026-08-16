/**
 * lib/geocode.js against a fake fetch — no real network call ever leaves
 * this test, but the real caching, throttling and disk-persistence logic
 * around that call is fully exercised.
 *
 *   node test/geocode.mjs
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const geocode = require(path.join(here, '..', 'lib', 'geocode.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

function scratchLibrary() {
  return mkdtempSync(path.join(tmpdir(), 'lanshare-geocode-'));
}

/** A fake Nominatim: canned responses by place name, and a call log for assertions. */
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, headers: options?.headers });
    const q = decodeURIComponent(new URL(url).searchParams.get('q'));
    const body = responses[q] ?? [];
    return { ok: true, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

// --- a successful resolution --------------------------------------------------

{
  const library = scratchLibrary();
  const fetchImpl = fakeFetch({ Manali: [{ lat: '32.2432', lon: '77.1892' }] });
  try {
    const point = await geocode.resolvePlace('Manali', { library, fetchImpl, minIntervalMs: 0 });
    check('a place the fake service knows resolves to real numbers',
      point?.lat === 32.2432 && point?.lon === 77.1892, JSON.stringify(point));
    check('exactly one network call was made', fetchImpl.calls.length === 1);
    check('the request carries a real, identifying User-Agent, per Nominatim\'s usage policy',
      typeof fetchImpl.calls[0].headers?.['User-Agent'] === 'string' && fetchImpl.calls[0].headers['User-Agent'].includes('LANShare'));
  } finally {
    rmSync(library, { recursive: true, force: true });
  }
}

// --- caching: the same place is never looked up twice -------------------------

{
  const library = scratchLibrary();
  const fetchImpl = fakeFetch({ Manali: [{ lat: '32.2432', lon: '77.1892' }] });
  try {
    await geocode.resolvePlace('Manali', { library, fetchImpl, minIntervalMs: 0 });
    const second = await geocode.resolvePlace('Manali', { library, fetchImpl, minIntervalMs: 0 });
    check('a second resolution of the same place returns the cached value', second?.lat === 32.2432);
    check('and makes no second network call', fetchImpl.calls.length === 1);

    check('the cache was actually persisted to a real file on disk',
      JSON.parse(readFileSync(geocode.cachePath(library), 'utf8'))?.manali?.lat === 32.2432);

    // A fresh call into the same library, with a fetch that would fail if
    // it were ever actually invoked, proves the cache — not luck — is what
    // answered the second lookup above.
    const brokenFetch = async () => { throw new Error('should never be called — this place is already cached'); };
    const third = await geocode.resolvePlace('Manali', { library, fetchImpl: brokenFetch, minIntervalMs: 0 });
    check('a completely fresh call still reads the persisted cache correctly', third?.lat === 32.2432);
  } finally {
    rmSync(library, { recursive: true, force: true });
  }
}

// --- case/whitespace-insensitive cache key -------------------------------------

{
  const library = scratchLibrary();
  const fetchImpl = fakeFetch({ Manali: [{ lat: '32.2432', lon: '77.1892' }] });
  try {
    await geocode.resolvePlace('Manali', { library, fetchImpl, minIntervalMs: 0 });
    const differentCase = await geocode.resolvePlace('  MANALI  ', { library, fetchImpl, minIntervalMs: 0 });
    check('a differently-cased, differently-spaced request for the same place hits the cache too',
      differentCase?.lat === 32.2432 && fetchImpl.calls.length === 1);
  } finally {
    rmSync(library, { recursive: true, force: true });
  }
}

// --- an unresolvable place --------------------------------------------------

{
  const library = scratchLibrary();
  const fetchImpl = fakeFetch({}); // every query returns an empty result set
  try {
    const point = await geocode.resolvePlace('Nowhereville', { library, fetchImpl, minIntervalMs: 0 });
    check('a place with no results resolves to null, not an error', point === null);

    const secondFetch = fakeFetch({});
    await geocode.resolvePlace('Nowhereville', { library, fetchImpl: secondFetch, minIntervalMs: 0 });
    check('an unresolved place is not cached — it gets a real retry next time, in case the failure was transient',
      secondFetch.calls.length === 1);
  } finally {
    rmSync(library, { recursive: true, force: true });
  }
}

// --- network/service failures never throw --------------------------------------

{
  const library = scratchLibrary();
  const throwingFetch = async () => { throw new Error('ECONNREFUSED'); };
  const point = await geocode.resolvePlace('AnyPlace', { library, fetchImpl: throwingFetch, minIntervalMs: 0 });
  check('a network failure resolves to null rather than throwing', point === null);
  rmSync(library, { recursive: true, force: true });
}

{
  const library = scratchLibrary();
  const badStatusFetch = async () => ({ ok: false, json: async () => { throw new Error('should not be read'); } });
  const point = await geocode.resolvePlace('AnyPlace', { library, fetchImpl: badStatusFetch, minIntervalMs: 0 });
  check('a non-OK HTTP response resolves to null rather than throwing', point === null);
  rmSync(library, { recursive: true, force: true });
}

{
  const library = scratchLibrary();
  const malformedFetch = async () => ({ ok: true, json: async () => { throw new SyntaxError('not json'); } });
  const point = await geocode.resolvePlace('AnyPlace', { library, fetchImpl: malformedFetch, minIntervalMs: 0 });
  check('a response body that is not valid JSON resolves to null rather than throwing', point === null);
  rmSync(library, { recursive: true, force: true });
}

{
  const library = scratchLibrary();
  const noCoordsFetch = fakeFetch({ Weird: [{ display_name: 'a place with no usable lat/lon at all' }] });
  const point = await geocode.resolvePlace('Weird', { library, fetchImpl: noCoordsFetch, minIntervalMs: 0 });
  check('a result missing usable coordinates resolves to null rather than NaN', point === null);
  rmSync(library, { recursive: true, force: true });
}

// --- resolveMany: several places in one pass, sharing one cache load/save -----

{
  const library = scratchLibrary();
  const fetchImpl = fakeFetch({
    Manali: [{ lat: '32.2432', lon: '77.1892' }],
    Leh: [{ lat: '34.1526', lon: '77.5771' }],
  });
  try {
    const results = await geocode.resolveMany(['Manali', 'Leh', 'Manali'], { library, fetchImpl, minIntervalMs: 0 });
    // A Map naturally collapses the repeated "Manali" key to one entry —
    // exactly what a caller looking places up by name via .get() wants.
    check('resolveMany returns one entry per distinct place asked for',
      results.size === 2 && results.has('Manali') && results.has('Leh'), JSON.stringify([...results.keys()]));
    check('a place repeated in the same batch is resolved once and reused, not fetched twice',
      fetchImpl.calls.length === 2, `${fetchImpl.calls.length} calls`);
    check('both distinct places resolved correctly',
      results.get('Manali')?.lat === 32.2432 && results.get('Leh')?.lat === 34.1526);
  } finally {
    rmSync(library, { recursive: true, force: true });
  }
}

// --- throttling: real spacing between genuinely separate network calls ---------

{
  const library = scratchLibrary();
  const fetchImpl = fakeFetch({
    First: [{ lat: '1', lon: '1' }],
    Second: [{ lat: '2', lon: '2' }],
  });
  try {
    const started = Date.now();
    await geocode.resolveMany(['First', 'Second'], { library, fetchImpl, minIntervalMs: 150 });
    const elapsed = Date.now() - started;
    check('two genuinely new places are spaced at least minIntervalMs apart, not fired back to back',
      elapsed >= 140, `${elapsed}ms`);
  } finally {
    rmSync(library, { recursive: true, force: true });
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
