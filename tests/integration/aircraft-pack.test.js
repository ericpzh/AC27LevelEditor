/**
 * End-to-end coverage for the pure-JS aircraft-pack extractor against a REAL
 * game install. Skipped when no install is found, so CI (and machines without
 * the game) just skip it. Point it at a non-default install with:
 *
 *   AC27_GAME_ASSETS="D:/.../GroundATC_Data/resources.assets" \
 *     npx vitest run tests/integration/aircraft-pack.test.js
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const pack = require('../../electron/unity/aircraftPack');
const models = require('../../electron/aircraftModels');

function findInstall() {
  if (process.env.AC27_GAME_ASSETS && fs.existsSync(process.env.AC27_GAME_ASSETS)) {
    const assets = process.env.AC27_GAME_ASSETS;
    const dataRoot = path.dirname(assets);
    return { assets, gameRoot: path.basename(dataRoot) === 'GroundATC_Data' ? path.dirname(dataRoot) : dataRoot };
  }
  const roots = [
    'D:/SteamLibrary/steamapps/common/Airport Control 27',
    'C:/Program Files (x86)/Steam/steamapps/common/Airport Control 27',
    'C:/Program Files/Steam/steamapps/common/Airport Control 27',
  ];
  for (const root of roots) {
    const win = path.join(root, 'GroundATC_Data', 'resources.assets');
    if (fs.existsSync(win)) return { assets: win, gameRoot: root };
    const mac = path.join(root, 'GroundATC.app', 'Contents', 'Resources', 'Data', 'resources.assets');
    if (fs.existsSync(mac)) return { assets: mac, gameRoot: path.join(root, 'GroundATC.app') };
  }
  return null;
}

const install = findInstall();
const assetsPath = install && install.assets;
const maybe = install ? describe : describe.skip;
const dirs = [];

afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

maybe('aircraft pack extraction (real install)', () => {
  it('builds every plane with sane geometry', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-pack-'));
    dirs.push(outDir);
    const result = await pack.extract({ assetsPath, outDir });

    expect(result.planes).toBe(Object.keys(pack.PLANES).length);
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
    expect(manifest.version).toBe(models.PACK_VERSION);
    for (const planeId of Object.keys(pack.PLANES)) {
      const entry = manifest.planes[planeId];
      expect(entry, planeId).toBeTruthy();
      expect(entry.parts.length, planeId).toBeGreaterThan(0);
      const expectedBin = entry.parts.reduce((n, p) => n + p.vertexCount * 12 + p.vertexCount * 8 + p.indexCount * 4, 0);
      expect(fs.statSync(path.join(outDir, entry.bin)).size, planeId).toBe(expectedBin);
      for (const part of entry.parts) {
        expect(part.vertexCount, `${planeId}/${part.name}`).toBeGreaterThan(0);
        expect(part.indexCount % 3, `${planeId}/${part.name}`).toBe(0);
      }
    }
  });

  it('extracts compressed meshes (737 MAX 8) and multi-part liveries', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-pack-'));
    dirs.push(outDir);
    const { manifest } = await pack.extract({ assetsPath, outDir });

    const max = manifest.planes['BOEING 737 MAX 8'];
    // The MAX ships two livery parts (Fuselage + Wingtip) plus the grey fan.
    expect(max.parts.map((p) => p.name)).toEqual(['Fuselage', 'Wingtip', '_static']);
    expect(max.parts.filter((p) => p.livery).map((p) => p.name)).toEqual(['Fuselage', 'Wingtip']);
    expect(max.parts[0].vertexCount).toBeGreaterThan(1000);
    expect(max.parts[1].vertexCount).toBeGreaterThan(1000);

    const a359 = manifest.planes['AIRBUS A-350-900'];
    expect(a359.parts.filter((p) => p.livery).map((p) => p.name)).toEqual(['Body']);
    expect(a359.parts.filter((p) => !p.livery).length).toBe(3);
  });

  it('plugs into aircraftModels.ensure/readModel', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-3d-user-'));
    dirs.push(userData);

    const res = await models.ensure({ userData, gameRoot: install.gameRoot });
    expect(res.success).toBe(true);
    expect(models.isReady(userData)).toBe(true);

    const model = models.readModel(userData, 'AIRBUS A-350-900');
    expect(model.success).toBe(true);
    expect(model.parts.length).toBeGreaterThan(0);
    expect(model.bin.length).toBeGreaterThan(0);
  }, 30000);
});
