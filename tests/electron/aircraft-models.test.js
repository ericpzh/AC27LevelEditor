// @vitest-environment node

/**
 * Tests for electron/aircraftModels.js — pack readiness, read, cleanup, the
 * pure-JS extractor path and the Python/UnityPy last-resort fallback.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';

const models = require('../../electron/aircraftModels');

let userData;
let gameRoot;
const tmpDirs = [];

function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function writePack(dir, version = models.PACK_VERSION, planeId = 'AIRBUS A-350-900') {
  const pack = path.join(dir, 'livery-3d-models', 'pack');
  fs.mkdirSync(pack, { recursive: true });
  fs.writeFileSync(path.join(pack, 'a350.bin'), Buffer.from([1, 2, 3, 4]));
  fs.writeFileSync(path.join(pack, 'manifest.json'), JSON.stringify({
    version,
    planes: { [planeId]: { bin: 'a350.bin', parts: [{ name: 'Body', livery: true, vertexCount: 1, indexCount: 0 }] } },
  }));
}

/** A fake JS extractor that writes a pack (standing in for the real reader). */
function fakeExtract() {
  return vi.fn(async ({ outDir }) => {
    fs.writeFileSync(path.join(outDir, 'a350.bin'), Buffer.from([1, 2, 3, 4]));
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
      version: models.PACK_VERSION,
      planes: { 'AIRBUS A-350-900': { bin: 'a350.bin', parts: [{ name: 'Body', livery: true, vertexCount: 1, indexCount: 0 }] } },
    }));
    return { planes: 1, parts: 1, bytes: 4 };
  });
}

beforeEach(() => {
  userData = tmpDir('ac27-3d-user-');
  gameRoot = tmpDir('ac27-3d-game-');
  fs.mkdirSync(path.join(gameRoot, 'GroundATC_Data', 'StreamingAssets'), { recursive: true });
  // resolveDataRoot returns <root>/GroundATC_Data; resources.assets sits there.
  fs.writeFileSync(path.join(gameRoot, 'GroundATC_Data', 'resources.assets'), Buffer.from('x'));
  models._resetPythonCacheForTests();
});

afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe('readManifest / isReady', () => {
  it('is not ready with no pack', () => {
    expect(models.readManifest(userData)).toBeNull();
    expect(models.isReady(userData)).toBe(false);
  });

  it('rejects a wrong pack version', () => {
    writePack(userData, 999);
    expect(models.isReady(userData)).toBe(false);
  });

  it('rejects the previous cache version (forces a rebuild)', () => {
    writePack(userData, 1);
    expect(models.isReady(userData)).toBe(false);
  });

  it('reads a valid pack', () => {
    writePack(userData);
    const m = models.readManifest(userData);
    expect(m.version).toBe(models.PACK_VERSION);
    expect(m.planes['AIRBUS A-350-900'].bin).toBe('a350.bin');
    expect(models.isReady(userData)).toBe(true);
  });
});

describe('readModel', () => {
  it('errors when the pack is missing', () => {
    expect(models.readModel(userData, 'AIRBUS A-350-900')).toEqual({ success: false, error: 'NOT_READY' });
  });

  it('returns the binary + parts for a known plane', () => {
    writePack(userData);
    const res = models.readModel(userData, 'AIRBUS A-350-900');
    expect(res.success).toBe(true);
    expect(Array.from(res.bin)).toEqual([1, 2, 3, 4]);
    expect(res.parts[0].name).toBe('Body');
  });

  it('errors for an unknown plane', () => {
    writePack(userData);
    expect(models.readModel(userData, 'NOPE').error).toBe('NO_PLANE');
  });
});

describe('cleanup', () => {
  it('removes the cache dir', () => {
    writePack(userData);
    expect(fs.existsSync(models.cacheDir(userData))).toBe(true);
    expect(models.cleanup(userData).success).toBe(true);
    expect(fs.existsSync(models.cacheDir(userData))).toBe(false);
  });
});

