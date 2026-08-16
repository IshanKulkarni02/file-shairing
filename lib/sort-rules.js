'use strict';

/**
 * Sorting rules: a small, human-written text format, parsed, evaluated, and
 * — when git is available — auto-committed to a tiny dedicated repo every
 * time it changes.
 *
 * Rules are the opposite of the file index on every count that made the
 * index a database instead of a text file: small, human-meaningful, change
 * rarely, contain nothing private, and benefit enormously from history —
 * "why has everything gone to /Drone since Tuesday?" is a `git log`, not an
 * investigation. That is what this file exists to make true.
 *
 * One rule per line:
 *
 *   when camera.make = "DJI"                 -> /Drone/{year}/{month}
 *   when kind = video and gps near "Manali"  -> /Rides/Manali
 *
 * Ordered, first match wins. The condition grammar is deliberately small —
 * ANDed clauses, optionally ORed together (disjunctive normal form, no
 * parentheses) — because every example this format needs to express is
 * exactly that shape, and a fully general boolean expression parser is a
 * lot of surface for a format meant to stay readable by a human who is not
 * a programmer.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { haversineKm } = require('./index-db');

class SortRulesError extends Error {}

const FIELDS = ['camera.make', 'camera.model', 'kind'];
const PLACEHOLDERS = ['year', 'month', 'day'];
const DEFAULT_NEAR_RADIUS_KM = 20;

const RULES_SUBDIR = path.join('.lanshare', 'rules');
const RULES_FILENAME = 'rules.txt';

function rulesDir(library) {
  return path.join(library, RULES_SUBDIR);
}

function rulesPath(library) {
  return path.join(rulesDir(library), RULES_FILENAME);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseClause(text, lineNo) {
  const nearMatch = text.match(/^gps\s+near\s+"([^"]*)"(?:\s+within\s+(\d+(?:\.\d+)?)\s*km)?$/i);
  if (nearMatch) {
    const place = nearMatch[1].trim();
    if (!place) throw new SortRulesError(`Line ${lineNo}: "gps near" needs a place name in quotes`);
    return { field: 'gps', op: 'near', place, radiusKm: nearMatch[2] ? Number(nearMatch[2]) : DEFAULT_NEAR_RADIUS_KM };
  }

  const eqMatch = text.match(/^([a-zA-Z.]+)\s*=\s*(?:"([^"]*)"|(\S+))$/);
  if (eqMatch) {
    const field = eqMatch[1].toLowerCase();
    const value = eqMatch[2] !== undefined ? eqMatch[2] : eqMatch[3];
    if (!FIELDS.includes(field)) {
      throw new SortRulesError(`Line ${lineNo}: unknown field "${eqMatch[1]}" — expected one of ${FIELDS.join(', ')}`);
    }
    if (!value) throw new SortRulesError(`Line ${lineNo}: "${field}" needs a value`);
    return { field, op: '=', value };
  }

  throw new SortRulesError(`Line ${lineNo}: could not understand the condition "${text}"`);
}

/** Disjunctive normal form: an array of AND-groups, any one of which matching is enough. */
function parseCondition(text, lineNo) {
  if (!text.trim()) throw new SortRulesError(`Line ${lineNo}: a rule needs a condition`);
  return text.split(/\s+or\s+/i).map((group) => {
    const clauses = group.trim().split(/\s+and\s+/i).map((part) => parseClause(part.trim(), lineNo));
    return clauses;
  });
}

function parseDestination(text, lineNo) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    throw new SortRulesError(`Line ${lineNo}: the destination must be an absolute library path starting with "/" — got "${trimmed}"`);
  }
  for (const match of trimmed.matchAll(/\{([^}]*)\}/g)) {
    if (!PLACEHOLDERS.includes(match[1])) {
      throw new SortRulesError(`Line ${lineNo}: unknown placeholder "{${match[1]}}" — expected one of ${PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}`);
    }
  }
  return trimmed;
}

/**
 * The whole rules file, in order. Throws SortRulesError on the first
 * problem, naming the line — a rule file is short enough that "which line"
 * is always a useful answer, and refusing to save a broken file (see
 * saveRulesText below) is only worth anything if the error says why.
 */
