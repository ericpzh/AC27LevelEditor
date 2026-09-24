// ─── gamePaths — cross-platform resolution of the AC27 game folder layout ───
//
// The game's data tree is IDENTICAL on every OS *inside* the data root, but the
// data root itself moves:
//
//   Windows / Linux : <gameRoot>/GroundATC_Data/StreamingAssets
//   macOS           : <gameRoot>/GroundATC.app/Contents/Resources/Data/StreamingAssets
//                     (or <app>/Contents/Resources/Data/... when the user
//                      picked the .app bundle itself)
//
// Every caller that used to `path.join(gameRoot, 'GroundATC_Data',
// 'StreamingAssets', ...)` MUST go through the accessors here. They probe with
// `resolveDataRoot()` and fall back to the Windows/Linux guess so a missing
// install still yields a sensible path for error messages.
//
// Steam also installs the game under different library roots per OS; see
// `steamCommonDirs()` (used by main.js game-root auto-detection).
//
// Plain CommonJS + node fs/path/os only — safe to require from electron/ and
// src/acl/ (bundled by vite) and from plain-node tests.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SEG = Object.freeze({
  dataDir: 'GroundATC_Data',
  streaming: 'StreamingAssets',
  airports: 'Airports',
  levels: 'Levels',
  voices: 'Voices',
  videos: 'MainMenuVideos',
  builtinLivery: 'BuiltInAircraftLivery',
  aircraftDefaultLivery: 'AircraftDefaultLivery',
  mods: 'Mods',
  aircraftProfilesCsv: 'aircraft_profiles.csv',
  voiceCatalog: 'voice_catalog.json',
  appBundle: 'GroundATC.app',
});

// How deep to descend below a candidate root looking for `StreamingAssets`.
// macOS reaches app(1)/Contents(2)/Resources(3)/Data(4)/StreamingAssets(5).
const PROBE_MAX_DEPTH = 6;

// Directories never worth descending into during the generic probe.
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.svn']);

// Windows and macOS filesystems are case-insensitive by default; Linux is not.
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/**
 * Canonicalize a path for comparison/display only: forward slashes, no
 * duplicate or trailing separators. Never use the result as an fs path.
 */
function norm(p) {
  if (p == null) return '';
  let s = String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.replace(/\/+$/, '');
  return s;
}

