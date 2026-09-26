// ─── Aircraft 3D model pack (livery painter preview) ────────
// The painter's 3D preview renders the live livery on the game's real aircraft
// mesh. That mesh is the game's copyrighted geometry, so it is NOT shipped —
// it is extracted from the user's own install on demand, cached under
// <userData>/livery-3d-models/, and deleted when the painter closes.
//
// Primary extractor: electron/unity/aircraftPack.js — a pure-JS reader for the
// game's serialized files that runs in this process (no Python, no spawned
// binary, cross-platform by construction). scripts/extract-aircraft-models.py
// (UnityPy) is kept as a dev-time reference and a last-resort fallback for a
// game update that changes Unity's serialization.
//
// Pure-ish CommonJS: every Electron/`fs`-heavy call is injected or guarded so
// the module is unit-testable with mocked child_process/extractor.
//
// Pack layout (unchanged):
//   <cacheDir>/pack/manifest.json   { version, planes: { id: { bin, parts[] } } }
//   <cacheDir>/pack/<safe>.bin      concatenated f32 positions, f32 uvs, u32 indices

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
// The pack producer owns the cache-key version (single source of truth).
const { PACK_VERSION } = require('./unity/aircraftPack');

const CACHE_DIRNAME = 'livery-3d-models';
const PACK_DIRNAME = 'pack';
const SCRIPT_COPY_NAME = 'extract-aircraft-models.py';

function cacheDir(userData) {
  return path.join(userData, CACHE_DIRNAME);
}
function packDir(userData) {
  return path.join(cacheDir(userData), PACK_DIRNAME);
}
function manifestPath(userData) {
  return path.join(packDir(userData), 'manifest.json');
}

/** The extracted pack manifest, or null when absent/corrupt/wrong version. */
function readManifest(userData) {
  try {
    const raw = fs.readFileSync(manifestPath(userData), 'utf-8');
    const m = JSON.parse(raw);
    if (!m || m.version !== PACK_VERSION || !m.planes) return null;
    return m;
  } catch (_) {
    return null;
  }
}

/** True when a usable pack is already on disk. */
function isReady(userData) {
  return readManifest(userData) !== null;
}

