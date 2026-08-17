'use strict';

/**
 * Turning a typed sentence into a lib/sort-rules.js rule — drafted by a
 * local model, never trusted directly.
 *
 * "AI drafts, human approves, deterministic code executes" is the whole
 * design, decided earlier in this project when the question was whether an
 * agent with file access was worth building at all. This module's only
 * output is one line of text in exactly lib/sort-rules.js's own grammar,
 * and that text is always run through sortRules.parse() — the identical
 * validator a hand-written rule goes through — before it is ever shown,
 * previewed, or actioned. A malformed or hallucinated draft fails the same
 * way a person's own typo would: visibly, before anything happens, never
 * silently, and never with direct access to a file operation.
 *
 * Talks to a local Ollama-compatible HTTP API (127.0.0.1:11434 by default)
 * rather than a cloud model with an account and a bill attached — the same
 * "no new external credential" reasoning Phase J chose the relay for and
 * Phase L chose Nominatim for. Unlike those two, this one cannot be proven
 * to work *well* from here: an injected fake response can prove the
 * plumbing and the validation are correct, but nothing in this environment
 * can judge whether a real local model's translations are actually good.
 * That is stated plainly in plan.md rather than implied by green tests.
 */

const sortRules = require('./sort-rules');

const DEFAULT_HOST = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'llama3.1:8b';

class NlRulesError extends Error {}

const GRAMMAR_PROMPT = `You translate one plain-English instruction about sorting photos and \
videos into exactly one line of a small rule language, and output NOTHING else: no \
explanation, no markdown fences, just that one line.

Grammar:
  when <condition> -> <destination>

<condition> is one or more clauses joined by "and". Several such groups may be joined by \
"or" — there are no parentheses in this language, so "A and (B or C)" must be written as \
two full groups: "A and B or A and C".

A clause is exactly one of:
  camera.make = "<text>"
  camera.model = "<text>"
  kind = image
  kind = video
  kind = audio
  kind = file
  date = "<YYYY-MM-DD>"
  gps near "<place name>"
  gps near "<place name>" within <number>km

<destination> is an absolute path starting with "/", optionally containing {year}, {month}, \
{day} — substituted later from the file's own capture date. Never invent a place's \
coordinates; write the place name in quotes and let "gps near" resolve it.

Examples:

Instruction: keep all drone shots in the drone folder, organised by year and month
when camera.make = "DJI" -> /Drone/{year}/{month}

Instruction: put my iphone videos from today in /Today
when camera.make = "Apple" and kind = video and date = "{TODAY}" -> /Today

Instruction: I was on a motorcycle ride today at Manali, move all pics and videos to /Rides/Manali
when date = "{TODAY}" and gps near "Manali" and kind = image or date = "{TODAY}" and gps near "Manali" and kind = video -> /Rides/Manali

Now translate this instruction the same way, using today's date {TODAY} wherever "today" is meant:
Instruction: {INSTRUCTION}
`;

function buildPrompt(instruction, today) {
  return GRAMMAR_PROMPT.replace(/\{TODAY\}/g, today).replace('{INSTRUCTION}', instruction.trim());
}

/**
 * A cheap, local, non-model check — never trusted with anything more than
 * an informational note. Sorting rules only ever move files inside the
 * library; "then push to Google Drive" is a different, already-existing
 * feature (Phase D's sync targets), and this is deliberately not the place
 * that reaches into that subsystem's config on the strength of one
 * one-shot sentence.
 */
function cloudHint(instruction) {
  if (/\b(google drive|onedrive|dropbox|icloud|cloud|backup|back up)\b/i.test(instruction)) {
    return 'This also mentions cloud storage — a sorting rule only moves files inside your '
      + 'library. Set up a sync target for the destination album on the Sync screen to also '
      + 'keep it backed up there.';
  }
  return null;
}

/** Strips a ```...``` fence and any stray prose the model added despite being told not to. */
function extractRuleLine(rawResponse) {
  const withoutFences = String(rawResponse || '').replace(/```[a-z]*\n?/gi, '').trim();
  const lines = withoutFences.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^when\s+/i.test(l)) || lines[0] || '';
}

async function callModel({
  instruction, host, model, fetchImpl, today,
}) {
  const prompt = buildPrompt(instruction, today);
  let res;
  try {
    res = await fetchImpl(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
    });
  } catch (err) {
    throw new NlRulesError(`Could not reach the local model at ${host} — is it running? (${err.message})`);
  }
  if (!res.ok) {
    throw new NlRulesError(`The local model refused that request (${res.status})`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new NlRulesError('The local model returned something that was not valid JSON');
  }
  if (typeof body?.response !== 'string' || !body.response.trim()) {
    throw new NlRulesError('The local model returned an empty response');
  }
  return body.response;
}

/**
 * Draft a rule from a sentence.
 *
 * Only a genuine failure to *ask* (no model reachable, a bad HTTP response)
 * throws — that is this function refusing to run at all. A draft the model
 * produced but that does not parse is a completely ordinary outcome, not a
 * bug, and is returned as `{ text, parsed: null, error }` for the caller to
 * show back to the person exactly like a hand-typed rule's own parse error
 * would be shown.
 */
async function draftRule({
  instruction, host = DEFAULT_HOST, model = DEFAULT_MODEL, fetchImpl = (...args) => fetch(...args), now = new Date(),
}) {
  if (!instruction || !instruction.trim()) {
    throw new NlRulesError('Type an instruction first');
  }
  const today = now.toISOString().slice(0, 10);
  const raw = await callModel({
    instruction, host, model, fetchImpl, today,
  });
  const text = extractRuleLine(raw);

  let parsed = null;
  let error = null;
  try {
    const rules = sortRules.parse(text);
    if (rules.length !== 1) throw new sortRules.SortRulesError('That did not produce exactly one usable rule');
    [parsed] = rules;
  } catch (err) {
    error = err.message;
  }

  return {
    text, parsed, error, note: cloudHint(instruction),
  };
}

module.exports = {
  NlRulesError, DEFAULT_HOST, DEFAULT_MODEL, draftRule, extractRuleLine, cloudHint, buildPrompt,
};
