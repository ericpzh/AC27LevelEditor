// @vitest-environment node

/**
 * Tests for src/utils/gamePaths.js — cross-platform resolution of the game's
 * data root (Windows/Linux `GroundATC_Data`, macOS `.app` bundle) and the
 * derived folder accessors. Pure node fs/path; no Electron.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const gp = require('../../src/utils/gamePaths');
const { findGameRoot } = require('../../src/acl/scanner');

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-gamepaths-'));
  gp.clearCache();
});

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  gp.clearCache();
});

/** Create a data root (the dir that owns StreamingAssets) with one airport. */
function seedDataRoot(dataRoot, icao = 'ZSJN') {
  const levels = path.join(dataRoot, 'StreamingAssets', 'Airports', icao, 'Levels');
  fs.mkdirSync(levels, { recursive: true });
  fs.writeFileSync(path.join(levels, `${icao}_leisure_1.acl`), 'placeholder');
  return dataRoot;
}

/** Windows/Linux install: <root>/GroundATC_Data/StreamingAssets/... */
function seedWinLinux(root, icao = 'ZSJN') {
  return seedDataRoot(path.join(root, 'GroundATC_Data'), icao);
}

/** macOS install: <root>/GroundATC.app/Contents/Resources/Data/StreamingAssets/... */
function seedMacBundle(root, icao = 'ZSJN') {
  const app = path.join(root, 'GroundATC.app');
  const data = path.join(app, 'Contents', 'Resources', 'Data');
  seedDataRoot(data, icao);
  return { app, data };
}

describe('norm / samePath', () => {
  it('normalizes separators and collapses duplicates', () => {
    expect(gp.norm('C:\\a\\b\\')).toBe('C:/a/b');
    expect(gp.norm('/a//b///c/')).toBe('/a/b/c');
    expect(gp.norm('')).toBe('');
    expect(gp.norm(null)).toBe('');
  });

  it('compares paths case-insensitively on win32/darwin only', () => {
    const expected = process.platform === 'linux';
    expect(gp.samePath('C:\\Games\\AC27', 'c:/games/ac27')).toBe(!expected);
  });
});

describe('findChild', () => {
  it('prefers an exact match and falls back to case-insensitive', () => {
    fs.mkdirSync(path.join(tmp, 'GroundATC_Data'));
    fs.mkdirSync(path.join(tmp, 'StreamingAssets'));
    expect(gp.findChild(tmp, 'GroundATC_Data')).toBe(path.join(tmp, 'GroundATC_Data'));
    expect(gp.findChild(tmp, 'groundatc_data')).toBe(path.join(tmp, 'GroundATC_Data'));
    expect(gp.findChild(tmp, 'StreamingAssets')).toBe(path.join(tmp, 'StreamingAssets'));
    expect(gp.findChild(tmp, 'missing')).toBeNull();
  });
});

describe('resolveDataRoot', () => {
  it('resolves the Windows/Linux layout', () => {
    const root = path.join(tmp, 'Airport Control 27');
    const data = seedWinLinux(root);
    expect(gp.resolveDataRoot(root)).toBe(data);
    expect(gp.airportsDir(root)).toBe(path.join(data, 'StreamingAssets', 'Airports'));
    expect(gp.levelsDir(root, 'ZSJN')).toBe(path.join(data, 'StreamingAssets', 'Airports', 'ZSJN', 'Levels'));
  });

  it('resolves a macOS bundle from the parent folder', () => {
    const root = path.join(tmp, 'Airport Control 27');
    const { data } = seedMacBundle(root);
    expect(gp.resolveDataRoot(root)).toBe(data);
    expect(gp.streamingAssets(root)).toBe(path.join(data, 'StreamingAssets'));
  });

  it('resolves a macOS bundle when the .app itself is the game root', () => {
    const root = path.join(tmp, 'Airport Control 27');
    const { app, data } = seedMacBundle(root);
    expect(gp.resolveDataRoot(app)).toBe(data);
    expect(gp.levelsDir(app, 'ZSJN')).toBe(path.join(data, 'StreamingAssets', 'Airports', 'ZSJN', 'Levels'));
  });

  it('resolves a macOS bundle that keeps the GroundATC_Data name', () => {
    const root = path.join(tmp, 'Airport Control 27');
    const app = path.join(root, 'GroundATC.app');
    const data = seedDataRoot(path.join(app, 'Contents', 'Resources', 'GroundATC_Data'));
    expect(gp.resolveDataRoot(root)).toBe(data);
  });

  it('probes for unusual layouts only when asked explicitly', () => {
    const root = path.join(tmp, 'Renamed Install');
    const data = seedDataRoot(path.join(root, 'payload', 'nested', 'GameData'));
    // resolveDataRoot stays conservative (explicit layouts only)…
    expect(gp.resolveDataRoot(root)).toBeNull();
    // …the opt-in probe finds it.
    expect(gp.probeForStreamingAssets(root)).toBe(data);
  });

  it('returns null and a guessed path when nothing is found', () => {
    const root = path.join(tmp, 'Nothing Here');
    fs.mkdirSync(root, { recursive: true });
    expect(gp.resolveDataRoot(root)).toBeNull();
    expect(gp.airportsDir(root)).toBe(
      path.join(root, 'GroundATC_Data', 'StreamingAssets', 'Airports'),
    );
  });

  it('caches positive results but not negatives', () => {
    const root = path.join(tmp, 'Late Install');
    fs.mkdirSync(root, { recursive: true });
    expect(gp.resolveDataRoot(root)).toBeNull(); // negative — not cached
    const data = seedWinLinux(root);
    expect(gp.resolveDataRoot(root)).toBe(data); // now resolvable
  });
});