/** Case-correct path equality (case-insensitive on win32/darwin). */
function samePath(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return na === nb;
  return CASE_INSENSITIVE ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/**
 * Case-insensitive directory entry lookup. Exact match wins (so Linux keeps
 * case-sensitive semantics when two entries differ only by case), with a
 * case-insensitive fallback for installs that ship a different casing.
 */
function findChild(dir, name) {
  if (!dir || !name) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
  const want = String(name);
  for (const e of entries) if (e.name === want) return path.join(dir, e.name);
  const lwant = want.toLowerCase();
  for (const e of entries) if (e.name.toLowerCase() === lwant) return path.join(dir, e.name);
  return null;
}

/** The .app bundle for this gameRoot: gameRoot itself if it is one, else a sibling. */
function bundleFromRoot(gameRoot) {
  if (!gameRoot) return null;
  if (/\.app$/i.test(path.basename(norm(gameRoot)))) return gameRoot;
  const named = findChild(gameRoot, SEG.appBundle);
  if (named) return named;
  try {
    for (const e of fs.readdirSync(gameRoot, { withFileTypes: true })) {
      if (e.isDirectory() && /\.app$/i.test(e.name)) return path.join(gameRoot, e.name);
    }
  } catch (_) {}
  return null;
}

/** True when `dir` directly contains a StreamingAssets folder. */
function hasStreamingAssets(dir) {
  if (!dir) return false;
  return !!findChild(dir, SEG.streaming);
}

/**
 * Explicit candidate data roots for a game root, most likely first.
 * @returns {string[]}
 */
function dataRootCandidates(gameRoot) {
  if (!gameRoot) return [];
  const out = [];
  const add = (p) => { if (p && !out.some((x) => samePath(x, p))) out.push(p); };
  add(gameRoot);                                   // already the data root
  add(path.join(gameRoot, SEG.dataDir));           // Windows / Linux
  const app = bundleFromRoot(gameRoot);
  if (app) {
    add(path.join(app, 'Contents', 'Resources', 'Data'));
    add(path.join(app, 'Contents', 'Resources', SEG.dataDir));
    add(path.join(app, 'Contents', 'Resources'));
    add(app);
  }
  // gameRoot may be the .app's Contents/ (or a parent of the bundle).
  add(path.join(gameRoot, 'Contents', 'Resources', 'Data'));
  add(path.join(gameRoot, 'Contents', 'Resources', SEG.dataDir));
  return out;
}

/** Depth-limited BFS for the first descendant that owns a StreamingAssets dir. */
function probeForStreamingAssets(root, maxDepth = PROBE_MAX_DEPTH) {
  if (!root) return null;
  const queue = [{ dir: root, depth: 0 }];
  const seen = new Set();
  while (queue.length) {
    const { dir, depth } = queue.shift();
    const key = norm(dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (hasStreamingAssets(dir)) return dir;
    if (depth >= maxDepth) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return null;
}

// Positive-only cache (keyed by normalized gameRoot). Negative results are not
// cached so a root that gains its StreamingAssets later still resolves.
const _dataRootCache = new Map();

/**
 * The directory that owns StreamingAssets for this install, or null when none
 * of the known layouts match. Results are cached.
 *
 * Uses only the explicit, bundle-aware candidates — NOT the generic probe — so
 * `scanGameRoot`'s ancestor walk can never mistake a parent directory (which
 * merely contains a game root somewhere below) for a game root itself. Callers
 * that genuinely need to search arbitrary depths can call
 * `probeForStreamingAssets()`.
 * @returns {string|null}
 */
function resolveDataRoot(gameRoot) {
  if (!gameRoot) return null;
  const key = norm(gameRoot);
  if (_dataRootCache.has(key)) return _dataRootCache.get(key);
  let found = null;
  for (const c of dataRootCandidates(gameRoot)) {
    if (hasStreamingAssets(c)) { found = c; break; }
  }
  if (found) _dataRootCache.set(key, found);
  return found;
}

/** Clear the resolveDataRoot cache (install change / tests). */
function clearCache() { _dataRootCache.clear(); }

/** Absolute StreamingAssets path — resolved when possible, guessed otherwise. */
function streamingAssets(gameRoot) {
  const dataRoot = resolveDataRoot(gameRoot);
  if (dataRoot) return findChild(dataRoot, SEG.streaming) || path.join(dataRoot, SEG.streaming);
  return path.join(gameRoot || '', SEG.dataDir, SEG.streaming);
}

// ─── Derived accessors (the only sanctioned way to build game paths) ───

/** `<StreamingAssets>/Airports` */
function airportsDir(gameRoot) {
  return path.join(streamingAssets(gameRoot), SEG.airports);
}

/** `<StreamingAssets>/Airports/<ICAO>/Levels` */
function levelsDir(gameRoot, icao) {
  return path.join(airportsDir(gameRoot), String(icao), SEG.levels);
}

/** `<StreamingAssets>/Voices` */
function voicesDir(gameRoot) {
  return path.join(streamingAssets(gameRoot), SEG.voices);
}

/** `<StreamingAssets>/Voices/voice_catalog.json` */
function voiceCatalogPath(gameRoot) {
  return path.join(voicesDir(gameRoot), SEG.voiceCatalog);
}

/** `<StreamingAssets>/MainMenuVideos` */
function mainMenuVideosDir(gameRoot) {
  return path.join(streamingAssets(gameRoot), SEG.videos);
}

/** `<StreamingAssets>/BuiltInAircraftLivery/AircraftDefaultLivery` */
function builtinLiveryDir(gameRoot) {
  return path.join(streamingAssets(gameRoot), SEG.builtinLivery, SEG.aircraftDefaultLivery);
}

/** `<StreamingAssets>/aircraft_profiles.csv` */
function aircraftProfilesCsvPath(gameRoot) {
  return path.join(streamingAssets(gameRoot), SEG.aircraftProfilesCsv);
}

/**
 * The game's `Mods` folder. Windows/Linux: `<gameRoot>/Mods`. On macOS the
 * bundle is probed (Resources/Mods, sibling of the .app, or a Mods folder near
 * the data root) because the game may read mods from inside the bundle.
 * Returns the first existing candidate, else `<gameRoot>/Mods` (callers mkdir).
 */
function modsDir(gameRoot) {
  if (!gameRoot) return null;
  const candidates = [];
  const add = (p) => { if (p && !candidates.some((x) => samePath(x, p))) candidates.push(p); };
  add(path.join(gameRoot, SEG.mods));
  const app = bundleFromRoot(gameRoot);
  if (app) {
    add(path.join(app, 'Contents', 'Resources', SEG.mods));
    add(path.join(path.dirname(app), SEG.mods));
  }
  const dataRoot = resolveDataRoot(gameRoot);
  if (dataRoot) {
    add(path.join(dataRoot, SEG.mods));
    add(path.join(dataRoot, '..', SEG.mods));
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return path.resolve(c); } catch (_) {}
  }
  return path.resolve(candidates[0] || path.join(gameRoot, SEG.mods));
}

/**
 * Best-effort game root derived from an absolute .acl path. Works for the
 * Windows/Linux layout (`.../GroundATC_Data/StreamingAssets/...`) and the macOS
 * bundle (`.../GroundATC.app/Contents/Resources/Data/StreamingAssets/...`).
 * @returns {string|null}
 */
function gameRootFromLevelPath(aclPath) {
  if (!aclPath) return null;
  let dir = path.dirname(path.resolve(String(aclPath)));
  for (let i = 0; i < 12; i++) {
    if (path.basename(dir).toLowerCase() === SEG.streaming.toLowerCase()) {
      let cur = path.dirname(dir);
      let dataParent = null;
      while (cur && path.dirname(cur) !== cur) {
        const base = path.basename(cur);
        if (/\.app$/i.test(base)) return cur;                     // macOS bundle
        if (!dataParent && base === SEG.dataDir) dataParent = path.dirname(cur);
        cur = path.dirname(cur);
      }
      return dataParent || path.dirname(dir);                     // Windows / Linux
    }
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return null;
}

// ─── Steam library roots per OS (for game-root auto-detection) ───

/**
 * Default `<steamapps>/common` install roots for the current OS. Non-existent
 * entries are returned too — `findGameRoot` ignores missing directories.
 * @returns {string[]}
 */
function steamCommonDirs() {
  const home = os.homedir();
  const out = [];
  const add = (p) => { if (p) out.push(p); };
  if (process.platform === 'darwin') {
    add(path.join(home, 'Library', 'Application Support', 'Steam', 'steamapps', 'common'));
  } else if (process.platform === 'linux') {
    add(path.join(home, '.steam', 'steam', 'steamapps', 'common'));
    add(path.join(home, '.local', 'share', 'Steam', 'steamapps', 'common'));
    add(path.join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam', 'steamapps', 'common'));
  } else {
    add(path.join('C:\\Program Files (x86)', 'Steam', 'steamapps', 'common'));
    add(path.join('C:\\Program Files', 'Steam', 'steamapps', 'common'));
  }
  return out;
}

module.exports = {
  SEG,
  norm,
  samePath,
  findChild,
  bundleFromRoot,
  hasStreamingAssets,
  dataRootCandidates,
  probeForStreamingAssets,
  resolveDataRoot,
  clearCache,
  streamingAssets,
  airportsDir,
  levelsDir,
  voicesDir,
  voiceCatalogPath,
  mainMenuVideosDir,
  builtinLiveryDir,
  aircraftProfilesCsvPath,
  modsDir,
  gameRootFromLevelPath,
  steamCommonDirs,
};
