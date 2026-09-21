/**
 * AC27 game install root used by the test suites and dev scripts that read
 * real .acl levels from the live game layout.
 *
 * ── Single source of truth for the machine-specific game path ──
 * GAME_DIR_NAME is the canonical shipping install name (app 3328490); the
 * legacy Playtest folder (app 4004140) is only a fallback so local suites keep
 * running on machines where the shipping game has not replaced it yet.
 *
 * Overrides for other machines / CI:
 *   AC27_GAME_ROOT      full install path (skips STEAM_COMMON + GAME_DIR_NAME)
 *   AC27_STEAM_COMMON   Steam library `...\steamapps\common` root
 *
 * Suites that need a level file skip cleanly (with a reason) when it is absent.
 */
const fs = require('fs');

// Steam library holding the game install (other machine → override).
const STEAM_COMMON = process.env.AC27_STEAM_COMMON
  || 'D:/SteamLibrary/steamapps/common';

// Canonical shipping install folder, then the legacy Playtest folder.
const GAME_DIR_NAME = 'Airport Control 27';
const LEGACY_GAME_DIR_NAME = 'Airport Control 25 Playtest';

function resolveGameRoot() {
  if (process.env.AC27_GAME_ROOT) return process.env.AC27_GAME_ROOT;
  const canonical = `${STEAM_COMMON}/${GAME_DIR_NAME}`;
  if (fs.existsSync(canonical)) return canonical;
  const legacy = `${STEAM_COMMON}/${LEGACY_GAME_DIR_NAME}`;
  if (fs.existsSync(legacy)) return legacy;
  return canonical; // nothing installed — export canonical; suites skip cleanly
}

const GAME_ROOT = resolveGameRoot();

const levelPath = (icao, fileName) =>
  `${GAME_ROOT}/GroundATC_Data/StreamingAssets/Airports/${icao}/Levels/${fileName}`;

const gameLevelExists = (icao, fileName) => fs.existsSync(levelPath(icao, fileName));

module.exports = { GAME_ROOT, GAME_DIR_NAME, LEGACY_GAME_DIR_NAME, STEAM_COMMON, levelPath, gameLevelExists };
