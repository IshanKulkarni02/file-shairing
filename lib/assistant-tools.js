'use strict';

/**
 * The tool inventory the assistant loop (lib/assistant.js) hands to the
 * model — "the tool layer is the actual design," per plan.md. The model
 * chooses a tool and fills its arguments; every tool here is ordinary
 * tested code, wired to functions this project already has and already
 * tests on their own. Nothing in this file talks to a model.
 *
 * Split by blast radius, which is what makes graduated trust possible at
 * all: read tools always run. Write tools always have a `preview` (what
 * would happen) alongside `execute` (make it happen), because that split
 * is exactly what lets a write tool sit at 'ask' (preview shown, nothing
 * happens), 'ghost' (preview computed and logged, nothing happens), or
 * 'auto' (execute for real) — see invokeTool() and lib/trust.js.
 *
 * import_from_card is deliberately not a tool here yet: wiring it in
 * safely needs either a real capture device or a properly simulated one to
 * test against, which is a separate, sizeable piece of work of its own.
 */

const sortRules = require('./sort-rules');
const sortEngine = require('./sort-engine');
const indexDbLib = require('./index-db');
const tripClustering = require('./trip-clustering');

class AssistantToolError extends Error {}

/** Write tool names are also their lib/trust.js action-type keys — one name, one meaning, everywhere. */
const WRITE_ACTION_TYPES = ['save_rule', 'apply_rules', 'run_once'];

// ---------------------------------------------------------------------------
// Read tools — always safe to run
// ---------------------------------------------------------------------------

function searchLibrary(args, { db }) {
  const {
    text, kind, cameraMake, from, to, near, radiusKm, limit,
  } = args || {};
  const rows = db.search({
    text, kind, cameraMake, from, to, near, radiusKm, limit: Math.min(limit || 50, 500),
  });
  return { results: rows.map(indexDbLib.dbRowToResult) };
}

/** Counts, cameras seen, and the date span of what is actually in the library — never the raw file list, which does not fit a prompt. */
function describeLibrary(args, { db }) {
  const totalFiles = db.count();
  const dated = db.filesForClustering();
  const cameras = [...new Set(dated
    .map((f) => `${f.cameraMake ?? ''} ${f.cameraModel ?? ''}`.trim())
    .filter(Boolean))];
  const dates = dated.map((f) => f.capturedAt).filter(Boolean).sort();
  return {
    totalFiles,
    filesWithCaptureTime: dated.length,
    cameras,
    dateRange: dates.length ? { earliest: dates[0], latest: dates[dates.length - 1] } : null,
  };
}

/** A preview of what Ghost Mode's clustering would find — pure, reads nothing but the index, writes nothing. */
function detectTrips(args, { db }) {
  const files = db.filesForClustering();
  const { clusters } = tripClustering.detectBursts(files, args?.clusterOptions || {});
  return {
    candidateTrips: clusters.map((c) => ({
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      fileCount: c.files.length,
      cameras: [...new Set(c.files.map((f) => `${f.cameraMake ?? ''} ${f.cameraModel ?? ''}`.trim()).filter(Boolean))],
    })),
  };
}

function previewRuleText(text, { library, db }) {
  const entries = db.search({ limit: 1_000_000 }).map(indexDbLib.dbRowToResult);
  return sortEngine.plan({ library, entries, rulesText: text, db });
}

function previewRule(args, ctx) {
  if (typeof args?.text !== 'string' || !args.text.trim()) throw new AssistantToolError('preview_rule needs rule text');
  return previewRuleText(args.text, ctx);
}

function listRules(args, { library }) {
  const text = sortRules.readRulesText(library);
  let parsed = [];
  let error = null;
  try {
    parsed = sortRules.parse(text);
  } catch (err) {
    error = err.message;
  }
  return { text, ruleCount: parsed.length, error };
}

function listTrips(args, { db }) {
  const status = typeof args?.status === 'string' ? args.status : 'approved';
  return { trips: db.listTripClusters(status) };
}

// ---------------------------------------------------------------------------
// Write tools — trust-gated; each has a read-only preview and a real execute
// ---------------------------------------------------------------------------

function saveRulePreview(args, { library }) {
  if (typeof args?.text !== 'string' || !args.text.trim()) throw new AssistantToolError('save_rule needs rule text');
  const parsed = sortRules.parse(args.text); // throws SortRulesError on a bad draft — the model gets that back as an error, exactly like a hand-typed one would
  return { wouldSave: args.text, ruleCount: parsed.length };
}

function saveRuleExecute(args, { library }) {
  const parsed = sortRules.saveRulesText(library, args.text, { message: args.message || 'Saved by the assistant' });
  return { saved: true, ruleCount: parsed.length, version: sortRules.rulesVersion(library) };
}

function applyRulesPreview(args, ctx) {
  return previewRuleText(sortRules.readRulesText(ctx.library), ctx);
}

async function applyRulesExecute(args, ctx) {
  const planned = await previewRuleText(sortRules.readRulesText(ctx.library), ctx);
  const batch = await sortEngine.apply({ library: ctx.library, moves: planned.moves });
  return { batch };
}

