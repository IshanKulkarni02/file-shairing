'use strict';

/**
 * Render the PWA icon set from public/icon.svg.
 *   node tools/make-icons.js
 *
 * Maskable variants get extra padding: Android crops a maskable icon to
 * whatever shape the launcher uses, and without the safe zone the artwork
 * loses its edges.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const publicDir = path.join(__dirname, '..', 'public');
const source = path.join(publicDir, 'icon.svg');
const outDir = path.join(publicDir, 'icons');

const BACKGROUND = { r: 174, g: 226, b: 246, alpha: 1 }; // --sky

async function render(size, name, { maskable = false } = {}) {
  // Maskable icons keep the artwork inside the middle 80%, which is the
  // safe zone every launcher shape is guaranteed to show.
  const artSize = maskable ? Math.round(size * 0.78) : size;
  const pad = Math.round((size - artSize) / 2);

  const art = await sharp(source, { density: 384 })
    .resize(artSize, artSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const canvas = sharp({
    create: {
      width: size, height: size, channels: 4,
      background: maskable ? BACKGROUND : { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });

  await canvas
    .composite([{ input: art, top: pad, left: pad }])
    .png({ compressionLevel: 9 })
    .toFile(path.join(outDir, name));

  console.log(`  ${name}  ${size}x${size}${maskable ? '  (maskable)' : ''}`);
}

async function main() {
  if (!fs.existsSync(source)) {
    console.error(`  Missing ${source}`);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  await render(192, 'icon-192.png');
  await render(512, 'icon-512.png');
  await render(192, 'maskable-192.png', { maskable: true });
  await render(512, 'maskable-512.png', { maskable: true });
  // iOS ignores the manifest and uses this one. It never applies a mask or a
  // background, so it must be opaque and edge-to-edge.
  await render(180, 'apple-touch-icon.png', { maskable: true });

  console.log(`\n  Icons written to ${outDir}\n`);
}

main().catch((err) => {
  console.error(`  Icon generation failed: ${err.message}`);
  process.exit(1);
});
