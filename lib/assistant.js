'use strict';

/**
 * The assistant loop: a model chooses tools (lib/assistant-tools.js), this
 * file runs them under whatever trust level each one currently has
 * (lib/trust.js), and feeds the results back until the model either
 * answers in plain text or asks the person a clarifying question.
 *
 * "The model drafts, a person approves, tested code executes" — stated in
 * plan.md for rule-drafting, and unchanged here even though the model now
 * chooses *which* tested code to run rather than just drafting one line of
 * text. Every write tool still only ever does what lib/assistant-tools.js
 * already lets it do, gated by the exact same trust ladder Ghost Mode uses.
 *
 * Two backends, one interface, per plan.md's "local by default, cloud on
 * demand" design — neither is load-bearing for the other:
 *
 * - **local** (default): Ollama's `/api/chat`, same host convention as
 *   lib/nl-rules.js. Hermes 3 8B is the default model — a Llama-3.1
 *   fine-tune trained specifically for tool use, not a generic instruct
 *   model doing its best.
 * - **cloud** (a deliberate per-call choice, never a default): Anthropic's
 *   Messages API. No tool here exposes a file's actual bytes — every one
 *   returns metadata (names, paths, camera fields, dates, plan previews) —
 *   so a cloud call is structurally incapable of leaking file content
 *   regardless of what the model asks for; CLOUD_DISCLOSURE below is what
 *   the calling UI shows *before* the call, per plan.md: "what leaves the
 *   machine on a cloud call must be stated in the UI at the moment of the
 *   call." An API key is required and never handled here — the caller
 *   decrypts it from wherever it keeps secrets (see lib/server-app.js).
 *
 * Both backends translate to and from one internal message shape so the
 * tool-calling loop itself never needs to know which one answered:
 *   {role:'system'|'user', content}
 *   {role:'assistant', content, toolCalls:[{id, name, arguments}]}
 *   {role:'tool', toolCallId, name, content}
 */

const nlRules = require('./nl-rules');
const assistantTools = require('./assistant-tools');
const trust = require('./trust');

const DEFAULT_HOST = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'hermes3:8b';
const DEFAULT_CLOUD_HOST = 'https://api.anthropic.com';
const DEFAULT_CLOUD_MODEL = 'claude-sonnet-5';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOOL_CALLS = 8;
const CLOUD_MAX_TOKENS = 1024;

const CLOUD_DISCLOSURE = 'This message goes to a cloud API (Anthropic), not just this machine: your instruction '
  + 'text, and whatever file names, camera fields, dates and paths the assistant looks up while answering it. '
  + 'File contents themselves are never sent — no tool here can read or return them.';

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

// ---------------------------------------------------------------------------
// Local backend — Ollama
// ---------------------------------------------------------------------------

/** Common-format messages -> Ollama's OpenAI-style /api/chat shape. */
function toOllamaMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      const out = { role: 'assistant', content: m.content || '' };
      if (m.toolCalls?.length) {
        out.tool_calls = m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } }));
      }
      return out;
    }
    if (m.role === 'tool') return { role: 'tool', content: m.content };
    return { role: m.role, content: m.content };
  });
}

async function callLocalChat({
  host, model, fetchImpl, messages,
}) {
  let res;
  try {
    res = await fetchImpl(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, messages: toOllamaMessages(messages), tools: assistantTools.toolSchemas(), stream: false,
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

  const msg = body.message;
  return {
    role: 'assistant',
    content: msg.content || '',
    toolCalls: (msg.tool_calls || []).map((c, i) => ({
      id: c.id || `call_${i}`,
      name: c.function?.name,
      arguments: parseArgs(c.function?.arguments),
    })),
  };
}

// ---------------------------------------------------------------------------
// Cloud backend — Anthropic Messages API, a deliberate per-call choice
// ---------------------------------------------------------------------------

function toAnthropicTools(schemas) {
  return schemas.map((s) => ({
    name: s.function.name, description: s.function.description, input_schema: s.function.parameters,
  }));
}

/**
 * Anthropic keeps the system prompt as its own top-level field rather than
 * a message with a role, and a tool result is a `user` turn carrying a
 * `tool_result` content block rather than its own `role:'tool'` — both
 * genuinely different wire shapes from Ollama's, which is exactly why this
 * translation exists instead of trying to make one wire format serve both.
 */
function toAnthropicMessages(messages) {
  let system = '';
  const wireMessages = [];
  for (const m of messages) {
    if (m.role === 'system') { system = m.content || ''; continue; }
    if (m.role === 'user') { wireMessages.push({ role: 'user', content: m.content }); continue; }
    if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const call of m.toolCalls || []) {
        content.push({
          type: 'tool_use', id: call.id, name: call.name, input: call.arguments,
        });
      }
      wireMessages.push({ role: 'assistant', content });
      continue;
    }
    if (m.role === 'tool') {
      wireMessages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
      });
    }
  }
  return { system, messages: wireMessages };
}

