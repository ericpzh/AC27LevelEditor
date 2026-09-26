#!/usr/bin/env node
/**
 * compress-workshop-images.mjs — regenerate the Steam Workshop gallery images
 * (`workshop/images/*.jpg`) from the full-resolution README screenshots in
 * `public/*.png`.
 *
 * The source PNGs are flat UI screenshots, so rather than a fixed quality we
 * binary-search the highest JPEG quality whose output stays under a size cap
 * (~1.9 MB) — best quality without an oversize upload. Images that are already
 * comfortably under the cap at quality 100 are simply written at 100.
 *
 * Usage:
 *   node scripts/compress-workshop-images.mjs [--target-mb 1.9]
 *
 * Requires the `sharp` dev dependency.
 */

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'public');
const OUT_DIR = path.join(ROOT, 'workshop', 'images');

// The 7 screenshots the README embeds (and the Workshop gallery mirrors).
const IMAGES = ['Screen', 'Radar', 'Main', 'Livery1', 'Livery2', 'Painter1', 'Painter2'];

const targetArg = process.argv.indexOf('--target-mb');
const TARGET_MB = targetArg >= 0 ? Number(process.argv[targetArg + 1]) : 1.9;
const TARGET_BYTES = Math.round(TARGET_MB * 1024 * 1024);

const mb = (n) => (n / 1024 / 1024).toFixed(2);

/** Encode `src` as a JPEG at `quality` (mozjpeg, 4:4:4 for crisp UI text). */
function encode(src, quality) {
  return sharp(src)
    .jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

/** Highest quality whose encoded size is <= TARGET_BYTES. */
async function bestUnderCap(src) {
  let lo = 1;
  let hi = 100;
  let best = null;
  while (lo <= hi) {
    const q = (lo + hi) >> 1;
    const buf = await encode(src, q);
    if (buf.length <= TARGET_BYTES) {
      best = { quality: q, buf };
      lo = q + 1;
    } else {
      hi = q - 1;
    }
  }
  if (!best) best = { quality: 1, buf: await encode(src, 1) };
  return best;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`target: <= ${TARGET_MB} MB (${TARGET_BYTES} bytes)\n`);

  for (const name of IMAGES) {
    const src = path.join(SRC_DIR, `${name}.png`);
    if (!fs.existsSync(src)) {
      console.error(`  MISSING ${src}`);
      process.exitCode = 1;
      continue;
    }
    const { quality, buf } = await bestUnderCap(src);
    const out = path.join(OUT_DIR, `${name}.jpg`);
    fs.writeFileSync(out, buf);
    const meta = await sharp(buf).metadata();
    console.log(`  ${name.padEnd(9)} q${String(quality).padStart(3)}  ${mb(buf.length).padStart(5)} MB  ${meta.width}x${meta.height}  -> ${path.relative(ROOT, out)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