function parse(text) {
  const rules = [];
  const lines = String(text || '').split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (!/^when\s+/i.test(trimmed)) {
      throw new SortRulesError(`Line ${lineNo}: expected a rule starting with "when" — got "${trimmed}"`);
    }
    const body = trimmed.replace(/^when\s+/i, '');
    const arrowMatch = body.match(/^(.*?)\s*(?:->|→)\s*(.+)$/);
    if (!arrowMatch) {
      throw new SortRulesError(`Line ${lineNo}: expected "-> /destination" somewhere after the condition — got "${trimmed}"`);
    }

    rules.push({
      line: lineNo,
      raw: trimmed,
      conditionGroups: parseCondition(arrowMatch[1], lineNo),
      destination: parseDestination(arrowMatch[2], lineNo),
    });
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function fieldValue(clause, file) {
  if (clause.field === 'camera.make') return file.cameraMake;
  if (clause.field === 'camera.model') return file.cameraModel;
  if (clause.field === 'kind') return file.kind;
  return null;
}

/**
 * `geocodePlace(name)` is a synchronous lookup — `{lat, lon}` or null —
 * because every place a rule set could reference has to be resolved before
 * files are matched against it one at a time; see lib/sort-engine.js, which
 * pre-resolves every place with lib/geocode.js (async, network-backed) and
 * hands this a plain function over the results.
 */
function clauseMatches(clause, file, geocodePlace) {
  if (clause.op === '=') {
    const actual = fieldValue(clause, file);
    return actual != null && String(actual).toLowerCase() === clause.value.toLowerCase();
  }
  if (clause.op === 'near') {
    if (!Number.isFinite(file.gpsLat) || !Number.isFinite(file.gpsLon)) return false;
    const point = geocodePlace?.(clause.place);
    if (!point) return false;
    return haversineKm(point.lat, point.lon, file.gpsLat, file.gpsLon) <= clause.radiusKm;
  }
  return false;
}

function conditionMatches(conditionGroups, file, geocodePlace) {
  return conditionGroups.some((andGroup) => andGroup.every((clause) => clauseMatches(clause, file, geocodePlace)));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function substitute(template, file) {
  if (!template.includes('{')) return template;
  const date = file.capturedAt ? new Date(file.capturedAt) : null;
  const valid = date && !Number.isNaN(date.getTime());
  return template.replace(/\{(year|month|day)\}/g, (_, key) => {
    if (!valid) return 'Unknown';
    if (key === 'year') return String(date.getFullYear());
    if (key === 'month') return pad2(date.getMonth() + 1);
    return pad2(date.getDate());
  });
}

/** The first matching rule's destination for this one file, or null if nothing matches. */
function destinationFor(rules, file, geocodePlace) {
  for (const rule of rules) {
    if (conditionMatches(rule.conditionGroups, file, geocodePlace)) {
      return substitute(rule.destination, file);
    }
  }
  return null;
}

/** Every distinct place name referenced by "gps near" clauses, so the caller can resolve them all before evaluating any file. */
function placesReferencedBy(rules) {
  const places = new Set();
  for (const rule of rules) {
    for (const group of rule.conditionGroups) {
      for (const clause of group) {
        if (clause.op === 'near') places.add(clause.place);
      }
    }
  }
  return [...places];
}

// ---------------------------------------------------------------------------
// Storage, versioned in git when git is available
// ---------------------------------------------------------------------------

function isGitAvailable() {
  try {
    return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

function runGit(cwd, args) {
  try {
    return spawnSync('git', args, { cwd, encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

function readRulesText(library) {
  try {
    return fs.readFileSync(rulesPath(library), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Save the rules text — parsed first, so a broken rule is refused before
 * anything on disk changes — and, when git is available, commit it to a
 * small dedicated repo holding only this one file. A missing git, or a
 * commit that fails for any reason (nothing changed, no git identity
 * configured anywhere on the machine), never blocks the save itself:
 * history here is an audit trail worth having, not a requirement the
 * feature depends on.
 */
function saveRulesText(library, text, { message = 'Update sorting rules' } = {}) {
  const parsed = parse(text); // throws SortRulesError on the first problem

  const dir = rulesDir(library);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(rulesPath(library), text, 'utf8');

  if (isGitAvailable()) {
    if (!fs.existsSync(path.join(dir, '.git'))) {
      runGit(dir, ['init', '-q']);
      // Local to this one repo, never --global — this identity is LANShare's
      // own, not the person's, and must never touch their real git config.
      runGit(dir, ['config', 'user.email', 'lanshare@localhost']);
      runGit(dir, ['config', 'user.name', 'LANShare']);
    }
    runGit(dir, ['add', RULES_FILENAME]);
    runGit(dir, ['commit', '-q', '-m', message]);
  }

  return parsed;
}

/** Recent history of the rules file, newest first — [] if there is none yet, or no git. */
function ruleHistory(library, { limit = 50 } = {}) {
  const dir = rulesDir(library);
  if (!fs.existsSync(path.join(dir, '.git'))) return [];
  const result = spawnSync('git', ['log', `-${limit}`, '--format=%H%x1f%aI%x1f%s'], { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  return result.stdout.trim().split('\n').map((line) => {
    const [hash, date, subject] = line.split('\x1f');
    return { hash, date, subject };
  });
}

module.exports = {
  SortRulesError,
  FIELDS,
  PLACEHOLDERS,
  DEFAULT_NEAR_RADIUS_KM,
  parse,
  destinationFor,
  placesReferencedBy,
  isGitAvailable,
  readRulesText,
  saveRulesText,
  ruleHistory,
  rulesPath,
};
