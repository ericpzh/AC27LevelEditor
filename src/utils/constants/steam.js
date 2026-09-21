// ─── Steam constants ───
// Single source of truth for Steam app/Workshop identity, Steam library path
// segments, Workshop artifact/marker names, the env vars and Web API endpoints
// used by the app (Electron main), build.js, the scripts/ tooling and, for the
// numeric ids, the release workflow. Update a value here — consumers import it
// instead of re-declaring the literal.

// Steam app ids.
// - STEAM_GAME_APP_ID: the shipping Airport Control 27 game (the Workshop host).
// - STEAM_APP_ID: the app that hosts the Workshop item (now the shipping game).
export const STEAM_GAME_APP_ID = '3328490';
export const STEAM_APP_ID = '3328490';
export const STEAM_PUBLISHED_FILE_ID = '3793213548';

// Game install directory names under `<steamapps>/common`. Single source of
// truth for the user-facing name (dialogs, default-path hints, demo detection);
// rename here when the game is renamed.
export const STEAM_GAME_DIR_NAME = 'Airport Control 27';
export const STEAM_DEMO_DIR_NAME = 'Airport Control 27 Demo';

// Workshop item identity / artifacts.
export const STEAM_WORKSHOP_TITLE = 'AC27Editor';
export const STEAM_WORKSHOP_ARTIFACT = 'AC27EditorWorkshop';
export const STEAM_WORKSHOP_CONTENT_DIR = 'steam-workshop-content';
// Marker baked into resources/ of the Workshop build (auto-update disabled).
export const STEAM_WORKSHOP_MARKER = 'workshop.json';
// Source marker written by build.js --workshop, mapped to the marker above.
export const STEAM_WORKSHOP_SOURCE_MARKER = '.workshop-marker.json';

// Steam library path segments. Detection is name-agnostic and keys off these
// case-insensitive segments (see src/acl/scanner.js, electron/livery.js).
export const STEAMAPPS_SEGMENT = 'steamapps';
export const STEAM_COMMON_SEGMENT = 'common';
export const STEAM_WORKSHOP_SEGMENT = 'workshop';
export const STEAM_WORKSHOP_CONTENT_SEGMENT = 'content';

// steamcmd VDF visibility codes.
export const STEAM_VISIBILITY = Object.freeze({
  PUBLIC: '0',
  FRIENDS: '1',
  PRIVATE: '2',
  UNLISTED: '3',
});

// Environment variable names read by scripts/ and CI.
export const STEAM_ENV = Object.freeze({
  PUBLISHER_KEY: 'STEAM_PUBLISHER_KEY',
  API_KEY: 'STEAM_API_KEY',
  USERNAME: 'STEAM_USERNAME',
  STEAMCMD: 'STEAMCMD',
  CONFIG_VDF: 'STEAM_CONFIG_VDF',
});

// Web API endpoints for the bilingual title/description push, in preference
// order (partner API first, then the public Web API fallback).
export const STEAM_UPDATE_PUBLISHED_FILE_ENDPOINTS = Object.freeze([
  'https://partner.steam-api.com/IPublishedFileService/UpdatePublishedFile/v1/',
  'https://api.steampowered.com/ISteamRemoteStorage/UpdatePublishedFile/v1/',
]);
