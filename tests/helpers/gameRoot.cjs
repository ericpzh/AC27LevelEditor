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
const FIXTURES_GAME_ROOT = path.resolve(__dirname, '..', 'fixtures', 'game-root');
const FIXTURES_GAME_ROOT_V3 = path.resolve(__dirname, '..', 'fixtures', 'game-root-v3');

const levelPath = (icao, fileName) =>
  path.join(gamePaths.levelsDir(GAME_ROOT, icao), fileName);

const gameLevelExists = (icao, fileName) => fs.existsSync(levelPath(icao, fileName));

/**
 * Check whether an `.acl` path exists and uses an Odin-backed format
 * (`GATCARC4` v1/v2 or legacy plain-text JSON). Returns false on v3+ archives.
 */
function isLegacyOrV2Acl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(16);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    if (read >= 12 && head.subarray(0, 8).toString('ascii') === 'GATCARC4') {
      const ver = head.readUInt32LE(8);
      return ver === 1 || ver === 2;
    }
    const textHead = head.subarray(0, read).toString('utf8').trimStart();
    return textHead.startsWith('{');
  } catch (_) {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    }
  }
}

/**
 * Resolve an Odin-backed (v1/v2/legacy) `.acl` level for Odin-specific tests.
 * Checks `GAME_ROOT` first; when the installed game has moved to GATCARC4 v3,
 * falls back to checked-in `tests/fixtures/game-root` (matching `icao/fileName`
 * first, then optional `fallbackIcao/fallbackFileName`).
 */
function v2LevelPath(icao, fileName, fallbackIcao = 'ZSJN', fallbackFileName = 'ZSJN_leisure_1.acl') {
  const live = levelPath(icao, fileName);
  if (isLegacyOrV2Acl(live)) return live;

  const exactFixture = path.join(gamePaths.levelsDir(FIXTURES_GAME_ROOT, icao), fileName);
  if (isLegacyOrV2Acl(exactFixture)) return exactFixture;

  if (fallbackIcao && fallbackFileName) {
    const liveFallback = levelPath(fallbackIcao, fallbackFileName);
    if (isLegacyOrV2Acl(liveFallback)) return liveFallback;

    const fixtureFallback = path.join(gamePaths.levelsDir(FIXTURES_GAME_ROOT, fallbackIcao), fallbackFileName);
    if (isLegacyOrV2Acl(fixtureFallback)) return fixtureFallback;
  }

  return live;
}

const v2GameLevelExists = (icao, fileName, fallbackIcao, fallbackFileName) =>
  isLegacyOrV2Acl(v2LevelPath(icao, fileName, fallbackIcao, fallbackFileName));

/**
 * Check whether an `.acl` path exists and uses GATCARC4 storage version 3.
 */
function isV3Acl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(16);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    if (read >= 12 && head.subarray(0, 8).toString('ascii') === 'GATCARC4') {
      const ver = head.readUInt32LE(8);
      return ver === 3;
    }
    return false;
  } catch (_) {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    }
  }
}

/**
 * Resolve a GATCARC4 v3 `.acl` level for v3 tests.
 * Prefers checked-in `tests/fixtures/game-root-v3` when `icao/fileName` exists
 * there (so fixture tests stay deterministic even if the live game is edited),
 * then falls back to `GAME_ROOT`, and finally to `fallbackIcao/fallbackFileName`.
 */
function v3LevelPath(icao, fileName, fallbackIcao = 'ZSJN', fallbackFileName = 'ZSJN_leisure_1.acl') {
  const exactFixture = path.join(gamePaths.levelsDir(FIXTURES_GAME_ROOT_V3, icao), fileName);
  if (isV3Acl(exactFixture)) return exactFixture;

  const live = levelPath(icao, fileName);
  if (isV3Acl(live)) return live;

  if (fallbackIcao && fallbackFileName) {
    const fixtureFallback = path.join(gamePaths.levelsDir(FIXTURES_GAME_ROOT_V3, fallbackIcao), fallbackFileName);
    if (isV3Acl(fixtureFallback)) return fixtureFallback;

    const liveFallback = levelPath(fallbackIcao, fallbackFileName);
    if (isV3Acl(liveFallback)) return liveFallback;
  }

  return exactFixture;
}

const v3GameLevelExists = (icao, fileName, fallbackIcao, fallbackFileName) =>
  isV3Acl(v3LevelPath(icao, fileName, fallbackIcao, fallbackFileName));

module.exports = {
  GAME_ROOT,
  FIXTURES_GAME_ROOT,
  FIXTURES_GAME_ROOT_V3,
  GAME_DIR_NAME,
  LEGACY_GAME_DIR_NAME,
  STEAM_COMMON,
  levelPath,
  gameLevelExists,
  isLegacyOrV2Acl,
  v2LevelPath,
  v2GameLevelExists,
  isV3Acl,
  v3LevelPath,
  v3GameLevelExists,
};
