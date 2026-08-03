/**
 * Generate sample media under <library>/Samples for test/media.mjs.
 * Needs ffmpeg on PATH.
 *
 *   node test/make-samples.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const config = require(path.join(here, '..', 'lib', 'config.js'));

const loaded = config.load();
const library = loaded?.library || path.join(here, '..', 'library');
const outDir = path.join(library, 'Samples');
mkdirSync(outDir, { recursive: true });

const jobs = [
  {
    name: 'photo-portrait.jpg',
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=1600x2000', '-frames:v', '1'],
  },
  {
    name: 'photo-landscape.png',
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=2400x1600', '-frames:v', '1'],
  },
  {
    // Plays directly in every browser.
    name: 'clip-h264.mp4',
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=duration=6:size=1280x720:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    ],
  },
  {
    // What an iPhone actually records: HEVC in a .mov. Safari plays it,
    // Chrome and Firefox do not, so this is what exercises the transcoder.
    name: 'clip-hevc.mov',
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=duration=6:size=1280x720:rate=30',
      '-c:v', 'libx265', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p',
    ],
  },
];

for (const job of jobs) {
  const target = path.join(outDir, job.name);
  const res = spawnSync('ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', ...job.args, target],
    { stdio: 'inherit' });
  if (res.error || res.status !== 0) {
    console.error(`  failed: ${job.name}`);
    process.exit(1);
  }
  console.log(`  wrote ${path.relative(library, target)}`);
}

console.log(`\n  Samples written to ${outDir}\n`);
