/**
 * Sorting rules over the HTTP API: saving, a dry-run plan, applying it for
 * real against uploaded files, and undoing the whole batch — plus that
 * every one of these routes is admin-only.
 *
 *   node test/sort-rules-routes.mjs <adminPassword> [baseUrl]
 */

const ADMIN_PASSWORD = process.argv[2];
const BASE = process.argv[3] || 'http://127.0.0.1:8420';

if (!ADMIN_PASSWORD) {
  console.error('Usage: node test/sort-rules-routes.mjs <adminPassword> [baseUrl]');
  process.exit(2);
}

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

function client() {
  let cookie = '';
  return async (path, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(BASE + path, { ...options, headers, redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return res;
  };
}

const json = (body) => ({
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const login = (req, username, password) => req('/api/login', json({ username, password }));
const q = encodeURIComponent;

async function uploadFile(req, dir, name, buffer) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), name);
  return req(`/api/upload?dir=${q(dir)}&rel=${q(name)}`, { method: 'POST', body: form });
}

async function waitForIdle(req, deadlineMs = 30000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const body = await (await req('/api/index/status')).json();
    if (!body.scanning) return body;
    if (Date.now() > deadline) throw new Error('index scan did not finish in time');
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function rebuildAndWait(req) {
  let body = await (await req('/api/index/rebuild', { method: 'POST' })).json();
  if (body.alreadyRunning) {
    await waitForIdle(req);
    await req('/api/index/rebuild', { method: 'POST' });
  }
  await waitForIdle(req);
}

const RUN = Date.now().toString(36);
const TOKEN = `zzrules${RUN}`;
const INBOX = `/Inbox-${RUN}`;
const admin = client();
const accountsCreated = [];
const albumsCreated = [];

try {
  let res = await login(admin, 'admin', ADMIN_PASSWORD);
  check('admin signs in', res.status === 200, `got ${res.status}`);

  // --- reading and writing the rules -----------------------------------------

  res = await admin('/api/sort-rules');
  let body = await res.json();
  check('reading rules before any have ever been saved succeeds with empty text',
    res.status === 200 && body.text === '', JSON.stringify(body));

  res = await admin('/api/sort-rules', json({ text: 'this is not a valid rule', message: 'bad' }));
  check('saving an invalid rule set is refused with a 400', res.status === 400, `got ${res.status}`);

  const ruleText = `when kind = image -> ${INBOX}/Sorted`;
  res = await admin('/api/sort-rules', json({ text: ruleText, message: `rules for ${RUN}` }));
  body = await res.json();
  check('saving a valid rule set succeeds', res.status === 200 && body.ruleCount === 1, JSON.stringify(body));

  res = await admin('/api/sort-rules');
  body = await res.json();
  check('the saved rules read back exactly', body.text === ruleText, JSON.stringify(body));
  check('a version is reported, for optimistic concurrency', typeof body.version === 'string' && body.version.length > 0,
    JSON.stringify(body));
  check('git history is reported when git is available',
    !body.gitAvailable || body.history.some((h) => h.subject === `rules for ${RUN}`), JSON.stringify(body));

  // --- concurrent editors cannot silently erase each other's work -----------
  // Two admin tabs both load the current rules, both edit, both save. Without
  // a version check the second save used to overwrite the first and report
  // success — a real, live bug, not a hypothetical for this phase.

  {
    const staleVersion = body.version;
    res = await admin('/api/sort-rules', json({ text: `${ruleText}\nwhen kind = video -> ${INBOX}/Videos` }));
    const firstBody = await res.json();
    check('the first editor\'s save succeeds', res.status === 200, JSON.stringify(firstBody));

    res = await admin('/api/sort-rules', json({
      text: `${ruleText}\nwhen kind = audio -> ${INBOX}/Audio`, version: staleVersion,
    }));
    body = await res.json();
    check('a save against the now-stale version is refused with 409, not silently applied',
      res.status === 409, `got ${res.status}`);
    check('the conflict response carries the current text to reconcile against',
      typeof body.currentText === 'string' && body.currentText.includes('Videos'), JSON.stringify(body));
    check('the conflict response carries a fresh version to retry with',
      typeof body.currentVersion === 'string' && body.currentVersion !== staleVersion, JSON.stringify(body));

    res = await admin('/api/sort-rules');
    body = await res.json();
    check('the first editor\'s save is still on disk, untouched by the refused second save',
      body.text.includes('Videos') && !body.text.includes('Audio'), JSON.stringify(body));

    // Retrying via the If-Match header (the other accepted spelling, besides
    // a `version` field in the body) against the fresh version succeeds.
    res = await admin('/api/sort-rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'If-Match': `"${body.version}"` },
      body: JSON.stringify({ text: ruleText }),
    });
    check('retrying with the fresh version via If-Match succeeds', res.status === 200, `got ${res.status}`);
  }

  // --- a real dry run and a real apply ----------------------------------------

  await admin('/api/mkdir', json({ path: '/', name: `Inbox-${RUN}` }));
  albumsCreated.push(INBOX, `${INBOX}/Sorted`);
  res = await uploadFile(admin, INBOX, `${TOKEN}.jpg`, Buffer.from(`bytes ${RUN}`));
  check('uploaded a file that should match the rule', res.status === 200, `got ${res.status}`);
  await rebuildAndWait(admin);

  res = await admin('/api/sort-rules/plan');
  body = await res.json();
  const planned = body.moves?.find((m) => m.path === `${INBOX}/${TOKEN}.jpg`);
  check('the dry-run plan finds the upload and would move it to the rule\'s destination',
    Boolean(planned) && planned.destinationAlbum === `${INBOX}/Sorted`, JSON.stringify(body));
  check('the dry run does not move anything by itself',
    (await (await admin(`/api/list?path=${q(INBOX)}`)).json()).files?.some((f) => f.name === `${TOKEN}.jpg`));

  res = await admin('/api/sort-rules/apply', { method: 'POST' });
  body = await res.json();
  check('applying moves the matched file and reports it in the batch',
    res.status === 200 && body.moved?.some((m) => m.from === `${INBOX}/${TOKEN}.jpg`), JSON.stringify(body));

  res = await admin(`/api/list?path=${q(INBOX)}/Sorted`);
  body = await res.json();
  check('the file now genuinely exists at its sorted destination',
    body.files?.some((f) => f.name === `${TOKEN}.jpg`), JSON.stringify(body));
  res = await admin(`/api/list?path=${q(INBOX)}`);
  body = await res.json();
  check('and is gone from where it started', !body.files?.some((f) => f.name === `${TOKEN}.jpg`), JSON.stringify(body));

  // --- batches and undo --------------------------------------------------------

  res = await admin('/api/sort-rules/batches');
  body = await res.json();
  check('the applied batch shows up in the batch list', body.batches?.[0]?.moved?.some((m) => m.from === `${INBOX}/${TOKEN}.jpg`), JSON.stringify(body));

  res = await admin('/api/sort-rules/undo', { method: 'POST' });
  body = await res.json();
  check('undo restores the file', res.status === 200 && body.restored?.includes(`${INBOX}/${TOKEN}.jpg`), JSON.stringify(body));

  res = await admin(`/api/list?path=${q(INBOX)}`);
  body = await res.json();
  check('the file is genuinely back where it started after undo',
    body.files?.some((f) => f.name === `${TOKEN}.jpg`), JSON.stringify(body));

  // --- natural-language drafting (Phase M) ------------------------------------
  // No real local model is expected to be running wherever this suite runs, so
  // what is actually proven is that the route correctly reports that honestly
  // rather than hanging or crashing — the same boundary test/nl-rules.mjs draws
  // around lib/nl-rules.js itself, one layer up.

  res = await admin('/api/sort-rules/draft', json({ instruction: 'keep drone shots in /Drone' }));
  body = await res.json();
  check('drafting without a local model available fails clearly rather than hanging or crashing',
    res.status === 400 && typeof body.error === 'string', JSON.stringify(body));

  res = await admin('/api/sort-rules/draft', json({ instruction: '   ' }));
  check('drafting from a blank instruction is refused', res.status === 400, `got ${res.status}`);

  // run-once needs no model at all — it takes rule text directly, exactly
  // like a draft that has already been reviewed and (if needed) hand-edited.
  res = await uploadFile(admin, INBOX, `${TOKEN}-once.jpg`, Buffer.from(`once ${RUN}`));
  await rebuildAndWait(admin);

  res = await admin('/api/sort-rules/run-once', json({ text: `when kind = image -> ${INBOX}/RunOnce` }));
  body = await res.json();
  check('run-once applies a rule that was never saved', res.status === 200
    && body.moved?.some((m) => m.from === `${INBOX}/${TOKEN}-once.jpg`), JSON.stringify(body));

  res = await admin('/api/sort-rules');
  body = await res.json();
  check('run-once never touched the saved rules file', body.text === ruleText, JSON.stringify(body));

  res = await admin(`/api/list?path=${q(INBOX)}/RunOnce`);
  body = await res.json();
  check('the file genuinely moved to the one-off destination',
    body.files?.some((f) => f.name === `${TOKEN}-once.jpg`), JSON.stringify(body));

  res = await admin('/api/sort-rules/undo', { method: 'POST' });
  check('a run-once batch is undoable exactly like a saved rule\'s apply', res.status === 200, `got ${res.status}`);

  res = await admin('/api/sort-rules/run-once', json({ text: 'not a valid rule at all' }));
  check('run-once refuses text that does not parse', res.status === 400, `got ${res.status}`);

  // --- admin-only, every route ------------------------------------------------

  await admin('/api/accounts', json({ username: `viewer-${RUN}`, password: 'Testpass123', role: 'viewer', roots: ['/'] }));
  accountsCreated.push(`viewer-${RUN}`);
  const viewer = client();
  await login(viewer, `viewer-${RUN}`, 'Testpass123');

  for (const [method, path] of [
    ['GET', '/api/sort-rules'],
    ['POST', '/api/sort-rules'],
    ['GET', '/api/sort-rules/plan'],
    ['POST', '/api/sort-rules/apply'],
    ['GET', '/api/sort-rules/batches'],
    ['POST', '/api/sort-rules/undo'],
    ['POST', '/api/sort-rules/draft'],
    ['POST', '/api/sort-rules/run-once'],
  ]) {
    res = await viewer(path, method === 'POST' ? json({ text: 'when kind = image -> /X', instruction: 'x' }) : {});
    check(`a non-admin is refused on ${method} ${path}`, res.status === 403, `got ${res.status}`);
  }
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error during the test run -> ${err.stack || err.message}`);
} finally {
  for (const username of accountsCreated) {
    await admin(`/api/accounts/${encodeURIComponent(username)}`, { method: 'DELETE' }).catch(() => {});
  }
  await admin('/api/delete', json({ paths: [INBOX] })).catch(() => {});
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
