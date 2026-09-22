// @vitest-environment node

/**
 * Tests for electron/workshop-dll.js — resolveWorkshopBundledDllPath candidate
 * order.
 *
 * Mock strategy: prime electron in require.cache (updater.isWorkshopBuild reads
 * app.isPackaged / AC27_WORKSHOP), then require the module — same pattern as
 * updater.test.js / bepinex.test.js. The game-root path uses the REAL
 * livery.workshopContentDir walk on a temp Steam library layout, so no livery
 * mock is needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { STEAM_APP_ID, STEAM_PUBLISHED_FILE_ID } from '../../src/utils/constants/steam.js';

const DLL_NAME = 'AC27Approach.dll';

// ── Primed electron mock (updater reads app.isPackaged / app.getPath) ──
const mockApp = {
  isPackaged: false,
  getPath: vi.fn(() => path.join(os.tmpdir(), 'AC27Editor.exe')),
};

function primeElectron() {
  require.cache[require.resolve('electron')] = {
    id: require.resolve('electron'),
    filename: require.resolve('electron'),
    loaded: true,
    exports: { app: mockApp },
  };
}

function clearCache() {
  delete require.cache[require.resolve('electron')];
  delete require.cache[require.resolve('../../electron/updater')];
  delete require.cache[require.resolve('../../electron/workshop-dll')];
}

function getModule() {
  delete require.cache[require.resolve('../../electron/workshop-dll')];
  return require('../../electron/workshop-dll');
}

let tmpDirs = [];

function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

// Build <lib>/steamapps/{common/Airport Control 27, workshop/content/<appid>/<id>}
function steamLayout() {
  const lib = tmpDir('ac27-workshop-dll-');
  const gameRoot = path.join(lib, 'steamapps', 'common', 'Airport Control 27');
  const itemDir = path.join(lib, 'steamapps', 'workshop', 'content', STEAM_APP_ID, STEAM_PUBLISHED_FILE_ID);
  fs.mkdirSync(gameRoot, { recursive: true });
  return { lib, gameRoot, itemDir };
}

function writeDll(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, DLL_NAME);
  fs.writeFileSync(p, 'MZ');
  return p;
}

beforeEach(() => {
  clearCache();
  tmpDirs = [];
  mockApp.isPackaged = false;
  mockApp.getPath.mockReturnValue(path.join(os.tmpdir(), 'AC27Editor.exe'));
  process.env.AC27_WORKSHOP = '1';
  primeElectron();
});

afterEach(() => {
  clearCache();
  delete process.env.AC27_WORKSHOP;
  delete process.env.AC27_WORKSHOP_DIR;
  delete process.env.PORTABLE_EXECUTABLE_FILE;
  if (Object.prototype.hasOwnProperty.call(process, 'resourcesPath')) delete process.resourcesPath;
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
  tmpDirs = [];
});

describe('resolveWorkshopBundledDllPath — build gate', () => {
  it('returns null on a non-Workshop build (never probes)', () => {
    delete process.env.AC27_WORKSHOP;
    const { gameRoot, itemDir } = steamLayout();
    writeDll(itemDir);
    expect(getModule().resolveWorkshopBundledDllPath(gameRoot)).toBeNull();
  });
});

describe('resolveWorkshopBundledDllPath — game-root path', () => {
  it('resolves the item DLL from the game root via the sibling workshop/content dir', () => {
    const { gameRoot, itemDir } = steamLayout();
    const expected = writeDll(itemDir);
    expect(getModule().resolveWorkshopBundledDllPath(gameRoot)).toBe(expected);
  });

  it('prefers the game-root item DLL over resources/ and the exe sibling', () => {
    const { gameRoot, itemDir } = steamLayout();
    const expected = writeDll(itemDir);
    // resources/ candidate
    process.resourcesPath = writeDll(tmpDir('ac27-res-'));
    // legacy exe sibling candidate
    const exeDir = tmpDir('ac27-exe-');
    writeDll(exeDir);
    process.env.PORTABLE_EXECUTABLE_FILE = path.join(exeDir, 'AC27EditorWorkshop.exe');

    expect(getModule().resolveWorkshopBundledDllPath(gameRoot)).toBe(expected);
  });

  it('skips the game-root path when gameRoot is null', () => {
    const { itemDir } = steamLayout();
    writeDll(itemDir);
    const resDir = tmpDir('ac27-res-');
    process.resourcesPath = resDir;
    const expected = writeDll(resDir);
    expect(getModule().resolveWorkshopBundledDllPath(null)).toBe(expected);
  });
});

describe('resolveWorkshopBundledDllPath — AC27_WORKSHOP_DIR override', () => {
  it('wins over the game-root item path', () => {
    const { gameRoot, itemDir } = steamLayout();
    writeDll(itemDir);
    const overrideDir = tmpDir('ac27-override-');
    const expected = writeDll(overrideDir);
    process.env.AC27_WORKSHOP_DIR = overrideDir;

    expect(getModule().resolveWorkshopBundledDllPath(gameRoot)).toBe(expected);
  });

  it('accepts a path pointing at the exe itself (uses its dirname)', () => {
    const overrideDir = tmpDir('ac27-override-');
    const expected = writeDll(overrideDir);
    // Point at an existing file (the DLL) to exercise the isFile() → dirname path.
    process.env.AC27_WORKSHOP_DIR = expected;

    expect(getModule().resolveWorkshopBundledDllPath(null)).toBe(expected);
  });
});

describe('resolveWorkshopBundledDllPath — fallbacks', () => {
  it('falls back to resources/ when the game root is not a Steam layout', () => {
    const lonelyGameRoot = tmpDir('ac27-lonely-');
    const resDir = tmpDir('ac27-res-');
    process.resourcesPath = resDir;
    const expected = writeDll(resDir);

    expect(getModule().resolveWorkshopBundledDllPath(lonelyGameRoot)).toBe(expected);
  });

  it('falls back to the legacy <exe-dir> sibling via PORTABLE_EXECUTABLE_FILE', () => {
    const exeDir = tmpDir('ac27-exe-');
    const expected = writeDll(exeDir);
    process.env.PORTABLE_EXECUTABLE_FILE = path.join(exeDir, 'AC27EditorWorkshop.exe');

    expect(getModule().resolveWorkshopBundledDllPath(null)).toBe(expected);
  });

  it('falls back to app.getPath("exe") when PORTABLE_EXECUTABLE_FILE is unset', () => {
    const exeDir = tmpDir('ac27-appexe-');
    const expected = writeDll(exeDir);
    mockApp.getPath.mockReturnValue(path.join(exeDir, 'AC27EditorWorkshop.exe'));

    expect(getModule().resolveWorkshopBundledDllPath(null)).toBe(expected);
  });

  it('returns null when no candidate exists', () => {
    const lonelyGameRoot = tmpDir('ac27-lonely-');
    expect(getModule().resolveWorkshopBundledDllPath(lonelyGameRoot)).toBeNull();
  });
});