describe('derived accessors', () => {
  it('builds the standard asset paths', () => {
    const root = path.join(tmp, 'Game');
    const data = seedWinLinux(root);
    const sa = path.join(data, 'StreamingAssets');
    expect(gp.voicesDir(root)).toBe(path.join(sa, 'Voices'));
    expect(gp.voiceCatalogPath(root)).toBe(path.join(sa, 'Voices', 'voice_catalog.json'));
    expect(gp.mainMenuVideosDir(root)).toBe(path.join(sa, 'MainMenuVideos'));
    expect(gp.builtinLiveryDir(root)).toBe(
      path.join(sa, 'BuiltInAircraftLivery', 'AircraftDefaultLivery'),
    );
    expect(gp.aircraftProfilesCsvPath(root)).toBe(path.join(sa, 'aircraft_profiles.csv'));
  });
});

describe('modsDir', () => {
  it('returns <gameRoot>/Mods when it exists', () => {
    const root = path.join(tmp, 'Game');
    const mods = path.join(root, 'Mods');
    fs.mkdirSync(mods, { recursive: true });
    expect(gp.modsDir(root)).toBe(path.resolve(mods));
  });

  it('falls back to <gameRoot>/Mods (creatable) when none exists', () => {
    const root = path.join(tmp, 'Game');
    fs.mkdirSync(root, { recursive: true });
    expect(gp.modsDir(root)).toBe(path.resolve(path.join(root, 'Mods')));
  });

  it('finds a Mods folder beside a macOS .app', () => {
    const root = path.join(tmp, 'Airport Control 27');
    const { app } = seedMacBundle(root);
    const mods = path.join(path.dirname(app), 'Mods');
    fs.mkdirSync(mods, { recursive: true });
    expect(gp.modsDir(app)).toBe(path.resolve(mods));
  });
});

describe('gameRootFromLevelPath', () => {
  it('derives the root from a Windows/Linux level path', () => {
    const root = path.join(tmp, 'Airport Control 27');
    const data = seedWinLinux(root);
    const acl = path.join(data, 'StreamingAssets', 'Airports', 'ZSJN', 'Levels', 'ZSJN_leisure_1.acl');
    expect(gp.gameRootFromLevelPath(acl)).toBe(root);
  });

  it('derives the .app from a macOS bundle level path', () => {
    const root = path.join(tmp, 'Airport Control 27');
    const { app, data } = seedMacBundle(root);
    const acl = path.join(data, 'StreamingAssets', 'Airports', 'ZSJN', 'Levels', 'ZSJN_leisure_1.acl');
    expect(gp.gameRootFromLevelPath(acl)).toBe(app);
  });

  it('returns null for unrelated paths', () => {
    expect(gp.gameRootFromLevelPath(path.join(tmp, 'foo', 'bar.acl'))).toBeNull();
    expect(gp.gameRootFromLevelPath(null)).toBeNull();
  });
});

describe('steamCommonDirs', () => {
  it('returns platform-appropriate library roots', () => {
    const dirs = gp.steamCommonDirs().map(gp.norm);
    expect(dirs.length).toBeGreaterThan(0);
    if (process.platform === 'darwin') {
      expect(dirs.some(d => d.includes('Library/Application Support/Steam'))).toBe(true);
    } else if (process.platform === 'linux') {
      expect(dirs.some(d => d.includes('.steam/steam'))).toBe(true);
    } else {
      expect(dirs.some(d => d.toLowerCase().includes('program files'))).toBe(true);
    }
  });
});

describe('scanner integration', () => {
  it('finds a Windows/Linux game root (regression)', () => {
    const root = path.join(tmp, 'steamapps', 'common', 'Airport Control 27');
    seedWinLinux(root);
    expect(findGameRoot(root).gameRoot).toBe(path.resolve(root));
  });

  it('finds a macOS bundle game root', () => {
    const root = path.join(tmp, 'steamapps', 'common', 'Airport Control 27');
    seedMacBundle(root);
    const found = findGameRoot([path.join(root, 'AC27Editor')]);
    expect(found).not.toBeNull();
    expect(found.airports.map(a => a.icao)).toContain('ZSJN');
    // The ancestor walk may stop at the .app itself — also a valid root.
    expect([path.resolve(root), path.resolve(path.join(root, 'GroundATC.app'))])
      .toContain(path.resolve(found.gameRoot));
  });

  it('finds a macOS bundle via the Steam sibling scan', () => {
    const root = path.join(tmp, 'steamapps', 'common', 'Airport Control 27');
    seedMacBundle(root);
    const workshop = path.join(tmp, 'steamapps', 'workshop', 'content', '3328490', '3806070599');
    fs.mkdirSync(workshop, { recursive: true });
    const found = findGameRoot([workshop]);
    expect(found).not.toBeNull();
    expect(found.gameRoot).toBe(path.resolve(root));
    expect(found.steam).toBe(true);
  });
});
