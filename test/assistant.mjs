/**
 * lib/assistant.js against a scripted fake Ollama — no real model or
 * network call ever leaves this test, but the real tool-calling loop,
 * trust-gating, and error handling around it are fully exercised, the
 * same "fake fetch, real logic" shape lib/nl-rules.js and lib/geocode.js's
 * own tests already use.
 *
 *   node test/assistant.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const assistant = require(path.join(here, '..', 'lib', 'assistant.js'));
const { IndexDb } = require(path.join(here, '..', 'lib', 'index-db.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

function scratchLibrary() {
  return mkdtempSync(path.join(tmpdir(), 'lanshare-assistant-'));
}

/** A scripted fake Ollama: one canned /api/chat response per call, in order, plus a fixed /api/tags for listModels(). */
function scriptedFetch(responses, { models = [] } = {}) {
  let i = 0;
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, headers: options?.headers, body: options?.body ? JSON.parse(options.body) : null });
    if (url.endsWith('/api/tags')) {
      return { ok: true, json: async () => ({ models: models.map((m) => ({ name: m })) }) };
    }
    if (url.endsWith('/api/chat') || url.endsWith('/v1/messages')) {
      const next = responses[i];
      i += 1;
      if (!next) throw new Error(`scriptedFetch exhausted after ${i - 1} calls — the loop called the model endpoint more than scripted`);
      return typeof next === 'function' ? next() : next;
    }
    throw new Error(`unexpected URL in test: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

const chatOk = (message) => ({ ok: true, json: async () => ({ message }) });

/** A canned Anthropic Messages API response — a text block, a tool_use block, or both. */
const cloudOk = ({ text = '', toolUse = [] } = {}) => ({
  ok: true,
  json: async () => ({
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...toolUse.map((t) => ({
        type: 'tool_use', id: t.id || `toolu_${Math.random().toString(36).slice(2)}`, name: t.name, input: t.input || {},
      })),
    ],
  }),
});

try {
  // --- a plain text answer, no tools called at all --------------------------

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      const fetchImpl = scriptedFetch([chatOk({ role: 'assistant', content: 'Your library has 3 files.' })]);
      const result = await assistant.converse({
        library, db, userMessage: 'How many files do I have?', fetchImpl,
      });
      check('a model that answers directly returns that reply', result.reply === 'Your library has 3 files.', JSON.stringify(result));
      check('no question is raised', result.question === null);
      check('the tool log is empty — nothing was called', result.toolLog.length === 0);
      check('exactly one request was made', fetchImpl.calls.length === 1);
      check('the request carries the tool schemas so the model can choose to use them',
        Array.isArray(fetchImpl.calls[0].body.tools) && fetchImpl.calls[0].body.tools.length > 0);
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  // --- a read tool call, fed back, then a final answer -----------------------

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      db.upsert({
        relPath: '/a.jpg', size: 1, mtimeMs: 1, hash: 'h1', kind: 'image', encrypted: 0,
        cameraMake: 'DJI', cameraModel: 'FC3582', capturedAt: '2026-08-01T00:00:00.000Z', capturedAtBasis: 'utc',
        gpsLat: null, gpsLon: null,
      });
      const fetchImpl = scriptedFetch([
        chatOk({
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'describe_library', arguments: {} } }],
        }),
        chatOk({ role: 'assistant', content: 'You have 1 file, from a DJI FC3582.' }),
      ]);
      const result = await assistant.converse({
        library, db, userMessage: 'What cameras do I have?', fetchImpl,
      });
      check('a read tool call is executed and its result fed back',
        result.toolLog.length === 1 && result.toolLog[0].name === 'describe_library' && result.toolLog[0].ranFor === 'real',
        JSON.stringify(result.toolLog));
      check('the final answer after the tool call is returned', result.reply === 'You have 1 file, from a DJI FC3582.');
      check('two requests were made — the tool call, then the follow-up', fetchImpl.calls.length === 2);
      check('the second request includes the tool result as a message',
        fetchImpl.calls[1].body.messages.some((m) => m.role === 'tool'));
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  // --- a write tool at 'ask' trust is only previewed -------------------------

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      const fetchImpl = scriptedFetch([
        chatOk({
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'save_rule', arguments: JSON.stringify({ text: 'when kind = image -> /Photos' }) } }],
        }),
        chatOk({ role: 'assistant', content: 'I previewed that rule — want me to save it?' }),
      ]);
      const result = await assistant.converse({
        library, db, userMessage: 'Sort my images into /Photos', fetchImpl,
      });
      check('a write tool at the default (ask) trust only produces a preview',
        result.toolLog[0].ranFor === 'preview' && result.toolLog[0].trustLevel === 'ask', JSON.stringify(result.toolLog));
      check('the tool log carries the original arguments alongside the result — a caller needs to see what was actually asked for',
        result.toolLog[0].args?.text === 'when kind = image -> /Photos', JSON.stringify(result.toolLog[0]));
      const sortRules = require(path.join(here, '..', 'lib', 'sort-rules.js'));
      check('nothing was actually saved', sortRules.readRulesText(library) === '');
      check('the model\'s follow-up reply is still returned normally', result.reply.includes('previewed'));
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  {
    // A JSON-string arguments payload (some models emit this) is parsed correctly.
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      const fetchImpl = scriptedFetch([
        chatOk({
          role: 'assistant', content: '',
          tool_calls: [{ function: { name: 'search_library', arguments: '{"cameraMake":"DJI"}' } }],
        }),
        chatOk({ role: 'assistant', content: 'No DJI files found.' }),
      ]);
      const result = await assistant.converse({ library, db, userMessage: 'find DJI shots', fetchImpl });
      check('string-encoded tool arguments are parsed into a real object',
        result.toolLog[0].result.results !== undefined, JSON.stringify(result.toolLog));
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  {
    // Malformed JSON in the arguments string must not crash the whole turn.
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      const fetchImpl = scriptedFetch([
        chatOk({
          role: 'assistant', content: '',
          tool_calls: [{ function: { name: 'describe_library', arguments: '{not valid json' } }],
        }),
        chatOk({ role: 'assistant', content: 'ok' }),
      ]);
      const result = await assistant.converse({ library, db, userMessage: 'describe it', fetchImpl });
      check('malformed tool-call arguments degrade to an empty object rather than throwing',
        result.toolLog[0].name === 'describe_library' && result.toolLog[0].ranFor === 'real', JSON.stringify(result.toolLog));
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  // --- ask_user stops the loop and hands control back -------------------------

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      const fetchImpl = scriptedFetch([
        chatOk({
          role: 'assistant', content: '',
          tool_calls: [{ function: { name: 'ask_user', arguments: { question: 'Which camera do you mean?', options: ['DJI', 'iPhone'] } } }],
        }),
      ]);
      const result = await assistant.converse({ library, db, userMessage: 'sort my camera files', fetchImpl });
      check('ask_user ends the turn with a question, not a reply', result.reply === null && result.question !== null);
      check('the question and its options are surfaced', result.question.question === 'Which camera do you mean?'
        && result.question.options.length === 2, JSON.stringify(result.question));
      check('ask_user does not appear in the tool log — it never reached invokeTool', result.toolLog.length === 0);
      check('exactly one request was made — the loop stopped, it did not keep going', fetchImpl.calls.length === 1);
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  // --- an unknown tool call is surfaced as an error, not a crash --------------

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      const fetchImpl = scriptedFetch([
        chatOk({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'delete_everything', arguments: {} } }] }),
        chatOk({ role: 'assistant', content: 'I do not have that tool.' }),
      ]);
      const result = await assistant.converse({ library, db, userMessage: 'do something odd', fetchImpl });
      check('an unknown tool name is fed back to the model as an error, not thrown out of the loop',
        typeof result.toolLog[0].error === 'string', JSON.stringify(result.toolLog));
      check('the conversation still completes normally afterward', result.reply === 'I do not have that tool.');
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  // --- runaway tool-calling is capped, not infinite ---------------------------

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      const alwaysCallsATool = () => chatOk({
        role: 'assistant', content: '', tool_calls: [{ function: { name: 'describe_library', arguments: {} } }],
      });
      const fetchImpl = scriptedFetch(Array.from({ length: 10 }, () => alwaysCallsATool));
      let threw = false;
      try {
        await assistant.converse({
          library, db, userMessage: 'loop forever', fetchImpl, maxToolCalls: 3,
        });
      } catch (err) {
        threw = err instanceof assistant.AssistantError;
      }
      check('a model that never stops calling tools is cut off with a clear error, not an infinite loop', threw);
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  // --- Ollama/network failure modes, mirroring lib/nl-rules.js's own tests ---

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      const throwingFetch = async () => { throw new Error('ECONNREFUSED'); };
      let threw = null;
      try { await assistant.converse({ library, db, userMessage: 'hi', fetchImpl: throwingFetch }); } catch (err) { threw = err; }
      check('a network failure produces a clear AssistantError naming the host',
        threw instanceof assistant.AssistantError && threw.message.includes('127.0.0.1:11434'), threw?.message);
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      const notInstalled = scriptedFetch([{ ok: false, status: 404 }], { models: ['llama3.1:8b', 'qwen2.5:7b'] });
      let threw = null;
      try { await assistant.converse({ library, db, userMessage: 'hi', fetchImpl: notInstalled }); } catch (err) { threw = err; }
      check('a 404 names the missing model and lists what is actually installed',
        threw instanceof assistant.AssistantError && threw.message.includes('hermes3:8b') && threw.message.includes('llama3.1:8b'),
        threw?.message);
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      const badLoad = scriptedFetch([{
        ok: false, status: 500, json: async () => ({ error: "unknown model architecture: 'mllama'\nmore detail" }),
      }]);
      let threw = null;
      try { await assistant.converse({ library, db, userMessage: 'hi', fetchImpl: badLoad }); } catch (err) { threw = err; }
      check('Ollama\'s own error body is surfaced, not just the bare status code',
        threw?.message.includes('unknown model architecture'), threw?.message);
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      const emptyBody = scriptedFetch([{ ok: true, json: async () => ({}) }]);
      let threw = null;
      try { await assistant.converse({ library, db, userMessage: 'hi', fetchImpl: emptyBody }); } catch (err) { threw = err; }
      check('a response with no message field is refused rather than crashing downstream', threw instanceof assistant.AssistantError);
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  // --- memory examples and multi-turn conversation shape ----------------------

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      const fetchImpl = scriptedFetch([chatOk({ role: 'assistant', content: 'ok' })]);
      await assistant.converse({
        library, db, userMessage: 'sort my ride photos', fetchImpl,
        memoryExamples: [{ instruction: 'ride photos go to /Rides', ruleText: 'when kind = image -> /Rides' }],
      });
      const systemMsg = fetchImpl.calls[0].body.messages.find((m) => m.role === 'system');
      check('memory examples are folded into the system prompt',
        systemMsg?.content.includes('/Rides'), systemMsg?.content);
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      const priorConversation = [
        { role: 'system', content: 'You are LANShare\'s assistant.' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ];
      const fetchImpl = scriptedFetch([chatOk({ role: 'assistant', content: 'sure' })]);
      const result = await assistant.converse({
        library, db, conversation: priorConversation, userMessage: 'follow up question', fetchImpl,
      });
      check('an existing conversation is continued, not restarted with a fresh system prompt',
        fetchImpl.calls[0].body.messages.filter((m) => m.role === 'system').length === 1
        && fetchImpl.calls[0].body.messages.length === priorConversation.length + 1, JSON.stringify(fetchImpl.calls[0].body.messages));
      check('the returned messages include the whole history plus this turn',
        result.messages.length >= priorConversation.length + 2);
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  // --- basic input validation --------------------------------------------------

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      let threw = false;
      try { await assistant.converse({ library, db, userMessage: '   ', fetchImpl: scriptedFetch([]) }); } catch (err) { threw = err instanceof assistant.AssistantError; }
      check('an empty message is refused before ever calling the model', threw);
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  {
    let threw = false;
    try { await assistant.converse({ library: scratchLibrary(), userMessage: 'hi', fetchImpl: scriptedFetch([]) }); } catch (err) { threw = err instanceof assistant.AssistantError; }
    check('converse() without a db is refused clearly', threw);
  }

  // --- the cloud backend (Anthropic), a deliberate per-call choice -----------

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      let threw = null;
      try {
        await assistant.converse({
          library, db, userMessage: 'hi', backend: 'cloud', fetchImpl: scriptedFetch([]),
        });
      } catch (err) { threw = err; }
      check('the cloud backend refuses to even call out without an API key',
        threw instanceof assistant.AssistantError && threw.message.toLowerCase().includes('api key'), threw?.message);
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      const fetchImpl = scriptedFetch([cloudOk({ text: 'You have 0 files.' })]);
      const result = await assistant.converse({
        library, db, userMessage: 'how many files?', backend: 'cloud', apiKey: 'sk-test-key', fetchImpl,
      });
      check('a cloud reply with no tool use is returned as a plain answer', result.reply === 'You have 0 files.');
      check('the request goes to the Anthropic messages endpoint', fetchImpl.calls[0].url.endsWith('/v1/messages'));
      check('the API key travels as the x-api-key header, never in the body',
        fetchImpl.calls[0].headers['x-api-key'] === 'sk-test-key'
        && JSON.stringify(fetchImpl.calls[0].body).indexOf('sk-test-key') === -1);
      check('the system prompt is sent as Anthropic\'s own top-level field, not a message',
        typeof fetchImpl.calls[0].body.system === 'string' && fetchImpl.calls[0].body.system.length > 0
        && !fetchImpl.calls[0].body.messages.some((m) => m.role === 'system'), JSON.stringify(fetchImpl.calls[0].body.messages));
      check('the tools are translated into Anthropic\'s input_schema shape, not OpenAI\'s function-wrapped one',
        fetchImpl.calls[0].body.tools.some((t) => t.name === 'search_library' && t.input_schema), JSON.stringify(fetchImpl.calls[0].body.tools[0]));
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      db.upsert({
        relPath: '/a.jpg', size: 1, mtimeMs: 1, hash: 'h1', kind: 'image', encrypted: 0,
        cameraMake: 'DJI', cameraModel: 'FC3582', capturedAt: '2026-08-01T00:00:00.000Z', capturedAtBasis: 'utc',
        gpsLat: null, gpsLon: null,
      });
      const fetchImpl = scriptedFetch([
        cloudOk({ toolUse: [{ id: 'toolu_1', name: 'describe_library', input: {} }] }),
        cloudOk({ text: 'One DJI file.' }),
      ]);
      const result = await assistant.converse({
        library, db, userMessage: 'what cameras?', backend: 'cloud', apiKey: 'sk-test-key', fetchImpl,
      });
      check('a cloud tool_use block is executed exactly like an Ollama tool call',
        result.toolLog.length === 1 && result.toolLog[0].name === 'describe_library' && result.toolLog[0].ranFor === 'real',
        JSON.stringify(result.toolLog));
      check('the follow-up reply after the tool call is returned', result.reply === 'One DJI file.');

      // The second request's tool_result must reference the *same* tool_use id
      // Anthropic assigned — a mismatched id is a real API error on their side,
      // not a cosmetic detail.
      const secondBody = fetchImpl.calls[1].body;
      const toolResultBlock = secondBody.messages
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .find((b) => b.type === 'tool_result');
      check('the tool result is linked back to the exact tool_use id from Anthropic\'s own response',
        toolResultBlock?.tool_use_id === 'toolu_1', JSON.stringify(toolResultBlock));
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      const fetchImpl = scriptedFetch([
        cloudOk({ toolUse: [{ id: 'toolu_1', name: 'ask_user', input: { question: 'Which camera?', options: ['DJI', 'iPhone'] } }] }),
      ]);
      const result = await assistant.converse({
        library, db, userMessage: 'sort my stuff', backend: 'cloud', apiKey: 'sk-test-key', fetchImpl,
      });
      check('ask_user via the cloud backend stops the loop with a question, exactly like the local backend',
        result.reply === null && result.question?.question === 'Which camera?', JSON.stringify(result));
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      const unauthorized = scriptedFetch([{ ok: false, status: 401 }]);
      let threw = null;
      try {
        await assistant.converse({
          library, db, userMessage: 'hi', backend: 'cloud', apiKey: 'sk-bad-key', fetchImpl: unauthorized,
        });
      } catch (err) { threw = err; }
      check('a 401 from the cloud API is reported as a refused key, not a bare status code',
        threw?.message.toLowerCase().includes('refused'), threw?.message);
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      const badRequest = scriptedFetch([{
        ok: false, status: 400, json: async () => ({ error: { message: 'max_tokens: field required' } }),
      }]);
      let threw = null;
      try {
        await assistant.converse({
          library, db, userMessage: 'hi', backend: 'cloud', apiKey: 'sk-test-key', fetchImpl: badRequest,
        });
      } catch (err) { threw = err; }
      check('the cloud API\'s own error message is surfaced, not just the bare status code',
        threw?.message.includes('max_tokens: field required'), threw?.message);
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      const throwingFetch = async () => { throw new Error('ENOTFOUND'); };
      let threw = null;
      try {
        await assistant.converse({
          library, db, userMessage: 'hi', backend: 'cloud', apiKey: 'sk-test-key', fetchImpl: throwingFetch,
        });
      } catch (err) { threw = err; }
      check('a network failure against the cloud host is reported clearly',
        threw instanceof assistant.AssistantError && threw.message.includes('api.anthropic.com'), threw?.message);
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      const emptyBody = scriptedFetch([{ ok: true, json: async () => ({}) }]);
      let threw = null;
      try {
        await assistant.converse({
          library, db, userMessage: 'hi', backend: 'cloud', apiKey: 'sk-test-key', fetchImpl: emptyBody,
        });
      } catch (err) { threw = err; }
      check('a cloud response with no content blocks is refused rather than crashing downstream',
        threw instanceof assistant.AssistantError);
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  {
    const library = scratchLibrary();
    const db = new IndexDb(path.join(library, '.lanshare', 'index.db'));
    try {
      let threw = null;
      try { await assistant.converse({ library, db, userMessage: 'hi', backend: 'nope' }); } catch (err) { threw = err; }
      check('an unknown backend name is refused clearly',
        threw instanceof assistant.AssistantError && threw.message.includes('nope'), threw?.message);
    } finally {
      db.close();
      rmSync(library, { recursive: true, force: true });
    }
  }

  check('CLOUD_DISCLOSURE states plainly that file contents are never sent',
    assistant.CLOUD_DISCLOSURE.toLowerCase().includes('never') && assistant.CLOUD_DISCLOSURE.toLowerCase().includes('content'));
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error during the test run -> ${err.stack || err.message}`);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
