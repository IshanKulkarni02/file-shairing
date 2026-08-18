/**
 * lib/nl-rules.js against a fake local model — no real Ollama call ever
 * leaves this test. What is proven here is the plumbing and, above all,
 * the safety property: every draft, however the fake model phrases it,
 * only ever reaches the caller after going through the exact same
 * sortRules.parse() a hand-typed rule would.
 *
 *   node test/nl-rules.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const nlRules = require(path.join(here, '..', 'lib', 'nl-rules.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

/** A fake Ollama /api/generate — returns whatever text is given, and records every call. */
function fakeModel(responseText, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok, status, json: async () => ({ response: responseText }) };
  };
  fn.calls = calls;
  return fn;
}

const TODAY = new Date('2026-08-11T15:00:00Z');

// --- a clean, well-formed draft ------------------------------------------------

{
  const fetchImpl = fakeModel('when camera.make = "DJI" -> /Drone/{year}/{month}');
  const draft = await nlRules.draftRule({ instruction: 'keep drone shots in /Drone', fetchImpl, now: TODAY });

  check('a well-formed draft parses successfully', draft.parsed !== null && draft.error === null, JSON.stringify(draft));
  check('the parsed rule\'s destination matches what the model wrote', draft.parsed.destination === '/Drone/{year}/{month}');
  check('the request went to the default local host', fetchImpl.calls[0].url === `${nlRules.DEFAULT_HOST}/api/generate`);
  check('the request asked for a non-streaming response', fetchImpl.calls[0].body.stream === false);
  check('the request carries the instruction inside its prompt',
    fetchImpl.calls[0].body.prompt.includes('keep drone shots in /Drone'));
  check('the prompt substitutes the injected "today" wherever the model needs it',
    fetchImpl.calls[0].body.prompt.includes('2026-08-11'));
}

// --- markdown fences and stray prose around the actual rule --------------------

{
  const fetchImpl = fakeModel('Sure! Here is the rule:\n```\nwhen kind = video -> /Videos\n```\nHope that helps.');
  const draft = await nlRules.draftRule({ instruction: 'sort my videos', fetchImpl, now: TODAY });
  check('the rule line is correctly extracted from a fenced, chatty response',
    draft.text === 'when kind = video -> /Videos' && draft.parsed !== null, JSON.stringify(draft));
}

{
  const fetchImpl = fakeModel('  when kind = image -> /Photos  \n\n');
  const draft = await nlRules.draftRule({ instruction: 'sort my photos', fetchImpl, now: TODAY });
  check('surrounding whitespace and blank lines do not break extraction', draft.parsed !== null, JSON.stringify(draft));
}

// --- a draft that fails to parse is reported, not thrown -----------------------

{
  const fetchImpl = fakeModel('I am not sure what you mean by that.');
  const draft = await nlRules.draftRule({ instruction: 'do something vague', fetchImpl, now: TODAY });
  check('an unparseable draft does not throw', draft !== undefined);
  check('it is reported as a normal, named error instead', draft.parsed === null && typeof draft.error === 'string' && draft.error.length > 0,
    JSON.stringify(draft));
  check('the raw text is still returned, so it can be shown and hand-edited', draft.text.length > 0);
}

{
  const fetchImpl = fakeModel('when camera.brand = "DJI" -> /Drone'); // "brand" is not a real field
  const draft = await nlRules.draftRule({ instruction: 'drone shots', fetchImpl, now: TODAY });
  check('a draft using an invalid field is caught by the same validator a hand-typed rule would hit',
    draft.parsed === null && draft.error.includes('unknown field'), JSON.stringify(draft));
}

{
  const fetchImpl = fakeModel('when camera.make = "DJI" -> /Drone\nwhen kind = video -> /Videos');
  const draft = await nlRules.draftRule({ instruction: 'two things at once', fetchImpl, now: TODAY });
  check('a draft is only ever accepted as exactly one rule — extra lines are ignored, not silently combined',
    draft.text === 'when camera.make = "DJI" -> /Drone' && draft.parsed !== null, JSON.stringify(draft));
}

// --- failures asking the model at all — these DO throw --------------------------

{
  let rejected = null;
  try {
    await nlRules.draftRule({ instruction: '   ', fetchImpl: fakeModel('irrelevant'), now: TODAY });
  } catch (err) {
    rejected = err;
  }
  check('an empty instruction is refused before any request is even attempted',
    rejected instanceof nlRules.NlRulesError, String(rejected));
}

{
  const throwingFetch = async () => { throw new Error('ECONNREFUSED'); };
  let rejected = null;
  try {
    await nlRules.draftRule({ instruction: 'sort my photos', fetchImpl: throwingFetch, now: TODAY });
  } catch (err) {
    rejected = err;
  }
  check('a local model that cannot be reached at all throws a clear, specific error',
    rejected instanceof nlRules.NlRulesError && rejected.message.includes('is it running'), String(rejected));
}

{
  const badStatusFetch = fakeModel('irrelevant', { ok: false, status: 500 });
  let rejected = null;
  try {
    await nlRules.draftRule({ instruction: 'sort my photos', fetchImpl: badStatusFetch, now: TODAY });
  } catch (err) {
    rejected = err;
  }
  check('a non-OK HTTP response from the model server throws rather than being treated as a draft',
    rejected instanceof nlRules.NlRulesError, String(rejected));
}

