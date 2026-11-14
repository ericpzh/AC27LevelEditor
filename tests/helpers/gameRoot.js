/**
 * ESM facade over `gameRoot.cjs`, the single source of the machine-specific
 * game-root constant. Exists so vitest suites can `import { levelPath } ...`
 * while CommonJS dev scripts `require('./gameRoot.cjs')`. Change the path in
 * `gameRoot.cjs`, never here.
 */
import gameRoot from './gameRoot.cjs';

export const GAME_ROOT = gameRoot.GAME_ROOT;
export const FIXTURES_GAME_ROOT = gameRoot.FIXTURES_GAME_ROOT;
export const FIXTURES_GAME_ROOT_V3 = gameRoot.FIXTURES_GAME_ROOT_V3;
export const GAME_DIR_NAME = gameRoot.GAME_DIR_NAME;
export const STEAM_COMMON = gameRoot.STEAM_COMMON;
export const levelPath = gameRoot.levelPath;
export const gameLevelExists = gameRoot.gameLevelExists;
export const isLegacyOrV2Acl = gameRoot.isLegacyOrV2Acl;
export const v2LevelPath = gameRoot.v2LevelPath;
export const v2GameLevelExists = gameRoot.v2GameLevelExists;
export const isV3Acl = gameRoot.isV3Acl;
export const v3LevelPath = gameRoot.v3LevelPath;
export const v3GameLevelExists = gameRoot.v3GameLevelExists;
export const stageV3AudioIntoRoot = gameRoot.stageV3AudioIntoRoot;