/** Delete the cached pack (called when the painter exits). Best-effort. */
function cleanup(userData) {
  try {
    fs.rmSync(cacheDir(userData), { recursive: true, force: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Python candidates, in order. `py` is the Windows launcher and needs -3.
const PYTHON_CANDIDATES = [
  { cmd: 'python', args: [] },
  { cmd: 'python3', args: [] },
  { cmd: 'py', args: ['-3'] },
];

// Which interpreter has UnityPy + numpy importable, or null. Cached for the
// process (a missing interpreter won't appear mid-session).
let _pythonCache;
function findPython(spawnSyncImpl) {
  if (_pythonCache !== undefined) return _pythonCache;
  const run = spawnSyncImpl || spawnSync;
  for (const cand of PYTHON_CANDIDATES) {
    try {
      const res = run(cand.cmd, [...cand.args, '-c', 'import UnityPy, numpy'], {
        stdio: 'ignore',
        timeout: 30000,
        windowsHide: true,
      });
      if (res && res.status === 0) {
        _pythonCache = cand;
        return cand;
      }
    } catch (_) { /* try next */ }
  }
  _pythonCache = null;
  return null;
}

function _resetPythonCacheForTests() { _pythonCache = undefined; }

// In-flight extraction promise so a double click never runs two extractors.
let _inFlight = null;

/**
 * Ensure the pack exists for `gameRoot`, extracting it if needed.
 * @returns Promise<{success:boolean, cached?:boolean, error?:string, detail?:string}>
 */
function ensure(opts) {
  const { userData } = opts;
  if (isReady(userData)) return Promise.resolve({ success: true, cached: true });
  if (_inFlight) return _inFlight;
  _inFlight = _doExtract(opts).finally(() => { _inFlight = null; });
  return _inFlight;
}

function _log(onLog, s) { if (onLog) { try { onLog(s); } catch (_) {} } }

/** Drop a half-written pack so a failed attempt can't look "ready". */
function _discardPack(userData) {
  try { fs.rmSync(packDir(userData), { recursive: true, force: true }); } catch (_) {}
}

async function _doExtract({ userData, gameRoot, scriptPath, onLog, spawnImpl, findPythonImpl, extractImpl }) {
  const gamePaths = require('../src/utils/gamePaths');
  if (!gameRoot) return { success: false, error: 'NO_GAME_ROOT' };
  const dataRoot = gamePaths.resolveDataRoot(gameRoot);
  if (!dataRoot) return { success: false, error: 'NO_GAME_ROOT' };
  const assets = path.join(dataRoot, 'resources.assets');
  if (!fs.existsSync(assets)) return { success: false, error: 'NO_ASSETS' };

  const outDir = packDir(userData);
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (err) {
    return { success: false, error: 'CACHE_WRITE_FAILED', detail: err.message };
  }

  // 1. Pure-JS extractor (the normal path).
  let jsError = null;
  try {
    const extract = extractImpl || require('./unity/aircraftPack').extract;
    const result = await extract({ assetsPath: assets, outDir, onLog });
    if (result && result.planes > 0 && isReady(userData)) {
      return { success: true, cached: false };
    }
    jsError = new Error(`extractor produced ${result ? result.planes : 0} plane(s)`);
  } catch (err) {
    jsError = err;
  }
  _log(onLog, `[3d] JS extractor failed: ${jsError && jsError.message}\n`);
  _discardPack(userData);

  // 2. Python/UnityPy fallback (dev-time reference; needs a Python install).
  const python = (findPythonImpl || findPython)();
  if (!python) {
    return { success: false, error: 'NO_PYTHON', detail: String(jsError && jsError.message || jsError) };
  }
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    return { success: false, error: 'EXTRACT_FAILED', detail: 'python fallback script missing' };
  }

  // Copy the script out of app.asar (a spawned Python can't read asar paths).
  const scriptCopy = path.join(cacheDir(userData), SCRIPT_COPY_NAME);
  try {
    fs.mkdirSync(cacheDir(userData), { recursive: true });
    fs.copyFileSync(scriptPath, scriptCopy);
  } catch (err) {
    return { success: false, error: 'SCRIPT_MISSING', detail: err.message };
  }

  let log = '';
  const emit = (s) => { log += s; _log(onLog, s); };
  emit(`[3d] falling back to ${python.cmd} (UnityPy)...\n`);

  return new Promise((resolve) => {
    const spawnFn = spawnImpl || spawn;
    const child = spawnFn(python.cmd, [...python.args, scriptCopy, '--assets', assets, '--out', outDir], {
      windowsHide: true,
      env: process.env,
    });
    child.stdout.on('data', (d) => emit(d.toString()));
    child.stderr.on('data', (d) => emit(d.toString()));
    child.on('error', (err) => resolve({ success: false, error: 'SPAWN_FAILED', detail: String(err) }));
    child.on('close', (code) => {
      if (code === 0 && isReady(userData)) resolve({ success: true, cached: false });
      else resolve({ success: false, error: 'EXTRACT_FAILED', detail: log.slice(-4000) });
    });
  });
}

/** The manifest entry + raw binary for one plane, or an error. */
function readModel(userData, planeId) {
  const manifest = readManifest(userData);
  if (!manifest) return { success: false, error: 'NOT_READY' };
  const entry = manifest.planes[String(planeId)];
  if (!entry) return { success: false, error: 'NO_PLANE' };
  try {
    const bin = fs.readFileSync(path.join(packDir(userData), path.basename(entry.bin)));
    return { success: true, parts: entry.parts, bin };
  } catch (err) {
    return { success: false, error: 'BIN_MISSING', detail: err.message };
  }
}

module.exports = {
  CACHE_DIRNAME,
  PACK_DIRNAME,
  PACK_VERSION,
  cacheDir,
  packDir,
  manifestPath,
  readManifest,
  isReady,
  cleanup,
  findPython,
  ensure,
  readModel,
  _resetPythonCacheForTests,
};