async function callCloudChat({
  apiKey, host, model, fetchImpl, messages,
}) {
  if (!apiKey) {
    throw new AssistantError('No cloud API key is set up — add one before using "think harder".');
  }
  const { system, messages: wireMessages } = toAnthropicMessages(messages);

  let res;
  try {
    res = await fetchImpl(`${host}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model, max_tokens: CLOUD_MAX_TOKENS, system, messages: wireMessages, tools: toAnthropicTools(assistantTools.toolSchemas()),
      }),
    });
  } catch (err) {
    throw new AssistantError(`Could not reach the cloud model at ${host} (${err.message})`);
  }

  if (res.status === 401) {
    throw new AssistantError('The cloud API key was refused — check it and set it again.');
  }
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      if (typeof body?.error?.message === 'string' && body.error.message.trim()) detail = body.error.message.trim();
    } catch {
      /* no readable body — fall back to the status alone */
    }
    throw new AssistantError(detail
      ? `The cloud model refused that request: ${detail}`
      : `The cloud model refused that request (${res.status})`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new AssistantError('The cloud model returned something that was not valid JSON');
  }
  const blocks = Array.isArray(body?.content) ? body.content : null;
  if (!blocks) throw new AssistantError('The cloud model returned an empty response');

  const textBlock = blocks.find((b) => b.type === 'text');
  const toolBlocks = blocks.filter((b) => b.type === 'tool_use');
  return {
    role: 'assistant',
    content: textBlock?.text || '',
    toolCalls: toolBlocks.map((b) => ({ id: b.id, name: b.name, arguments: b.input || {} })),
  };
}

// ---------------------------------------------------------------------------
// The loop — backend-agnostic from here down
// ---------------------------------------------------------------------------

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
  backend = 'local',
  host = DEFAULT_HOST, model = DEFAULT_MODEL,
  apiKey = null, cloudHost = DEFAULT_CLOUD_HOST, cloudModel = DEFAULT_CLOUD_MODEL,
  fetchImpl = (...args) => fetch(...args),
  maxToolCalls = DEFAULT_MAX_TOOL_CALLS, memoryExamples = [], systemPrompt = null,
}) {
  if (!userMessage || !userMessage.trim()) throw new AssistantError('Say something first');
  if (!db) throw new AssistantError('converse() needs a real IndexDb');
  if (backend !== 'local' && backend !== 'cloud') throw new AssistantError(`Unknown backend "${backend}"`);

  const messages = conversation.length
    ? [...conversation, { role: 'user', content: userMessage }]
    : [{ role: 'system', content: systemPrompt || buildSystemPrompt(memoryExamples) }, { role: 'user', content: userMessage }];

  const toolLog = [];
  const callBackend = backend === 'cloud'
    ? () => callCloudChat({
      apiKey, host: cloudHost, model: cloudModel, fetchImpl, messages,
    })
    : () => callLocalChat({
      host, model, fetchImpl, messages,
    });

  for (let i = 0; i < maxToolCalls; i++) {
    // eslint-disable-next-line no-await-in-loop
    const msg = await callBackend();
    messages.push(msg);

    if (!msg.toolCalls.length) {
      return {
        reply: msg.content || '', question: null, messages, toolLog,
      };
    }

    for (const call of msg.toolCalls) {
      if (call.name === 'ask_user') {
        return {
          reply: null,
          question: { question: call.arguments.question || '', options: Array.isArray(call.arguments.options) ? call.arguments.options : [] },
          messages,
          toolLog,
        };
      }

      let toolResult;
      try {
        const trustLevel = trust.getTrustLevel(config, call.name);
        // eslint-disable-next-line no-await-in-loop
        toolResult = await assistantTools.invokeTool(call.name, call.arguments, { library, db, config }, trustLevel);
      } catch (err) {
        toolResult = { name: call.name, error: err.message };
      }
      // `args` travels alongside the result — e.g. so a caller recording
      // accepted-rule memory (see lib/assistant-memory.js) can see exactly
      // what rule text a real save_rule call actually saved, not just that
      // one succeeded.
      toolLog.push({ ...toolResult, args: call.arguments });
      messages.push({
        role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(toolResult),
      });
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
  DEFAULT_CLOUD_HOST,
  DEFAULT_CLOUD_MODEL,
  CLOUD_DISCLOSURE,
  buildSystemPrompt,
  converse,
};
