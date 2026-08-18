'use strict';

/**
 * The assistant loop: a local model chooses tools (lib/assistant-tools.js),
 * this file runs them under whatever trust level each one currently has
 * (lib/trust.js), and feeds the results back until the model either
 * answers in plain text or asks the person a clarifying question.
 *
 * "The model drafts, a person approves, tested code executes" — stated in
 * plan.md for rule-drafting, and unchanged here even though the model now
 * chooses *which* tested code to run rather than just drafting one line of
 * text. Every write tool still only ever does what lib/assistant-tools.js
 * already lets it do, gated by the exact same trust ladder Ghost Mode uses.
 *
 * Talks to a local Ollama-compatible /api/chat endpoint — same reasoning,
 * same default host, as lib/nl-rules.js. Hermes 3 8B is the default model:
 * a Llama-3.1 fine-tune from Nous Research trained specifically for tool
 * use and structured output, not a generic instruct model doing its best.
 */

const nlRules = require('./nl-rules');
const assistantTools = require('./assistant-tools');
const trust = require('./trust');

const DEFAULT_HOST = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'hermes3:8b';
const DEFAULT_MAX_TOOL_CALLS = 8;

class AssistantError extends Error {}

const BASE_SYSTEM_PROMPT = `You are LANShare's assistant. You help organise photos and videos by calling tools — \
you never invent facts about the library, you look them up first. Prefer a read tool (search_library, \
describe_library, detect_trips, preview_rule, list_rules, list_trips) before proposing any write. When an \
instruction is ambiguous, or a write tool's preview shows something that does not look like what was asked for, \
call ask_user instead of guessing — that is what it is for. Keep replies short and concrete, and say plainly \
when a write was only previewed rather than actually done.`;

/**
 * `memoryExamples` are already-retrieved corrected-pair examples (see
 * lib/assistant-memory.js) — this file takes them as plain data rather than
 * requiring that module directly, so the two stay decoupled and the caller
 * controls how many/which examples to surface.
 */
function buildSystemPrompt(memoryExamples = []) {
  if (!memoryExamples.length) return BASE_SYSTEM_PROMPT;
  const examples = memoryExamples
    .map((e) => `Instruction: ${e.instruction}\nRule: ${e.ruleText}`)
    .join('\n\n');
  return `${BASE_SYSTEM_PROMPT}\n\nExamples from this person's own past instructions and rules, closest first — \
follow this person's own vocabulary and habits where they differ from a generic assumption:\n\n${examples}`;
}

async function callChat({
  host, model, fetchImpl, messages,
}) {
  let res;
  try {
    res = await fetchImpl(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, messages, tools: assistantTools.toolSchemas(), stream: false,
      }),
    });
  } catch (err) {
    throw new AssistantError(`Could not reach the local model at ${host} — is it running? (${err.message})`);
  }

  // Same fix as lib/nl-rules.js's callModel(): 404 from a *running* Ollama
  // means the model is not installed, not that the server is down — and
  // the wrong diagnosis here sends someone chasing a different problem.
  if (res.status === 404) {
    const installed = await nlRules.listModels({ host, fetchImpl });
    throw new AssistantError(
      installed.length
        ? `"${model}" is not installed in Ollama. Either run "ollama pull ${model}", `
          + `or pick one you already have: ${installed.join(', ')}.`
        : `"${model}" is not installed, and Ollama reports no models at all. `
          + `Run "ollama pull ${model}" to download it.`,
    );
  }
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      if (typeof body?.error === 'string' && body.error.trim()) detail = body.error.split('\n')[0].trim();
    } catch {
      /* no readable body — fall back to the status alone */
    }
    throw new AssistantError(detail
      ? `Ollama could not run "${model}": ${detail}`
      : `The local model refused that request (${res.status})`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new AssistantError('The local model returned something that was not valid JSON');
  }
  if (!body?.message) throw new AssistantError('The local model returned an empty response');
  return body.message;
}

/** A tool call's arguments arrive as a JSON string from some models, already-parsed objects from others. */
function parseArgs(rawArgs) {
  if (rawArgs && typeof rawArgs === 'object') return rawArgs;
  if (typeof rawArgs === 'string') {
    try {
      const parsed = JSON.parse(rawArgs);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * One conversation turn: send `userMessage` (plus any prior `conversation`),
 * let the model call tools until it either answers in plain text or calls
 * `ask_user`, and return whichever happened.
 *
 * A tool call that itself throws (a malformed rule draft, say) does not
 * end the turn — its error is fed back to the model as that tool's result,
 * exactly like a failed read would be, so the model can see what went
 * wrong and either retry differently or ask_user about it.
 *
 * @returns {{reply: string|null, question: {question, options}|null, messages: Array, toolLog: Array}}
 *   Exactly one of `reply`/`question` is non-null.
 */
async function converse({
  library, db, config = null, conversation = [], userMessage,
  host = DEFAULT_HOST, model = DEFAULT_MODEL, fetchImpl = (...args) => fetch(...args),
  maxToolCalls = DEFAULT_MAX_TOOL_CALLS, memoryExamples = [], systemPrompt = null,
}) {
  if (!userMessage || !userMessage.trim()) throw new AssistantError('Say something first');
  if (!db) throw new AssistantError('converse() needs a real IndexDb');

  const messages = conversation.length
    ? [...conversation, { role: 'user', content: userMessage }]
    : [{ role: 'system', content: systemPrompt || buildSystemPrompt(memoryExamples) }, { role: 'user', content: userMessage }];

  const toolLog = [];

  for (let i = 0; i < maxToolCalls; i++) {
    // eslint-disable-next-line no-await-in-loop
    const msg = await callChat({
      host, model, fetchImpl, messages,
    });
    messages.push(msg);

    const calls = msg.tool_calls || [];
    if (!calls.length) {
      return {
        reply: msg.content || '', question: null, messages, toolLog,
      };
    }

    for (const call of calls) {
      const name = call.function?.name;
      const args = parseArgs(call.function?.arguments);

      if (name === 'ask_user') {
        return {
          reply: null,
          question: { question: args.question || '', options: Array.isArray(args.options) ? args.options : [] },
          messages,
          toolLog,
        };
      }

      let toolResult;
      try {
        const trustLevel = trust.getTrustLevel(config, name);
        // eslint-disable-next-line no-await-in-loop
        toolResult = await assistantTools.invokeTool(name, args, { library, db, config }, trustLevel);
      } catch (err) {
        toolResult = { name, error: err.message };
      }
      // `args` travels alongside the result — e.g. so a caller recording
      // accepted-rule memory (see lib/assistant-memory.js) can see exactly
      // what rule text a real save_rule call actually saved, not just that
      // one succeeded.
      toolLog.push({ ...toolResult, args });
      messages.push({ role: 'tool', content: JSON.stringify(toolResult) });
    }
  }

  throw new AssistantError(
    'The assistant made too many tool calls in a row without a final answer — stopping rather than looping forever.',
  );
}

module.exports = {
  AssistantError,
  DEFAULT_HOST,
  DEFAULT_MODEL,
  buildSystemPrompt,
  converse,
};
