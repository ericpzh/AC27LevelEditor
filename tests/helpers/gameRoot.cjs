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
const os = require('os');
const path = require('path');
const gamePaths = require('../../src/utils/gamePaths');

// Per-OS default Steam library roots, checked in order. Windows keeps the
// historical D: location first (this project's dev machine), then the
// canonical Program Files install; macOS/Linux use their standard roots so a
// real install is found on those hosts too.
function defaultSteamCommon() {
  const home = os.homedir();
  let candidates;
  if (process.platform === 'darwin') {
    candidates = [path.join(home, 'Library', 'Application Support', 'Steam', 'steamapps', 'common')];
  } else if (process.platform === 'linux') {
    candidates = [
      path.join(home, '.steam', 'steam', 'steamapps', 'common'),
      path.join(home, '.local', 'share', 'Steam', 'steamapps', 'common'),
    ];
  } else {
    candidates = ['D:/SteamLibrary/steamapps/common', 'C:/Program Files (x86)/Steam/steamapps/common'];
  }
  return candidates.find((c) => { try { return fs.existsSync(c); } catch (_) { return false; } }) || candidates[0];
}

// Steam library holding the game install (other machine → override).
const STEAM_COMMON = process.env.AC27_STEAM_COMMON || defaultSteamCommon();

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
  path.join(gamePaths.levelsDir(GAME_ROOT, icao), fileName);

const gameLevelExists = (icao, fileName) => fs.existsSync(levelPath(icao, fileName));

module.exports = { GAME_ROOT, GAME_DIR_NAME, LEGACY_GAME_DIR_NAME, STEAM_COMMON, levelPath, gameLevelExists };
