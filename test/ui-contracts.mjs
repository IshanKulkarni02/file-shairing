/**
 * The quiet contracts between each UI's HTML, CSS and JS.
 *
 * Neither front end has rendering tests — the route suites prove the server,
 * and nothing proves the pages. Two specific ways that has actually broken
 * are cheap to check statically, and both produce the same baffling symptom:
 * a button that looks fine and does nothing.
 *
 *   1. Every element the JS looks up by id must exist in the HTML. $('x') on
 *      a missing element returns null, and `null.addEventListener` throws at
 *      load — which kills every listener registered *after* it in the file.
 *      One typo silently disables half a screen.
 *
 *   2. [hidden] must actually win. The browser's own [hidden] rule is
 *      user-agent origin, so any author rule setting display outranks it
 *      whatever its specificity. Both stylesheets set display on things they
 *      also hide (.setup, .btn), so without an explicit !important rule,
 *      "hide this" silently does nothing. This shipped in the desktop app:
 *      the capture overlay's Cancel, Never, Try again and Close buttons all
 *      ran their code and then failed to make the overlay go away.
 *
 *   node test/ui-contracts.mjs
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

const UIS = [
  { name: 'desktop app', html: 'desktop/ui/index.html', js: 'desktop/ui/app.js', css: 'desktop/ui/style.css' },
  { name: 'web gallery', html: 'public/index.html', js: 'public/app.js', css: 'public/style.css' },
];

for (const ui of UIS) {
  const html = readFileSync(path.join(root, ui.html), 'utf8');
  const js = readFileSync(path.join(root, ui.js), 'utf8');
  const css = readFileSync(path.join(root, ui.css), 'utf8');

  // --- 1. every id the JS reaches for exists somewhere ---------------------
  // Some rows are built at runtime (the Undo button on the rules screen is
  // written into an innerHTML template), so ids declared inside the JS count
  // as declared too. What this still catches is the case that matters: a
  // reference to an id that exists in neither place, i.e. a typo or a
  // rename that missed one side.

  const idsIn = (text) => [...text.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const declared = new Set([...idsIn(html), ...idsIn(js)]);
  // $('someId') — the single accessor both files use.
  const referenced = [...js.matchAll(/\$\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  const missing = [...new Set(referenced)].filter((id) => !declared.has(id));

  check(`${ui.name}: every id the JS looks up is declared somewhere`,
    missing.length === 0, missing.join(', '));

  // --- 2. no id declared twice, so $() cannot pick the wrong one -----------

  const idCounts = new Map();
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) {
    idCounts.set(m[1], (idCounts.get(m[1]) || 0) + 1);
  }
  const duplicated = [...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  check(`${ui.name}: no id is declared more than once`, duplicated.length === 0, duplicated.join(', '));

  // --- 3. [hidden] actually beats the author display rules ----------------

  const hasHiddenRule = /\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/s.test(css);
  check(`${ui.name}: [hidden] is enforced with !important so hiding works`, hasHiddenRule);

  // The rule above is only load-bearing because these set display themselves.
  // If that ever stops being true the rule is harmless; this just records why
  // it is there, so nobody removes it as redundant.
  const setsDisplay = /\.(setup|btn)\s*[,{][^}]*display:/s.test(css);
  check(`${ui.name}: (and is genuinely needed — .setup/.btn set display)`, setsDisplay || !hasHiddenRule);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