describe('findPython', () => {
  it('returns the first interpreter that can import UnityPy + numpy', () => {
    const run = vi.fn((cmd) => ({ status: cmd === 'python3' ? 0 : 1 }));
    const found = models.findPython(run);
    expect(found).toEqual({ cmd: 'python3', args: [] });
    expect(run).toHaveBeenCalledWith('python', expect.any(Array), expect.any(Object));
  });

  it('returns null when none import the deps', () => {
    expect(models.findPython(() => ({ status: 1 }))).toBeNull();
  });
});

describe('ensure', () => {
  function fakeSpawn(onWrite) {
    return vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        if (onWrite) onWrite();
        child.emit('close', 0);
      });
      return child;
    });
  }

  it('returns NO_GAME_ROOT without a root', async () => {
    const res = await models.ensure({ userData, gameRoot: null, extractImpl: fakeExtract() });
    expect(res.error).toBe('NO_GAME_ROOT');
  });

  it('short-circuits when the pack is already cached', async () => {
    writePack(userData);
    const extractImpl = vi.fn();
    const res = await models.ensure({ userData, gameRoot, extractImpl });
    expect(res).toEqual({ success: true, cached: true });
    expect(extractImpl).not.toHaveBeenCalled();
  });

  it('builds the pack with the pure-JS extractor', async () => {
    const extractImpl = fakeExtract();
    const logs = [];
    const res = await models.ensure({ userData, gameRoot, extractImpl, onLog: (s) => logs.push(s) });
    expect(res).toEqual({ success: true, cached: false });
    expect(extractImpl).toHaveBeenCalledTimes(1);
    expect(extractImpl.mock.calls[0][0].assetsPath).toBe(path.join(gameRoot, 'GroundATC_Data', 'resources.assets'));
    expect(models.isReady(userData)).toBe(true);
  });

  it('falls back to Python when the JS extractor throws', async () => {
    const scriptPath = path.join(userData, 'extract-aircraft-models.py');
    fs.writeFileSync(scriptPath, '# fake');
    const extractImpl = vi.fn(async () => { throw new Error('stripped typetree mismatch'); });
    const spawnImpl = fakeSpawn(() => writePack(userData));
    const logs = [];
    const res = await models.ensure({
      userData, gameRoot, scriptPath, extractImpl,
      findPythonImpl: () => ({ cmd: 'python', args: [] }),
      spawnImpl,
      onLog: (s) => logs.push(s),
    });
    expect(res).toEqual({ success: true, cached: false });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(logs.join('')).toContain('falling back to python');
  });

  it('returns NO_PYTHON when the JS extractor fails and no interpreter exists', async () => {
    const extractImpl = vi.fn(async () => { throw new Error('boom'); });
    const res = await models.ensure({ userData, gameRoot, extractImpl, findPythonImpl: () => null });
    expect(res.success).toBe(false);
    expect(res.error).toBe('NO_PYTHON');
    expect(res.detail).toContain('boom');
  });

  it('reports EXTRACT_FAILED when the Python fallback exits non-zero', async () => {
    const scriptPath = path.join(userData, 'extract-aircraft-models.py');
    fs.writeFileSync(scriptPath, '# fake');
    const extractImpl = vi.fn(async () => { throw new Error('js fail'); });
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => { child.stderr.emit('data', Buffer.from('boom')); child.emit('close', 1); });
      return child;
    });
    const res = await models.ensure({
      userData, gameRoot, scriptPath, extractImpl,
      findPythonImpl: () => ({ cmd: 'python', args: [] }),
      spawnImpl,
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe('EXTRACT_FAILED');
    expect(res.detail).toContain('boom');
  });

  it('treats a zero-plane JS result as a failure and discards the pack', async () => {
    const extractImpl = vi.fn(async ({ outDir }) => {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ version: models.PACK_VERSION, planes: {} }));
      return { planes: 0, parts: 0, bytes: 0 };
    });
    const res = await models.ensure({ userData, gameRoot, extractImpl, findPythonImpl: () => null });
    expect(res.success).toBe(false);
    expect(res.error).toBe('NO_PYTHON');
    expect(models.isReady(userData)).toBe(false);
  });
});
