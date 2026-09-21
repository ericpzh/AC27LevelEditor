// dev-start.mjs — npm start launcher that forwards to the vite dev server.
//
// Usage:
//   npm start                          # run from source (normal variant)
//   npm start steam [<workshop-path>]  # run from source as the Workshop variant
//   npm run dev                        # vite dev server only
//
// `steam` (alias `workshop`) forces the Workshop code path in dev by exporting
// AC27_WORKSHOP=1 (the packaged build detects it via a resources/workshop.json
// marker instead — see electron/updater.js:isWorkshopBuild). The optional path
// is the Workshop content dir (or the exe inside it); it is exported as
// AC27_WORKSHOP_DIR so the bundled AC27Approach.dll can be resolved without a
// packaged exe (see electron/main.js:resolveWorkshopBundledDllPath).
//
// No exe is built — vite compiles the Electron main/preload from JS and launches
// Electron against the dev server.
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { spawn } from 'child_process';
import path from 'path';

const require = createRequire(import.meta.url);

const rawArgs = process.argv.slice(2);

// Workshop mode: first positional token `steam`/`workshop`, optionally followed
// by the Workshop path. Everything else is forwarded to vite unchanged.
let workshop = process.env.AC27_WORKSHOP === '1';
let workshopDir = process.env.AC27_WORKSHOP_DIR || null;
let consumed = 0;
if (rawArgs[0] === 'steam' || rawArgs[0] === 'workshop') {
  workshop = true;
  consumed = 1;
  if (rawArgs[1] && !rawArgs[1].startsWith('-')) {
    workshopDir = rawArgs[1];
    consumed = 2;
  }
}
const rest = rawArgs.slice(consumed);

if (workshop) {
  process.env.AC27_WORKSHOP = '1';
  if (workshopDir) process.env.AC27_WORKSHOP_DIR = path.resolve(workshopDir);
  console.log(`[dev-start] Workshop variant${process.env.AC27_WORKSHOP_DIR ? ` (path: ${process.env.AC27_WORKSHOP_DIR})` : ' (no path — bundled DLL lookup will fall back)'}`);
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
