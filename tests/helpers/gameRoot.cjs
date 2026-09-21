/**
 * AC27 game install root used by the test suites and dev scripts that read
 * real .acl levels from the live game layout.
 *
 * ── Single source of truth for the machine-specific game path ──
 * The game folder is still the Playtest install; once the game leaves Playtest
 * and the install directory is renamed, flip GAME_DIR_NAME to 'Airport Control 27'
 * (this is the one line to change).
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

// ← the one line to bump when the game install is renamed.
const GAME_DIR_NAME = 'Airport Control 25 Playtest';

const GAME_ROOT = process.env.AC27_GAME_ROOT
  || `${STEAM_COMMON}/${GAME_DIR_NAME}`;

const levelPath = (icao, fileName) =>
  `${GAME_ROOT}/GroundATC_Data/StreamingAssets/Airports/${icao}/Levels/${fileName}`;

const gameLevelExists = (icao, fileName) => fs.existsSync(levelPath(icao, fileName));

module.exports = { GAME_ROOT, GAME_DIR_NAME, STEAM_COMMON, levelPath, gameLevelExists };
