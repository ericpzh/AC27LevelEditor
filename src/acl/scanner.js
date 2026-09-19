/**
 * ACL Scanner - scans game root for all airports and their .acl levels.
 */
const fs = require('fs');
const path = require('path');
const { STEAMAPPS_SEGMENT, STEAM_COMMON_SEGMENT } = require('../utils/constants/steam.js');

/**
 * Scan the game root directory for all .acl files.
 * @param {string} gameRoot - path to "Airport Control 27 Playtest"
 * @returns {{ airports: Array, totalFiles: number, errorCode?: string, errorPath?: string }}
 */
function scanGameRoot(gameRoot) {
  const airportsDir = path.join(gameRoot, 'GroundATC_Data', 'StreamingAssets', 'Airports');
  if (!fs.existsSync(airportsDir)) {
    return { airports: [], totalFiles: 0, errorCode: 'error_airports_dir_not_found', errorPath: airportsDir };
  }

  const airports = [];
  const entries = fs.readdirSync(airportsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const airportIcao = entry.name;
    const levelsDir = path.join(airportsDir, airportIcao, 'Levels');
    if (!fs.existsSync(levelsDir)) continue;

    // List all .acl files directly (config is extracted from ACL on load)
    const levelEntries = fs.readdirSync(levelsDir, { withFileTypes: true });
    const aclFiles = [];
    for (const le of levelEntries) {
      if (le.isFile() && le.name.endsWith('.acl')) {
        aclFiles.push({
          filename: le.name,
          path: path.join(levelsDir, le.name),
        });
      }
    }

    if (aclFiles.length > 0) {
      airports.push({
        icao: airportIcao,
        levelsDir,
        aclFiles,
      });
    }
  }

  const totalFiles = airports.reduce((sum, a) => sum + a.aclFiles.length, 0);
  return { airports, totalFiles };
}

const FIND_ROOT_MAX_UP = 8;

/**
 * Deepest ancestor (including `dir` itself) whose path segment is `steamapps`,
 * or null when the path is not inside a Steam library. Case-insensitive.
 * @param {string} dir
 * @returns {string|null}
 */
function steamappsRoot(dir) {
  let resolved;
  try { resolved = path.resolve(String(dir)); } catch (_) { return null; }
  const parts = resolved.split(/[\\/]+/);
  let idx = -1;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].toLowerCase() === STEAMAPPS_SEGMENT) idx = i;
  }
  if (idx < 0) return null;
  return parts.slice(0, idx + 1).join(path.sep) || null;
}

/**
 * Best-effort auto-detection of the game root from one or more starting
 * directories (typically the running editor's exe directory).
 *
 * Passes:
 *  1. Walk up from each start dir (bounded by FIND_ROOT_MAX_UP) and return
 *     the nearest ancestor that scans as a valid game root. This covers an
 *     editor placed inside (or beside a subfolder of) the game root.
 *  2. If a start dir lies under a Steam library, probe `<steamapps>/common/*`
 *     siblings for a valid game root. This covers a standalone editor app
 *     installed side-by-side with the game in the same Steam library.
 *
 * @param {string|string[]} startDirs
 * @returns {{ gameRoot: string, airports: Array, totalFiles: number, steam: boolean }|null}
 */
function findGameRoot(startDirs) {
  const raw = Array.isArray(startDirs) ? startDirs : [startDirs];
  const starts = raw
    .filter(Boolean)
    .map(d => { try { return path.resolve(String(d)); } catch (_) { return null; } })
    .filter(Boolean);
  if (!starts.length) return null;

  const seen = new Set();
  const tryRoot = (dir) => {
    if (!dir || seen.has(dir)) return null;
    seen.add(dir);
    const scan = scanGameRoot(dir);
    if (scan.errorCode || !scan.airports.length) return null;
    return { gameRoot: dir, airports: scan.airports, totalFiles: scan.totalFiles };
  };

  // Pass 1: ancestor walk (nearest game root wins).
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i <= FIND_ROOT_MAX_UP; i++) {
      const hit = tryRoot(dir);
      if (hit) return { ...hit, steam: !!steamappsRoot(dir) };
      const parent = path.dirname(dir);
      if (!parent || parent === dir) break;
      dir = parent;
    }
  }

  // Pass 2: Steam library sibling scan.
  for (const start of starts) {
    const steamapps = steamappsRoot(start);
    if (!steamapps) continue;
    const common = path.join(steamapps, STEAM_COMMON_SEGMENT);
    let entries;
    try { entries = fs.readdirSync(common, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const hit = tryRoot(path.join(common, entry.name));
      if (hit) return { ...hit, steam: true };
    }
  }

  return null;
}

module.exports = { scanGameRoot, findGameRoot, steamappsRoot };