function runOncePreview(args, ctx) {
  if (typeof args?.text !== 'string' || !args.text.trim()) throw new AssistantToolError('run_once needs rule text');
  return previewRuleText(args.text, ctx);
}

async function runOnceExecute(args, ctx) {
  const planned = await previewRuleText(args.text, ctx);
  const batch = await sortEngine.apply({ library: ctx.library, moves: planned.moves });
  return { batch };
}

/** Always allowed, regardless of trust — an escape hatch that needs permission is not an escape hatch. */
async function undoLastExecute(args, { library }) {
  return sortEngine.undoLastBatch({ library });
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const TOOLS = {
  search_library: {
    category: 'read',
    description: 'Search the library by text, camera, kind, date range, or nearby place. Returns matching files.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Free-text search over file names' },
        kind: { type: 'string', enum: ['image', 'video', 'audio', 'file'] },
        cameraMake: { type: 'string' },
        from: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        to: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        limit: { type: 'integer', description: 'Max results, default 50' },
      },
    },
    run: searchLibrary,
  },
  describe_library: {
    category: 'read',
    description: 'Summarise the whole library: total files, cameras seen, and the date range covered. Never dumps the file list.',
    parameters: { type: 'object', properties: {} },
    run: describeLibrary,
  },
  detect_trips: {
    category: 'read',
    description: 'Preview what the trip-clustering algorithm would group into candidate trips right now, without proposing or saving anything.',
    parameters: { type: 'object', properties: {} },
    run: detectTrips,
  },
  preview_rule: {
    category: 'read',
    description: 'Dry-run a piece of rule text against the whole library: what would move where, without moving anything.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: previewRule,
  },
  list_rules: {
    category: 'read',
    description: 'Read the currently saved sorting rules.',
    parameters: { type: 'object', properties: {} },
    run: listRules,
  },
  list_trips: {
    category: 'read',
    description: 'List trips at a given status (default "approved").',
    parameters: { type: 'object', properties: { status: { type: 'string', enum: ['proposed', 'approved', 'rejected', 'superseded'] } } },
    run: listTrips,
  },

  save_rule: {
    category: 'write',
    description: 'Save a new standing sorting rule. Preview it first with preview_rule if unsure what it will do.',
    parameters: { type: 'object', properties: { text: { type: 'string' }, message: { type: 'string' } }, required: ['text'] },
    preview: saveRulePreview,
    execute: saveRuleExecute,
  },
  apply_rules: {
    category: 'write',
    description: 'Apply the currently saved rules to the whole library, moving every matching file.',
    parameters: { type: 'object', properties: {} },
    preview: applyRulesPreview,
    execute: applyRulesExecute,
  },
  run_once: {
    category: 'write',
    description: 'Apply a one-off piece of rule text without saving it as a standing rule.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    preview: runOncePreview,
    execute: runOnceExecute,
  },
  undo_last: {
    category: 'write',
    alwaysAllowed: true,
    description: 'Undo the most recent apply_rules or run_once batch, restoring every file it moved.',
    parameters: { type: 'object', properties: {} },
    execute: undoLastExecute,
  },
};

/** The tool schemas in the shape Ollama's /api/chat `tools` parameter expects (OpenAI-style function calling). */
function toolSchemas() {
  return Object.entries(TOOLS).map(([name, def]) => ({
    type: 'function',
    function: { name, description: def.description, parameters: def.parameters },
  }));
}

/**
 * Run one tool call under a trust decision. `trustLevel` is resolved by the
 * caller (lib/assistant.js), not looked up here, so this stays pure with
 * respect to config/db beyond what the tool itself touches.
 *
 * - A read tool always just runs.
 * - `undo_last` always just runs — the one write tool with no trust gate.
 * - Any other write tool: 'ask' returns a preview and does not execute;
 *   'ghost' computes and returns the preview *and* logs it as what would
 *   have happened, still without executing; 'auto' executes for real.
 */
async function invokeTool(name, args, ctx, trustLevel = 'ask') {
  const def = TOOLS[name];
  if (!def) throw new AssistantToolError(`Unknown tool "${name}"`);

  if (def.category === 'read') {
    return { name, ranFor: 'real', result: await def.run(args, ctx) };
  }

  if (def.alwaysAllowed) {
    return { name, ranFor: 'real', result: await def.execute(args, ctx) };
  }

  if (trustLevel === 'auto') {
    const result = await def.execute(args, ctx);
    ctx.db?.appendAuditLog?.({ actionType: name, subjectId: 'assistant-call', decision: 'auto-approved', reason: JSON.stringify(args).slice(0, 500) });
    return { name, ranFor: 'real', result };
  }

  const preview = await def.preview(args, ctx);
  if (trustLevel === 'ghost') {
    ctx.db?.appendAuditLog?.({ actionType: name, subjectId: 'assistant-call', decision: 'ghost-logged', reason: JSON.stringify(args).slice(0, 500) });
  }
  return { name, ranFor: 'preview', trustLevel, result: preview };
}

module.exports = {
  AssistantToolError,
  TOOLS,
  WRITE_ACTION_TYPES,
  toolSchemas,
  invokeTool,
};
