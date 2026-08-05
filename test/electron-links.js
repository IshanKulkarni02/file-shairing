'use strict';

/**
 * Link handling under Electron rather than plain Node.
 *
 *   npx electron test/electron-links.js
 *
 * This exists because of a bug that every Node-hosted test passed happily:
 * fs.rmSync on a Windows junction works under Node and throws EISDIR under
 * Electron, whose asar shim stats through the link. The desktop app is the
 * only place this code runs, so it is the only place worth asserting it.
 *
 * Kept out of the main suite deliberately — it needs an Electron runtime,
 * not a Node one.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const locations = require('../lib/locations.js');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

function scratch() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lanshare-links-'));
  const real = path.join(base, 'elsewhere');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'keep.txt'), 'must survive');
  return { base, real, link: path.join(base, 'album') };
}

async function run() {
  console.log(`  Electron ${process.versions.electron}, Node ${process.versions.node}\n`);

  // --- a link can be made and taken away, in this runtime --------------------

  {
    const { base, real, link } = scratch();
    locations.createLink(link, real);
    check('a link is created', fs.existsSync(path.join(link, 'keep.txt')));
    check('and reads as a link, not a folder', locations.isLink(link));

    let error = null;
    try { locations.removeLink(link); } catch (err) { error = err; }
    check('removing it does not throw', error === null, error && `${error.code || ''} ${error.message}`);
    check('the link is gone', !fs.existsSync(link));
    check('and what it pointed at is untouched', fs.existsSync(path.join(real, 'keep.txt')));
    fs.rmSync(base, { recursive: true, force: true });
  }

  // --- the guard that stops it deleting a real album -------------------------

  {
    const { base, real } = scratch();
    let refused = false;
    try { locations.removeLink(real); } catch { refused = true; }
    check('it refuses to remove a real folder', refused);
    check('leaving that folder intact', fs.existsSync(path.join(real, 'keep.txt')));
    fs.rmSync(base, { recursive: true, force: true });
  }

  // --- a full round trip through the two operations the UI offers ------------

  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lanshare-links-'));
    const library = path.join(base, 'library');
    const drive = path.join(base, 'drive');
    fs.mkdirSync(path.join(library, 'Album'), { recursive: true });
    fs.mkdirSync(drive);
    fs.writeFileSync(path.join(library, 'Album', 'photo.txt'), 'the only copy');

    const config = {};
    const added = locations.add(config, { label: 'Test', targetPath: drive });

    await locations.relocateAlbum(library, config, 'Album', added.id);
    check('an album relocates under Electron',
      fs.existsSync(path.join(drive, 'Album', 'photo.txt')));
    check('and is reachable on its old path',
      fs.readFileSync(path.join(library, 'Album', 'photo.txt'), 'utf8') === 'the only copy');

    await locations.bringAlbumHome(library, config, 'Album');
    check('and comes back under Electron', !locations.isLink(path.join(library, 'Album')));
    check('with its contents intact',
      fs.readFileSync(path.join(library, 'Album', 'photo.txt'), 'utf8') === 'the only copy');
    check('and nothing left behind on the drive', !fs.existsSync(path.join(drive, 'Album')));

    fs.rmSync(base, { recursive: true, force: true });
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  app.exit(fail ? 1 : 0);
}

app.whenReady().then(run).catch((err) => {
  console.log(`  FAIL  unexpected error -> ${err.stack || err.message}`);
  app.exit(1);
});
