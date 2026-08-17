/**
 * lib/sort-rules.js: parsing the rule text format, evaluating it against a
 * file's metadata, and saving it with real git history.
 *
 *   node test/sort-rules.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const rules = require(path.join(here, '..', 'lib', 'sort-rules.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

// --- parsing: the plan's own two examples, verbatim -----------------------

{
  const text = [
    'when camera.make = "DJI"                 -> /Drone/{year}/{month}',
    'when kind = video and gps near "Manali"  -> /Rides/Manali',
  ].join('\n');
  const parsed = rules.parse(text);
  check('both example rules parse without error', parsed.length === 2, JSON.stringify(parsed));
  check('the first rule\'s condition is a single equality clause',
    parsed[0].conditionGroups.length === 1 && parsed[0].conditionGroups[0].length === 1
    && parsed[0].conditionGroups[0][0].field === 'camera.make' && parsed[0].conditionGroups[0][0].value === 'DJI');
  check('the first rule\'s destination keeps its placeholders', parsed[0].destination === '/Drone/{year}/{month}');
  check('the second rule\'s condition ANDs two clauses',
    parsed[1].conditionGroups.length === 1 && parsed[1].conditionGroups[0].length === 2);
  check('the second rule\'s near clause defaults to a 20km radius',
    parsed[1].conditionGroups[0][1].radiusKm === rules.DEFAULT_NEAR_RADIUS_KM);
}

// --- comments and blank lines ------------------------------------------------

{
  const text = [
    '# This is a comment',
    '',
    '   ',
    'when kind = image -> /Photos',
    '# another comment',
  ].join('\n');
  const parsed = rules.parse(text);
  check('comments and blank lines are ignored, leaving exactly one rule', parsed.length === 1, JSON.stringify(parsed));
  check('the real rule still records its actual line number (4), not a renumbered one', parsed[0].line === 4);
}

// --- OR and AND together ----------------------------------------------------

{
  const parsed = rules.parse('when kind = image or kind = video -> /Media');
  check('an OR condition parses as two AND-groups of one clause each',
    parsed[0].conditionGroups.length === 2
    && parsed[0].conditionGroups.every((g) => g.length === 1));
}

// --- case-insensitivity of keywords ------------------------------------------

{
  const parsed = rules.parse('WHEN Camera.Make = "DJI" AND Kind = image -> /X');
  check('keywords and field names are case-insensitive',
    parsed.length === 1 && parsed[0].conditionGroups[0][0].field === 'camera.make');
}

// --- parse errors, each naming the actual problem ----------------------------

function expectParseError(text, mustContain) {
  try {
    rules.parse(text);
    check(`"${text}" is rejected`, false, 'no error was thrown');
  } catch (err) {
    check(`"${text}" is rejected`, err instanceof rules.SortRulesError && err.message.includes(mustContain),
      err.message);
  }
}

expectParseError('camera.make = "DJI" -> /Drone', 'expected a rule starting with "when"');
expectParseError('when camera.make = "DJI"', '"-> /destination"');
expectParseError('when camera.brand = "DJI" -> /Drone', 'unknown field');
expectParseError('when camera.make = "DJI" -> Drone', 'absolute library path');
expectParseError('when camera.make = "DJI" -> /Drone/{week}', 'unknown placeholder');
expectParseError('when -> /Drone', 'needs a condition');
expectParseError('when gps near "" -> /Drone', 'needs a place name');
expectParseError('when date = "11-08-2026" -> /Rides', 'plain YYYY-MM-DD');
expectParseError('when date = "2026/08/11" -> /Rides', 'plain YYYY-MM-DD');
expectParseError('when date = "today" -> /Rides', 'plain YYYY-MM-DD');

{
  const parsed = rules.parse('when date = "2026-08-11" -> /Rides/Today');
  check('a well-formed date clause parses', parsed[0].conditionGroups[0][0].field === 'date'
    && parsed[0].conditionGroups[0][0].value === '2026-08-11');
}

// --- evaluation: a date clause matches the whole calendar day, not the instant --

{
  const rideRule = rules.parse('when date = "2026-08-11" -> /Rides/Today');
  check('a file captured that same day, any time of day, matches',
    rules.destinationFor(rideRule, { capturedAt: '2026-08-11T23:59:59' }) === '/Rides/Today');
  check('the very start of that day matches too',
    rules.destinationFor(rideRule, { capturedAt: '2026-08-11T00:00:00' }) === '/Rides/Today');
  check('the day before does not match', rules.destinationFor(rideRule, { capturedAt: '2026-08-10T23:59:59' }) === null);
  check('the day after does not match', rules.destinationFor(rideRule, { capturedAt: '2026-08-12T00:00:00' }) === null);
  check('a file with no capture date at all never matches a date clause',
    rules.destinationFor(rideRule, {}) === null);

  const combined = rules.parse('when date = "2026-08-11" and kind = image -> /Rides/Today/Photos');
  check('a date clause combines with other clauses via AND like any other field',
    rules.destinationFor(combined, { capturedAt: '2026-08-11T12:00:00', kind: 'image' }) === '/Rides/Today/Photos');
  check('AND still requires both — the date matching alone is not enough',
    rules.destinationFor(combined, { capturedAt: '2026-08-11T12:00:00', kind: 'video' }) === null);
}

// --- evaluation: equality, case-insensitive value matching -------------------

const djiRule = rules.parse('when camera.make = "DJI" -> /Drone/{year}/{month}');
check('a matching file gets the rule\'s destination',
  rules.destinationFor(djiRule, { cameraMake: 'DJI', capturedAt: '2026-03-15T10:00:00' }) === '/Drone/2026/03');
check('matching is case-insensitive on the value',
  rules.destinationFor(djiRule, { cameraMake: 'dji', capturedAt: '2026-01-01T00:00:00' }) !== null);
check('a non-matching file gets no destination', rules.destinationFor(djiRule, { cameraMake: 'Canon' }) === null);
check('a file with no camera metadata at all gets no destination', rules.destinationFor(djiRule, {}) === null);

// --- first match wins -------------------------------------------------------

{
  const ordered = rules.parse([
    'when camera.make = "DJI" -> /First',
    'when kind = image -> /Second',
  ].join('\n'));
  const bothMatch = { cameraMake: 'DJI', kind: 'image' };
  check('when two rules both match, the earlier one in the file wins',
    rules.destinationFor(ordered, bothMatch) === '/First');
}

// --- AND requires all clauses, OR requires just one --------------------------

{
  const andRule = rules.parse('when kind = video and camera.make = "DJI" -> /DroneVideos');
  check('AND: both true matches', rules.destinationFor(andRule, { kind: 'video', cameraMake: 'DJI' }) === '/DroneVideos');
  check('AND: only one true does not match', rules.destinationFor(andRule, { kind: 'video', cameraMake: 'Canon' }) === null);

  const orRule = rules.parse('when kind = image or kind = video -> /Media');
  check('OR: either alone matches', rules.destinationFor(orRule, { kind: 'image' }) === '/Media'
    && rules.destinationFor(orRule, { kind: 'video' }) === '/Media');
  check('OR: neither does not match', rules.destinationFor(orRule, { kind: 'audio' }) === null);
}

// --- gps near, with an injected synchronous geocoder --------------------------

{
  const nearRule = rules.parse('when gps near "Manali" -> /Rides/Manali');
  const MANALI = { lat: 32.2432, lon: 77.1892 };
  const geocode = (place) => (place === 'Manali' ? MANALI : null);

  check('a file within the default radius of the resolved place matches',
    rules.destinationFor(nearRule, { gpsLat: 32.25, gpsLon: 77.20 }, geocode) === '/Rides/Manali');
  check('a file far from the resolved place does not match',
    rules.destinationFor(nearRule, { gpsLat: 28.6139, gpsLon: 77.2090 }, geocode) === null); // Delhi, ~500km away
  check('a file with no GPS at all never matches a "near" clause',
    rules.destinationFor(nearRule, {}, geocode) === null);
  check('a place the geocoder could not resolve makes the clause simply not match, not throw',
    rules.destinationFor(nearRule, { gpsLat: 32.25, gpsLon: 77.20 }, () => null) === null);
  check('a rule referencing a place is fine to evaluate with no geocoder function at all',
    rules.destinationFor(nearRule, { gpsLat: 32.25, gpsLon: 77.20 }) === null);
}

{
  const customRadius = rules.parse('when gps near "Home" within 2km -> /Local');
  check('a custom radius is parsed and honoured',
    customRadius[0].conditionGroups[0][0].radiusKm === 2);
  const geocode = () => ({ lat: 0, lon: 0 });
  check('just inside a tight custom radius matches',
    rules.destinationFor(customRadius, { gpsLat: 0.01, gpsLon: 0 }, geocode) === '/Local');
  check('just outside a tight custom radius does not',
    rules.destinationFor(customRadius, { gpsLat: 1, gpsLon: 0 }, geocode) === null);
}

// --- placeholder substitution ------------------------------------------------

{
  const rule = rules.parse('when kind = image -> /Photos/{year}/{month}/{day}');
  check('year/month/day are all substituted and zero-padded',
    rules.destinationFor(rule, { kind: 'image', capturedAt: '2026-01-05T00:00:00' }) === '/Photos/2026/01/05');
  check('a file with no capture date substitutes "Unknown" rather than leaving the placeholder or crashing',
    rules.destinationFor(rule, { kind: 'image' }) === '/Photos/Unknown/Unknown/Unknown');
}

// --- placesReferencedBy -------------------------------------------------------

{
  const multi = rules.parse([
    'when gps near "Manali" -> /A',
    'when gps near "Leh" -> /B',
    'when gps near "Manali" within 5km -> /C',
    'when kind = image -> /D',
  ].join('\n'));
  const places = rules.placesReferencedBy(multi);
  check('every distinct place is found exactly once, duplicates collapsed',
    places.length === 2 && places.includes('Manali') && places.includes('Leh'), JSON.stringify(places));
}

// --- storage: save, read back, and real git history --------------------------

{
  const library = mkdtempSync(path.join(tmpdir(), 'lanshare-sort-rules-'));
  try {
    check('a library with no rules file yet reads back as empty text', rules.readRulesText(library) === '');
    check('git is available in this test environment', rules.isGitAvailable());

    const textV1 = 'when kind = image -> /Photos';
    rules.saveRulesText(library, textV1, { message: 'first rules' });
    check('the saved text reads back exactly', rules.readRulesText(library) === textV1);

    let history = rules.ruleHistory(library);
    check('one commit exists after the first save', history.length === 1, JSON.stringify(history));
    check('the commit message is the one that was given', history[0].subject === 'first rules');

    const textV2 = 'when kind = video -> /Videos';
    rules.saveRulesText(library, textV2, { message: 'second rules' });
    check('the second save overwrites the file on disk', rules.readRulesText(library) === textV2);

    history = rules.ruleHistory(library);
    check('a second, real commit was made', history.length === 2, JSON.stringify(history));
    check('history is newest first', history[0].subject === 'second rules' && history[1].subject === 'first rules');
    check('the two commits have different hashes', history[0].hash !== history[1].hash);

    // Saving the exact same text again — a no-op commit — must not crash.
    rules.saveRulesText(library, textV2, { message: 'no-op save' });
    check('saving unchanged text again does not throw, and does not add a spurious commit',
      rules.ruleHistory(library).length === 2);

    let rejected = null;
    try {
      rules.saveRulesText(library, 'when nonsense broken rule', { message: 'should not land' });
    } catch (err) {
      rejected = err;
    }
    check('an invalid rules file is refused before it overwrites the good one on disk',
      rejected instanceof rules.SortRulesError, String(rejected));
    check('the file on disk still holds the last valid save, untouched', rules.readRulesText(library) === textV2);
    check('no commit was made for the rejected save either', rules.ruleHistory(library).length === 2);
  } finally {
    rmSync(library, { recursive: true, force: true });
  }
}

{
  const emptyLibrary = mkdtempSync(path.join(tmpdir(), 'lanshare-sort-rules-empty-'));
  try {
    check('a library that has never had rules saved has no history, not an error',
      rules.ruleHistory(emptyLibrary).length === 0);
  } finally {
    rmSync(emptyLibrary, { recursive: true, force: true });
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
