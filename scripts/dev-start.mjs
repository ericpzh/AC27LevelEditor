// dev-start.mjs — npm start launcher that forwards to the vite dev server.
//
// Usage:
//   npm start               # vite dev server
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { spawn } from 'child_process';
import path from 'path';

const require = createRequire(import.meta.url);

const rest = process.argv.slice(2);

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
