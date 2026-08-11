'use strict';

/**
 * Cut a release: test, bump, tag, build.
 *
 *   npm run release -- patch      1.1.0 -> 1.1.1
 *   npm run release -- minor      1.1.0 -> 1.2.0
 *   npm run release -- 1.4.2      an exact version
 *
 * Versions exist because every build was 1.0.0, which made an installed copy
 * and a fresh one indistinguishable — and a stale install then looked exactly
 * like a broken new one. A tag per release, an installer named after it, and
 * the version visible in the app all answer the same question: is this the
 * one I just built?
 *
 * The tests run first and a failure stops everything. Tagging a release
 * nobody verified is how a broken build gets a version number that makes it
 * look deliberate.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkgPath = path.join(ROOT, 'package.json');

function run(command, args, options = {}) {
  const res = spawnSync(command, args, {
    cwd: ROOT,
    stdio: options.quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0 && !options.allowFailure) {
    console.error(`\n  Failed: ${command} ${args.join(' ')}`);
    process.exit(res.status || 1);
  }
  return res;
}

function main() {
  const bump = process.argv[2];
  if (!bump) {
    console.error('Usage: npm run release -- <patch|minor|major|x.y.z>');
    process.exit(2);
  }

  // A release must come from a clean tree, or the tag points at something
  // that never existed anywhere else.
  const dirty = run('git', ['status', '--porcelain'], { quiet: true }).stdout.trim();
  if (dirty) {
    console.error('\n  There are uncommitted changes. Commit or stash them first:\n');
    console.error(dirty);
    process.exit(1);
  }

  console.log('\n  Running the tests before anything else...\n');
  run(process.execPath, [path.join(ROOT, 'test', 'run-all.mjs')]);

  const before = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  console.log(`\n  Bumping from ${before}...\n`);

  // npm version writes package.json, commits and tags — all three, so the tag
  // can never disagree with what is in the file.
  run('npm', ['version', bump, '-m', 'Release v%s']);

  const after = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  console.log(`\n  Building the installer for ${after}...\n`);
  run(process.execPath, [path.join(ROOT, 'desktop-build.js')]);

  console.log(`\n  Released ${after} locally. To publish it:\n`);
  console.log('    git push && git push --tags\n');
  console.log('  The tag then appears on GitHub under Releases -> Tags. To attach');
  console.log('  the installer as a downloadable release (needs `gh auth login`):\n');
  console.log(`    gh release create v${after} "dist-desktop/LANShare-Installer-${after}.exe" \\`);
  console.log(`      --title "LANShare v${after}" --notes-file CHANGELOG.md\n`);
}

main();