{
  const malformedFetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } });
  let rejected = null;
  try {
    await nlRules.draftRule({ instruction: 'sort my photos', fetchImpl: malformedFetch, now: TODAY });
  } catch (err) {
    rejected = err;
  }
  check('a response body that is not valid JSON throws rather than crashing', rejected instanceof nlRules.NlRulesError);
}

{
  const emptyFetch = async () => ({ ok: true, status: 200, json: async () => ({ response: '   ' }) });
  let rejected = null;
  try {
    await nlRules.draftRule({ instruction: 'sort my photos', fetchImpl: emptyFetch, now: TODAY });
  } catch (err) {
    rejected = err;
  }
  check('an empty response from the model throws rather than silently drafting nothing',
    rejected instanceof nlRules.NlRulesError);
}

// --- a model that is not installed: the confusing one --------------------------
// Ollama answers a request for a model it does not have with 404, which reads
// exactly like "the server is not running" but happens only when it IS
// running. Reported from real use: the error said "refused that request (404)"
// and sent someone off restarting a server that was working perfectly.

{
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/api/tags')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: 'llama2:latest' }, { name: 'qwen3:latest' }] }),
      };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'model not found' }) };
  };

  let rejected = null;
  try {
    await nlRules.draftRule({ instruction: 'sort my photos', model: 'not-installed:8b', fetchImpl, now: TODAY });
  } catch (err) {
    rejected = err;
  }
  check('a missing model throws NlRulesError, not a bare status code',
    rejected instanceof nlRules.NlRulesError, String(rejected));
  check('the message names the model that is missing',
    rejected.message.includes('not-installed:8b'), rejected.message);
  check('and gives the exact command that fixes it',
    rejected.message.includes('ollama pull not-installed:8b'), rejected.message);
  check('and lists the models actually installed, so there is a choice to make',
    rejected.message.includes('llama2:latest') && rejected.message.includes('qwen3:latest'), rejected.message);
  check('it does not blame the server being down, which would be wrong here',
    !/is it running/.test(rejected.message), rejected.message);
  check('the installed list is fetched only after a 404, not on every draft',
    calls.filter((u) => u.endsWith('/api/tags')).length === 1, JSON.stringify(calls));
}

{
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/tags')) return { ok: true, status: 200, json: async () => ({ models: [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  let rejected = null;
  try {
    await nlRules.draftRule({ instruction: 'sort my photos', model: 'x:1b', fetchImpl, now: TODAY });
  } catch (err) { rejected = err; }
  check('with no models installed at all, it says so rather than listing nothing',
    rejected.message.includes('no models at all'), rejected.message);
}

// --- a model that cannot load: Ollama knows why, so say what it said ----------
// Real case: llama3.2-vision on an Ollama too old for its architecture answers
// 500 with "unknown model architecture: 'mllama'". Reporting only the status
// code sent someone looking for a problem in their prompt, when the model had
// never loaded and the prompt was never seen.

{
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    json: async () => ({
      error: "llama-server process has terminated: exit status 1: error loading model: unknown model architecture: 'mllama'"
        + "\nerror loading model: unknown model architecture: 'mllama'",
    }),
  });
  let rejected = null;
  try {
    await nlRules.draftRule({ instruction: 'sort my photos', model: 'llama3.2-vision:11b', fetchImpl, now: TODAY });
  } catch (err) { rejected = err; }

  check('a model that fails to load reports what Ollama actually said',
    rejected.message.includes('unknown model architecture'), rejected.message);
  check('and names the model that could not run',
    rejected.message.includes('llama3.2-vision:11b'), rejected.message);
  check('and does not reduce it to a bare status code',
    !/refused that request/.test(rejected.message), rejected.message);
  check('the repeated second line is trimmed off',
    (rejected.message.match(/unknown model architecture/g) || []).length === 1, rejected.message);
}

{
  // A non-OK response with no readable body still has to say something.
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => { throw new SyntaxError('no body'); } });
  let rejected = null;
  try {
    await nlRules.draftRule({ instruction: 'sort my photos', model: 'x:1', fetchImpl, now: TODAY });
  } catch (err) { rejected = err; }
  check('an unreadable error body falls back to the status code rather than throwing',
    rejected instanceof nlRules.NlRulesError && rejected.message.includes('503'), rejected.message);
}

{
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ models: [{ name: 'a:1' }, { name: 'b:2' }] }) });
  const names = await nlRules.listModels({ fetchImpl });
  check('listModels returns the installed names', JSON.stringify(names) === '["a:1","b:2"]', JSON.stringify(names));
  const unreachable = await nlRules.listModels({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  check('listModels returns [] rather than throwing when nothing answers',
    Array.isArray(unreachable) && unreachable.length === 0);
}

// --- the cloud-storage hint: a plain local check, not a model call -------------

check('an instruction mentioning Google Drive gets an informational note',
  typeof nlRules.cloudHint('move these to /Rides/Manali and store it in Google Drive') === 'string');
check('an instruction mentioning a backup gets a note too',
  typeof nlRules.cloudHint('please back up these files somewhere safe') === 'string');
check('an ordinary instruction with no cloud mention gets no note',
  nlRules.cloudHint('keep drone shots in /Drone') === null);

{
  const fetchImpl = fakeModel('when gps near "Manali" -> /Rides/Manali');
  const draft = await nlRules.draftRule({
    instruction: 'move my Manali trip to /Rides/Manali and back it up to Google Drive',
    fetchImpl,
    now: TODAY,
  });
  check('the cloud hint travels alongside a real draft, not instead of one',
    draft.parsed !== null && typeof draft.note === 'string', JSON.stringify(draft));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
