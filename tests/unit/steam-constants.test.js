import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  STEAM_GAME_APP_ID,
  STEAM_APP_ID,
  STEAM_PUBLISHED_FILE_ID,
  STEAM_GAME_DIR_NAME,
  STEAM_DEMO_DIR_NAME,
  STEAM_LEGACY_GAME_DIR_NAME,
  STEAM_WORKSHOP_TITLE,
  STEAM_WORKSHOP_ARTIFACT,
  STEAM_WORKSHOP_MARKER,
  STEAM_WORKSHOP_SOURCE_MARKER,
  STEAMAPPS_SEGMENT,
  STEAM_COMMON_SEGMENT,
  STEAM_WORKSHOP_SEGMENT,
  STEAM_WORKSHOP_CONTENT_SEGMENT,
  STEAM_VISIBILITY,
  STEAM_ENV,
  STEAM_UPDATE_PUBLISHED_FILE_ENDPOINTS,
} from '../../src/utils/constants/steam';

const ROOT = path.join(__dirname, '..', '..');

describe('steam constants', () => {
  it('exposes the editor + game app identity', () => {
    expect(STEAM_APP_ID).toBe('3328490');
    expect(STEAM_PUBLISHED_FILE_ID).toBe('3806070599');
    expect(STEAM_GAME_APP_ID).toBe('3328490');
    expect(STEAM_WORKSHOP_TITLE).toBe('AC27Editor');
  });

  it('exposes the game install directory names', () => {
    expect(STEAM_GAME_DIR_NAME).toBe('Airport Control 27');
    expect(STEAM_DEMO_DIR_NAME).toBe('Airport Control 27 Demo');
    expect(STEAM_LEGACY_GAME_DIR_NAME).toBe('Airport Control 25 Playtest');
  });

  it('exposes the Workshop artifact + marker names', () => {
    expect(STEAM_WORKSHOP_ARTIFACT).toBe('AC27EditorWorkshop');
    expect(STEAM_WORKSHOP_MARKER).toBe('workshop.json');
    expect(STEAM_WORKSHOP_SOURCE_MARKER).toBe('.workshop-marker.json');
  });

  it('exposes the Steam library path segments', () => {
    expect(STEAMAPPS_SEGMENT).toBe('steamapps');
    expect(STEAM_COMMON_SEGMENT).toBe('common');
    expect(STEAM_WORKSHOP_SEGMENT).toBe('workshop');
    expect(STEAM_WORKSHOP_CONTENT_SEGMENT).toBe('content');
  });

  it('exposes the visibility codes, env names and endpoints', () => {
    expect(STEAM_VISIBILITY).toEqual({ PUBLIC: '0', FRIENDS: '1', PRIVATE: '2', UNLISTED: '3' });
    expect(STEAM_ENV.USERNAME).toBe('STEAM_USERNAME');
    expect(STEAM_ENV.CONFIG_VDF).toBe('STEAM_CONFIG_VDF');
    expect(STEAM_UPDATE_PUBLISHED_FILE_ENDPOINTS[0]).toMatch(/partner\.steam-api\.com/);
  });

  it('release workflow derives the numeric ids from the constants, not literals', () => {
    const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(yml).not.toMatch(new RegExp(`"appid"\\s+"${STEAM_APP_ID}"`));
    expect(yml).not.toMatch(new RegExp(`"publishedfileid"\\s+"${STEAM_PUBLISHED_FILE_ID}"`));
    expect(yml).toContain('STEAM_APP_ID');
    expect(yml).toContain('STEAM_PUBLISHED_FILE_ID');
  });
});
