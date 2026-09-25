/**
 * reset-levels.js — filesystem restore for the "Restore All Levels" flow.
 *
 * Deletes every entry under `<airportsDir>/<ICAO>/Levels/` (level files,
 * backups, sidecars) AND the airport scenery files the Ground Painter can
 * rewrite (`Config.geoDataFile` + `.osm`, e.g. `geo_data.osm` /
 * `geo_data_taxiwayclosed.osm`). The user then runs Steam → Verify Integrity
 * to re-download pristine copies of all of them.
 *
 * Why the `.osm` too: the ground painter's save path (`geo_osm.syncGeoDataForLevel`)
 * rewrites the level's `geoDataFile` — a file that lives in the airport dir,
 * NOT under `Levels/`, so the level-file loop never sees it. Steam Verify would
 * normally restore a modified depot file, but deleting it makes the reset
 * self-consistent even if Verify is skipped, and forces a clean re-fetch.
 *
 * Pure FS logic (no `require('electron')`) so it is unit-testable — same pattern
 * as `electron/pttShortcut.js` / `electron/bepinex.js`.
 *
 * @param {string} airportsDir  absolute `<gameRoot>/.../Airports` directory
 * @param {{log?:(...a:any[])=>void, error?:(...a:any[])=>void}} [logger]
 * @returns {{deletedCount:number, airports:number}}
 * @throws {Error} code `AIRPORTS_DIR_NOT_FOUND` when `airportsDir` does not exist
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { SEG, findChild } = require('../src/utils/gamePaths');

/** Config.geoDataFile fallback when an airport has no `.aclcfg` sidecars. */
const DEFAULT_GEO_DATA_FILE = 'geo_data';

/** Collect the per-level `Config.geoDataFile` names from an airport's `.aclcfg` sidecars. */
function collectGeoDataFiles(levelsDir, levelEntries) {
  const geoDataFiles = new Set();
  for (const le of levelEntries) {
    if (!le.isFile() || !le.name.toLowerCase().endsWith('.aclcfg')) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(levelsDir, le.name), 'utf-8'));
      if (cfg && typeof cfg.geoDataFile === 'string' && cfg.geoDataFile) {
        geoDataFiles.add(cfg.geoDataFile);
      }
    } catch (_) {
      // best-effort: a malformed/missing sidecar is skipped
    }
  }
  // No sidecars told us the name (e.g. a hand-made level) — fall back to the
  // shipped default so the airport's geo_data.osm is still removed.
  if (geoDataFiles.size === 0) geoDataFiles.add(DEFAULT_GEO_DATA_FILE);
  return geoDataFiles;
}

function resetAllLevels(airportsDir, logger = console) {
  if (!airportsDir || !fs.existsSync(airportsDir)) {
    const err = new Error('AIRPORTS_DIR_NOT_FOUND');
    err.code = 'AIRPORTS_DIR_NOT_FOUND';
    throw err;
  }
  const log = typeof logger.log === 'function' ? logger.log.bind(logger) : () => {};
  const logErr = typeof logger.error === 'function' ? logger.error.bind(logger) : log;

  let totalDeleted = 0;
  let airportsProcessed = 0;

  for (const e of fs.readdirSync(airportsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const airportDir = path.join(airportsDir, e.name);
    // Case-tolerant (macOS/Linux): findChild resolves the actual on-disk casing.
    const levelsDir = findChild(airportDir, SEG.levels);
    if (!levelsDir) continue;
    airportsProcessed++;

    const levelEntries = fs.readdirSync(levelsDir, { withFileTypes: true });
    // Read the geoDataFile names BEFORE deleting Levels (the .aclcfg live there).
    const geoDataFiles = collectGeoDataFiles(levelsDir, levelEntries);

    for (const le of levelEntries) {
      const fullPath = path.join(levelsDir, le.name);
      try {
        if (le.isFile() || le.isSymbolicLink()) {
          fs.rmSync(fullPath, { force: true });
          totalDeleted++;
        } else if (le.isDirectory()) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          totalDeleted++;
        }
      } catch (err) {
        logErr('[reset-levels] failed to delete', fullPath, err.message);
      }
    }

    // Scenery files the ground painter syncs (live one level up from Levels/).
    for (const gd of geoDataFiles) {
      for (const suffix of ['.osm', '.osm.bak']) {
        const geoPath = path.join(airportDir, gd + suffix);
        try {
          if (fs.existsSync(geoPath)) {
            fs.rmSync(geoPath, { force: true });
            totalDeleted++;
          }
        } catch (err) {
          logErr('[reset-levels] failed to delete', geoPath, err.message);
        }
      }
    }
  }

  log(`[reset-levels] deleted ${totalDeleted} entries across ${airportsProcessed} airports`);
  return { deletedCount: totalDeleted, airports: airportsProcessed };
}

module.exports = { resetAllLevels, collectGeoDataFiles, DEFAULT_GEO_DATA_FILE };
