import { existsSync } from 'fs';

/**
 * AC27 game install root used by integration suites that read real .acl
 * levels from the live game layout. Override in CI / other machines:
 *   AC27_GAME_ROOT=/path/to/Airport Control 25 Playtest
 * Suites that need a level file skip cleanly (with a reason) when it is absent.
 */
export const GAME_ROOT = process.env.AC27_GAME_ROOT
  || 'D:/SteamLibrary/steamapps/common/Airport Control 25 Playtest';

export const levelPath = (icao, fileName) =>
  `${GAME_ROOT}/GroundATC_Data/StreamingAssets/Airports/${icao}/Levels/${fileName}`;

export const gameLevelExists = (icao, fileName) => existsSync(levelPath(icao, fileName));
