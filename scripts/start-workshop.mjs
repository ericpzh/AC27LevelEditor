// start-workshop.mjs — build + launch the Steam Workshop build (the Steam release),
// attached to this console like `npm start` (build output and app logs stream here).
//
// Usage:
//   npm run start:workshop                                 # vite build + package workshop exe + launch it
//   npm run start:workshop -- --no-build                   # skip the build, just launch the existing exe
//   npm run start:workshop -- --exe <path>                 # launch a different exe (e.g. the Steam-installed copy); skips the build
//   npm run start:workshop -- --exe <workshop-content-dir> # dir also works: AC27EditorWorkshop.exe (or AC27Editor.exe) inside it is used
//   AC27_WORKSHOP_EXE=<path> npm run start:workshop       # same via env var
//   npm run start:workshop -- --arg                        # extra args are forwarded to the exe
//
// The packaged workshop build has auto-update disabled (Steam Workshop handles updates).
import { spawnSync, spawn } from 'child_process';
import { existsSync, statSync } from 'fs';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultExe = path.join(root, 'release', 'AC27EditorWorkshop.exe');

const rawArgs = process.argv.slice(2);
let exeOverride = process.env.AC27_WORKSHOP_EXE || null;
let noBuild = false;
const fwdArgs = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === '--exe' && i + 1 < rawArgs.length) {
    exeOverride = rawArgs[++i];
  } else if (a.startsWith('--exe=')) {
    exeOverride = a.slice('--exe='.length);
  } else if (a === '--no-build') {
    noBuild = true;
  } else {
    fwdArgs.push(a);
  }
}

function runStep(label, cmd, args) {
  console.log(`[start:workshop] ${label}: ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (res.error || res.status !== 0) {
    console.error(`[start:workshop] ${label} failed (exit ${res.status ?? '?'})`);
    process.exit(res.status || 1);
  }
}

// A Workshop content dir (e.g. .../workshop/content/3328490/3793213548) holds
// the exe — resolve it when given a directory.
function resolveExe(p) {
  if (!p) return defaultExe;
  const abs = path.isAbsolute(p) ? p : path.join(root, p);
  try {
    if (statSync(abs).isDirectory()) {
      for (const name of ['AC27EditorWorkshop.exe', 'AC27Editor.exe']) {
        const inner = path.join(abs, name);
        if (existsSync(inner)) return inner;
      }
    }
  } catch { /* not a dir — treat as file path below */ }
  return abs;
}

// A custom --exe points at an already-built copy (e.g. the Steam install),
// so there is nothing to build — same for --no-build.
if (!exeOverride && !noBuild) {
  let viteBin;
  try {
    const pkgPath = require.resolve('vite/package.json');
    viteBin = path.join(path.dirname(pkgPath), JSON.parse(readFileSync(pkgPath, 'utf8')).bin.vite);
  } catch {
    console.error('[start:workshop] vite not found — run `npm install` first');
    process.exit(1);
  }
  runStep('build', process.execPath, [viteBin, 'build']);
  runStep('package', process.execPath, [path.join(root, 'build.js'), '--win', '--workshop']);
}

const exe = resolveExe(exeOverride);

if (!existsSync(exe)) {
  console.error(`[start:workshop] not found: ${exe}`);
  if (!exeOverride && !noBuild) console.error('[start:workshop] packaging did not produce the exe — see build output above');
  else if (!exeOverride) console.error('[start:workshop] run without --no-build to build it first');
  else console.error('[start:workshop] check --exe / AC27_WORKSHOP_EXE (exe file or Workshop content dir)');
  process.exit(1);
}

// Attached (not detached): app stdout/stderr stream into this console and
// Ctrl+C reaches the app, mirroring `npm start` (see scripts/dev-start.mjs).
console.log(`[start:workshop] launching: ${exe}`);
const child = spawn(exe, fwdArgs, { stdio: 'inherit' });
child.on('error', (err) => {
  console.error(`[start:workshop] failed to launch: ${err.message}`);
  process.exit(1);
});
child.on('close', (code) => process.exit(code ?? 1));
