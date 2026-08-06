// dev-start.mjs — npm start launcher that forwards to the vite dev server.
//
// Usage:
//   npm start               # vite dev server (small vosk models)
//   npm start -- --large    # same, but LARGE vosk models for internal testing
//   npm run start:large     # same as above (avoids the npm `--` quirk)
//
// NOTE: `npm start --large` (without `--`) does NOT reach this script — npm
// 11 treats flags before `--` as its own config and swallows them with
// `npm warn Unknown cli config "--large"`. Use `npm start -- --large`.
//
// --large is dev-only: it selects vosk-model-en-us-0.22 / vosk-model-cn-0.22
// (fetch with `node scripts/fetch-vosk-model.mjs --large`). The large models
// are never bundled into builds (see build.js) — this flag only sets the
// VOSK_USE_LARGE env var that the voice worker reads, then strips itself so
// vite never sees an unknown flag (vite's CLI rejects unknown options).
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { spawn } from 'child_process';
import path from 'path';

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const large = args.includes('--large');
const rest = args.filter((a) => a !== '--large');

if (large) {
  process.env.VOSK_USE_LARGE = '1';
  console.log('[dev-start] LARGE vosk models enabled (dev-only)');
}

// vite's exports map blocks ./bin/vite.js — resolve the exported package.json
// and take the bin field instead.
let viteBin;
try {
  const pkgPath = require.resolve('vite/package.json');
  viteBin = path.join(path.dirname(pkgPath), JSON.parse(readFileSync(pkgPath, 'utf8')).bin.vite);
} catch {
  console.error('[dev-start] vite not found — run `npm install` first');
  process.exit(1);
}

// stdio: 'inherit' keeps vite on the same console group, so Ctrl+C reaches
// it directly; the close handler just mirrors its exit code.
const child = spawn(process.execPath, [viteBin, ...rest], { stdio: 'inherit' });
child.on('error', (err) => {
  console.error(`[dev-start] failed to start vite: ${err.message}`);
  process.exit(1);
});
child.on('close', (code) => process.exit(code ?? 1));
