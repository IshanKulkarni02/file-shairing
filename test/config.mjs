/**
 * lib/config.js's own version-checked save — the same optimistic-
 * concurrency shape lib/sort-rules.js already has for the rules file,
 * needed now that lib/trust.js writes trust-state into config.json from
 * more than one place (a person via a route, a background Discovery pass).
 *
 * LANSHARE_HOME is set before config.js is ever required, exactly like
 * test/migration.mjs, so this never touches the real installation and
 * config.js's module-scope ROOT_DIR/CONFIG_PATH point at a scratch dir for
 * this whole process.
 *
 *   node test/config.mjs
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const home = mkdtempSync(path.join(tmpdir(), 'lanshare-config-'));
process.env.LANSHARE_HOME = home;

const configLib = require(path.join(here, '..', 'lib', 'config.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

try {
  check('a fresh config.json defaults to an empty trust map',
    configLib.loadOrCreate().config.trust !== undefined
    && Object.keys(configLib.loadOrCreate().config.trust).length === 0);

  check('configVersion is stable across repeated reads with nothing changed',
    configLib.configVersion() === configLib.configVersion());

  const { config } = configLib.loadOrCreate();
  const v1 = configLib.configVersion();

  const withTrust = { ...config, trust: { trip_cluster: 'ghost' } };
  configLib.save(withTrust, { expectedVersion: v1 });
  const v2 = configLib.configVersion();
  check('a save against the correct version succeeds and changes the version',
    v2 !== v1, `${v1} -> ${v2}`);
  check('the change actually persisted to disk',
    JSON.parse(readFileSync(configLib.CONFIG_PATH, 'utf8')).trust.trip_cluster === 'ghost');

  check('saving again against the now-stale v1 is refused, not silently applied',
    (() => {
      try { configLib.save({ ...withTrust, trust: { trip_cluster: 'auto' } }, { expectedVersion: v1 }); return false; } catch (err) {
        return err instanceof configLib.ConfigConflictError;
      }
    })());

  check('the refused save left the on-disk value untouched',
    JSON.parse(readFileSync(configLib.CONFIG_PATH, 'utf8')).trust.trip_cluster === 'ghost');

  let conflictErr = null;
  try {
    configLib.save({ ...withTrust, trust: { trip_cluster: 'auto' } }, { expectedVersion: v1 });
  } catch (err) {
    conflictErr = err;
  }
  check('the conflict error carries the current config to reconcile against',
    conflictErr?.currentConfig?.trust?.trip_cluster === 'ghost', JSON.stringify(conflictErr?.currentConfig?.trust));
  check('and a fresh version to retry with',
    typeof conflictErr?.currentVersion === 'string' && conflictErr.currentVersion === v2);

  configLib.save({ ...withTrust, trust: { trip_cluster: 'auto' } }, { expectedVersion: v2 });
  check('retrying with the fresh version succeeds',
    JSON.parse(readFileSync(configLib.CONFIG_PATH, 'utf8')).trust.trip_cluster === 'auto');

  check('a save with no expectedVersion at all still overwrites, exactly as before',
    (() => {
      configLib.save({ ...withTrust, trust: { trip_cluster: 'ask' } });
      return JSON.parse(readFileSync(configLib.CONFIG_PATH, 'utf8')).trust.trip_cluster === 'ask';
    })());
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error during the test run -> ${err.stack || err.message}`);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
