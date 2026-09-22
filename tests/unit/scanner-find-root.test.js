import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { findGameRoot, steamappsRoot } from '../../src/acl/scanner';

let tmp;

function makeGameRoot(root, icao = 'ZSJN', file = 'ZSJN_leisure_1.acl') {
  const levels = path.join(root, 'GroundATC_Data', 'StreamingAssets', 'Airports', icao, 'Levels');
  fs.mkdirSync(levels, { recursive: true });
  fs.writeFileSync(path.join(levels, file), 'placeholder');
  return root;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-find-root-'));
});

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});

describe('findGameRoot', () => {
  it('walks up from a subfolder inside the game root', () => {
    const gameRoot = makeGameRoot(path.join(tmp, 'Airport Control 27'));
    const exeDir = path.join(gameRoot, 'AC27LevelEditor');
    fs.mkdirSync(exeDir, { recursive: true });

    const found = findGameRoot([exeDir]);
    expect(found).not.toBeNull();
    expect(found.gameRoot).toBe(path.resolve(gameRoot));
    expect(found.airports.map(a => a.icao)).toContain('ZSJN');
    expect(found.steam).toBe(false);
  });

  it('returns the nearest valid game root when several nest', () => {
    makeGameRoot(path.join(tmp, 'outer'));
    const inner = makeGameRoot(path.join(tmp, 'outer', 'inner'));
    const start = path.join(inner, 'deep', 'exe');
    fs.mkdirSync(start, { recursive: true });

    const found = findGameRoot(start);
    expect(found.gameRoot).toBe(path.resolve(inner));
  });

  it('detects a Steam game root via ancestor walk', () => {
    const gameRoot = makeGameRoot(path.join(tmp, 'steamapps', 'common', 'Airport Control 27'));
    const exeDir = path.join(gameRoot, 'AC27LevelEditor');
    fs.mkdirSync(exeDir, { recursive: true });

    const found = findGameRoot([exeDir]);
    expect(found.gameRoot).toBe(path.resolve(gameRoot));
    expect(found.steam).toBe(true);
  });

  it('finds a game root sibling in the Steam library from a workshop folder', () => {
    makeGameRoot(path.join(tmp, 'steamapps', 'common', 'Airport Control 27'));
    const workshop = path.join(tmp, 'steamapps', 'workshop', 'content', '123', '456');
    fs.mkdirSync(workshop, { recursive: true });

    const found = findGameRoot([workshop]);
    expect(found).not.toBeNull();
    expect(found.gameRoot).toBe(path.resolve(tmp, 'steamapps', 'common', 'Airport Control 27'));
    expect(found.steam).toBe(true);
  });

  it('prefers the canonical shipping install over the retired Playtest folder', () => {
    // The Playtest folder sorts before the shipping install in readdir order,
    // so a name-agnostic scan would otherwise return it first.
    makeGameRoot(path.join(tmp, 'steamapps', 'common', 'Airport Control 25 Playtest'));
    const canonical = makeGameRoot(path.join(tmp, 'steamapps', 'common', 'Airport Control 27'));
    const workshop = path.join(tmp, 'steamapps', 'workshop', 'content', '3328490', '3806070599');
    fs.mkdirSync(workshop, { recursive: true });

    const found = findGameRoot([workshop]);
    expect(found.gameRoot).toBe(path.resolve(canonical));
    expect(found.steam).toBe(true);
  });

  it('ignores the demo folder in the Steam sibling scan', () => {
    makeGameRoot(path.join(tmp, 'steamapps', 'common', 'Airport Control 27 Demo'));
    const workshop = path.join(tmp, 'steamapps', 'workshop', 'content', '3328490', '3806070599');
    fs.mkdirSync(workshop, { recursive: true });

    expect(findGameRoot([workshop])).toBeNull();
  });

  it('falls back to a renamed install in the Steam sibling scan', () => {
    const renamed = makeGameRoot(path.join(tmp, 'steamapps', 'common', 'AC27 Custom Install'));
    const workshop = path.join(tmp, 'steamapps', 'workshop', 'content', '3328490', '3806070599');
    fs.mkdirSync(workshop, { recursive: true });

    const found = findGameRoot([workshop]);
    expect(found.gameRoot).toBe(path.resolve(renamed));
    expect(found.steam).toBe(true);
  });

  it('returns null when nothing valid is nearby', () => {
    const lonely = path.join(tmp, 'Downloads', 'AC27Editor');
    fs.mkdirSync(lonely, { recursive: true });
    expect(findGameRoot([lonely])).toBeNull();
  });

  it('ignores a game root with no airports', () => {
    const empty = path.join(tmp, 'steamapps', 'common', 'EmptyGame');
    fs.mkdirSync(path.join(empty, 'GroundATC_Data', 'StreamingAssets', 'Airports'), { recursive: true });
    expect(findGameRoot([empty])).toBeNull();
  });

  it('accepts a single string start dir', () => {
    const gameRoot = makeGameRoot(path.join(tmp, 'Game'));
    expect(findGameRoot(gameRoot).gameRoot).toBe(path.resolve(gameRoot));
  });

  it('returns null for empty / invalid input', () => {
    expect(findGameRoot([])).toBeNull();
    expect(findGameRoot(null)).toBeNull();
    expect(findGameRoot([null, undefined, ''])).toBeNull();
  });
});

describe('steamappsRoot', () => {
  it('finds the deepest steamapps segment case-insensitively', () => {
    const p = path.join('D:', 'SteamLibrary', 'SteamApps', 'common', 'Game');
    expect(steamappsRoot(p)).toBe(path.join('D:', 'SteamLibrary', 'SteamApps'));
  });

  it('returns null outside a Steam library', () => {
    expect(steamappsRoot(path.join('C:', 'Program Files', 'AC27Editor'))).toBeNull();
  });
});
