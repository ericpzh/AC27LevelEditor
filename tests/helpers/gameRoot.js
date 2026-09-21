/**
 * ESM facade over `gameRoot.cjs`, the single source of the machine-specific
 * game-root constant. Exists so vitest suites can `import { levelPath } ...`
 * while CommonJS dev scripts `require('./gameRoot.cjs')`. Change the path in
 * `gameRoot.cjs`, never here.
 */
import gameRoot from './gameRoot.cjs';

export const GAME_ROOT = gameRoot.GAME_ROOT;
export const GAME_DIR_NAME = gameRoot.GAME_DIR_NAME;
export const STEAM_COMMON = gameRoot.STEAM_COMMON;
export const levelPath = gameRoot.levelPath;
export const gameLevelExists = gameRoot.gameLevelExists;
