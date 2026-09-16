// @vitest-environment node

/**
 * Tests for electron/livery.js — own-pack list/create/delete/read round-trip
 * on a temp gameRoot. No Electron required (pure CommonJS).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const livery = require('../../electron/livery');

// Minimal PNG buffer with a controllable IHDR size (bytes 16-23).
function pngBuffer(w, h) {
  const buf = Buffer.alloc(33);
  buf.writeUInt8(0x89, 0); buf.writeUInt8(0x50, 1); buf.writeUInt8(0x4E, 2); buf.writeUInt8(0x47, 3);
  buf.writeUInt8(0x0D, 4); buf.writeUInt8(0x0A, 5); buf.writeUInt8(0x1A, 6); buf.writeUInt8(0x0A, 7);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12);
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  buf.writeUInt8(8, 24); buf.writeUInt8(2, 25); buf.writeUInt8(0, 26); buf.writeUInt8(0, 27); buf.writeUInt8(0, 28);
  buf.writeUInt32BE(0, 29);
  return buf;
}

const png2048 = () => 'data:image/png;base64,' + pngBuffer(2048, 2048).toString('base64');

let gameRoot;
let tmpDirs = [];

function tmpGameRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'livery-test-'));
  tmpDirs.push(d);
  return d;
}

beforeEach(() => { gameRoot = tmpGameRoot(); });
afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

describe('listLiveries', () => {
  it('returns empty lists when pack dirs are missing', () => {
    expect(livery.listLiveries(gameRoot)).toEqual({ success: true, mine: [], reference: [] });
  });

  it('returns NO_GAME_ROOT without gameRoot', () => {
    expect(livery.listLiveries(null)).toEqual({ success: false, error: 'NO_GAME_ROOT' });
  });

  it('skips non-directories', () => {
    fs.mkdirSync(livery.ownPackDir(gameRoot), { recursive: true });
    fs.writeFileSync(path.join(livery.ownPackDir(gameRoot), 'stray.txt'), 'x');
    const res = livery.listLiveries(gameRoot);
    expect(res.success).toBe(true);
    expect(res.mine).toEqual([]);
  });

  it('tolerates corrupt manifests without aborting', () => {
    const dir = path.join(livery.ownPackDir(gameRoot), 'A20N_CCA');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'aircraft_livery_manifest.json'), '{not json');
    fs.writeFileSync(path.join(dir, 'base.png'), pngBuffer(2048, 2048));
    const res = livery.listLiveries(gameRoot);
    expect(res.success).toBe(true);
    expect(res.mine).toHaveLength(1);
    expect(res.mine[0].error).toBe('BAD_MANIFEST');
    expect(res.mine[0].hasBasePng).toBe(true);
  });
});

describe('createLivery round-trip', () => {
  const payload = (overrides = {}) => ({
    imageDataUrl: png2048(),
    airline: 'CCA',
    targetPlaneId: 'AIRBUS A-320neo',
    folder: 'A20N_CCA',
    ...overrides,
  });

  it('creates pack dir, writes base.png + manifest, lists and reads back', () => {
    const created = livery.createLivery(gameRoot, payload());
    expect(created).toEqual({ success: true, folder: 'A20N_CCA' });

    // Manifest on disk matches the template.
    const manifest = JSON.parse(fs.readFileSync(
      path.join(gameRoot, 'Mods', 'AC27 Custom Liveries', 'A20N_CCA', 'aircraft_livery_manifest.json'), 'utf-8'));
    expect(manifest).toEqual({
      id: 'a20n_cca_default',
      name: 'A20N CCA Default Livery',
      airline: 'CCA',
      targetPlaneId: 'AIRBUS A-320neo',
      liveryType: 'airline',
      liverySource: 'user',
      targetModelVer: '1',
      parts: [{ partName: 'Body', textures: [{ property: 'BaseMap', fileName: 'base.png' }] }],
    });

    const listed = livery.listLiveries(gameRoot);
    expect(listed.mine).toHaveLength(1);
    expect(listed.mine[0]).toMatchObject({
      folder: 'A20N_CCA',
      id: 'a20n_cca_default',
      airline: 'CCA',
      targetPlaneId: 'AIRBUS A-320neo',
      hasBasePng: true,
    });

    const read = livery.readLiveryImage(gameRoot, 'A20N_CCA', 'mine');
    expect(read.success).toBe(true);
    expect(read.imageDataUrl).toBe(payload().imageDataUrl);
  });

  it('accepts a free-form folder name verbatim', () => {
    const created = livery.createLivery(gameRoot, payload({ folder: 'My First Livery 01' }));
    expect(created).toEqual({ success: true, folder: 'My First Livery 01' });

    const manifest = JSON.parse(fs.readFileSync(
      path.join(gameRoot, 'Mods', 'AC27 Custom Liveries', 'My First Livery 01', 'aircraft_livery_manifest.json'), 'utf-8'));
    // Manifest keeps the structured parts; only the id derives from the folder.
    expect(manifest).toMatchObject({
      id: 'my_first_livery_01_default',
      name: 'A20N CCA Default Livery',
      airline: 'CCA',
      targetPlaneId: 'AIRBUS A-320neo',
    });

    const listed = livery.listLiveries(gameRoot);
    expect(listed.mine).toHaveLength(1);
    expect(listed.mine[0]).toMatchObject({ folder: 'My First Livery 01', airline: 'CCA' });
    expect(livery.readLiveryImage(gameRoot, 'My First Livery 01', 'mine').success).toBe(true);
  });

  it('rejects filesystem-unsafe folder names', () => {
    for (const folder of ['', '   ', '../evil', 'a/b', 'a\\b', 'a:b', '.hidden', 'trailing.', 'x'.repeat(65)]) {
      expect(livery.createLivery(gameRoot, payload({ folder })).error).toBe('BAD_FOLDER');
    }
    expect(livery.createLivery(gameRoot, payload({ folder: undefined })).error).toBe('BAD_FOLDER');
  });

  it('silently overwrites without .bak', () => {
    expect(livery.createLivery(gameRoot, payload()).success).toBe(true);
    expect(livery.createLivery(gameRoot, payload()).success).toBe(true);
    const dir = path.join(gameRoot, 'Mods', 'AC27 Custom Liveries', 'A20N_CCA');
    expect(fs.existsSync(path.join(dir, 'base.png.bak'))).toBe(false);
    expect(fs.readdirSync(dir).sort()).toEqual(['aircraft_livery_manifest.json', 'base.png']);
  });

  it('rejects bad airline / plane / image', () => {
    expect(livery.createLivery(gameRoot, { ...payload(), airline: 'cc' }).error).toBe('BAD_AIRLINE');
    expect(livery.createLivery(gameRoot, { ...payload(), airline: 'C/CA' }).error).toBe('BAD_AIRLINE');
    // Unknown plane id (the short code is derived from it, never sent).
    expect(livery.createLivery(gameRoot, { ...payload(), targetPlaneId: 'NOPE' }).error).toBe('BAD_PLANE');
    expect(livery.createLivery(gameRoot, { ...payload(), targetPlaneId: '' }).error).toBe('BAD_PLANE');
    expect(livery.createLivery(gameRoot, { ...payload(), imageDataUrl: 'not-a-data-url' }).error).toBe('BAD_IMAGE');
    expect(livery.createLivery(null, payload()).error).toBe('NO_GAME_ROOT');
  });

  it('rejects non-2048 IHDR dimensions', () => {
    const small = 'data:image/png;base64,' + pngBuffer(1024, 1024).toString('base64');
    expect(livery.createLivery(gameRoot, { ...payload(), imageDataUrl: small }).error).toBe('BAD_IMAGE_DIMENSIONS');
    const junk = 'data:image/png;base64,' + Buffer.from('hello world, not a png').toString('base64');
    expect(livery.createLivery(gameRoot, { ...payload(), imageDataUrl: junk }).error).toBe('BAD_IMAGE_DIMENSIONS');
  });
});

describe('traversal rejection', () => {
  it('delete/read reject ../ escapes', () => {
    expect(livery.deleteLivery(gameRoot, '../evil').error).toBe('BAD_FOLDER');
    expect(livery.deleteLivery(gameRoot, '..').error).toBe('BAD_FOLDER');
    expect(livery.readLiveryImage(gameRoot, '../evil', 'mine').error).toBe('BAD_FOLDER');
    // Contained but missing subpath → passes containment, fails the read.
    expect(livery.readLiveryImage(gameRoot, 'a/b', 'mine').error).toBe('IMAGE_MISSING');
  });

  it('containmentCheck pins to the pack dir', () => {
    const pack = livery.ownPackDir(gameRoot);
    expect(livery.containmentCheck(pack, 'A20N_CCA')).toBe(path.resolve(pack, 'A20N_CCA'));
    expect(livery.containmentCheck(pack, '../x')).toBeNull();
    expect(livery.containmentCheck(pack, '')).toBeNull();
  });
});

describe('deleteLivery', () => {
  it('removes the own-pack folder', () => {
    livery.createLivery(gameRoot, {
      imageDataUrl: png2048(), airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo',
      folder: 'A20N_CCA',
    });
    expect(livery.deleteLivery(gameRoot, 'A20N_CCA')).toEqual({ success: true });
    expect(livery.listLiveries(gameRoot).mine).toEqual([]);
  });

  it('never touches the reference pack', () => {
    // Seed a reference folder with the same name.
    const refDir = path.join(livery.referencePackDir(gameRoot), 'A20N_CCA');
    fs.mkdirSync(refDir, { recursive: true });
    fs.writeFileSync(path.join(refDir, 'base.png'), pngBuffer(2048, 2048));
    livery.createLivery(gameRoot, {
      imageDataUrl: png2048(), airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo',
      folder: 'A20N_CCA',
    });
    expect(livery.deleteLivery(gameRoot, 'A20N_CCA')).toEqual({ success: true });
    // Reference folder survives; reference read still works.
    expect(fs.existsSync(refDir)).toBe(true);
    expect(livery.readLiveryImage(gameRoot, 'A20N_CCA', 'reference').success).toBe(true);
    expect(livery.listLiveries(gameRoot).reference).toHaveLength(1);
  });
});

describe('pngSize', () => {
  it('reads IHDR width/height at bytes 16-23', () => {
    expect(livery.pngSize(pngBuffer(2048, 2048))).toEqual({ width: 2048, height: 2048 });
    expect(livery.pngSize(pngBuffer(100, 200))).toEqual({ width: 100, height: 200 });
    expect(livery.pngSize(Buffer.from('junk'))).toBeNull();
    expect(livery.pngSize(null)).toBeNull();
  });
});

describe('readDiskImage', () => {
  it('returns data-URLs by extension and rejects others', () => {
    const pngPath = path.join(gameRoot, 'a.png');
    const jpgPath = path.join(gameRoot, 'b.jpg');
    const txtPath = path.join(gameRoot, 'c.txt');
    fs.writeFileSync(pngPath, pngBuffer(10, 10));
    fs.writeFileSync(jpgPath, Buffer.from([0xff, 0xd8, 0xff]));
    fs.writeFileSync(txtPath, 'x');
    expect(livery.readDiskImage(pngPath).imageDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(livery.readDiskImage(jpgPath).imageDataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(livery.readDiskImage(txtPath).error).toBe('BAD_IMAGE');
    expect(livery.readDiskImage(path.join(gameRoot, 'missing.png')).error).toBe('IMAGE_MISSING');
  });
});

describe('share round-trip (export → delete → load-zip)', () => {
  const payload = {
    imageDataUrl: png2048(),
    airline: 'CCA',
    targetPlaneId: 'AIRBUS A-320neo',
    folder: 'A20N_CCA',
  };

  it('round-trips pixel-identical base.png + deep-equal manifest', () => {
    expect(livery.createLivery(gameRoot, payload).success).toBe(true);
    const dir = path.join(gameRoot, 'Mods', 'AC27 Custom Liveries', 'A20N_CCA');
    const manifestRaw0 = fs.readFileSync(path.join(dir, 'aircraft_livery_manifest.json'), 'utf-8');
    const png0 = fs.readFileSync(path.join(dir, 'base.png'));

    const exp = livery.exportLivery(gameRoot, 'A20N_CCA');
    expect(exp.success).toBe(true);
    expect(exp.filePath.endsWith('A20N_CCA.zip')).toBe(true);
    expect(fs.existsSync(exp.filePath)).toBe(true);
    // Share contract: folder-prefixed entries unzip straight into the pack dir.
    const { listZipFiles } = require('../../src/utils/zipUtils');
    expect(listZipFiles(exp.filePath).sort()).toEqual([
      'A20N_CCA/aircraft_livery_manifest.json',
      'A20N_CCA/base.png',
    ]);

    const destZip = path.join(gameRoot, 'shared.zip');
    const copied = livery.copyExportedZip(exp.filePath, destZip);
    expect(copied).toEqual({ success: true, filePath: destZip });
    // Temp export dir cleaned up.
    expect(fs.existsSync(path.dirname(exp.filePath))).toBe(false);

    expect(livery.deleteLivery(gameRoot, 'A20N_CCA').success).toBe(true);
    expect(livery.listLiveries(gameRoot).mine).toEqual([]);

    const loaded = livery.loadLiveryZip(destZip);
    expect(loaded.success).toBe(true);
    expect(loaded.folder).toBe('A20N_CCA');
    expect(loaded.shortCode).toBe('A20N');
    expect(loaded.manifest).toEqual(JSON.parse(manifestRaw0));
    expect(loaded.imageDataUrl).toBe('data:image/png;base64,' + png0.toString('base64'));
  });

  it('derives shortCode from the manifest for free-form zip folders', () => {
    const { createZip } = require('../../src/utils/zipUtils');
    expect(livery.createLivery(gameRoot, {
      imageDataUrl: png2048(), airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo',
      folder: 'My Custom Livery',
    }).success).toBe(true);
    const dir = path.join(gameRoot, 'Mods', 'AC27 Custom Liveries', 'My Custom Livery');
    const zipPath = path.join(gameRoot, 'custom.zip');
    createZip([
      { name: 'My Custom Livery/aircraft_livery_manifest.json', data: fs.readFileSync(path.join(dir, 'aircraft_livery_manifest.json')) },
      { name: 'My Custom Livery/base.png', data: fs.readFileSync(path.join(dir, 'base.png')) },
    ], zipPath);
    const loaded = livery.loadLiveryZip(zipPath);
    expect(loaded.success).toBe(true);
    expect(loaded.folder).toBe('My Custom Livery');
    expect(loaded.shortCode).toBe('A20N');
  });

  it('rejects bad export/load inputs', () => {
    expect(livery.exportLivery(gameRoot, 'NOPE_XXX').error).toBeDefined();
    expect(livery.exportLivery(gameRoot, '../evil').error).toBe('BAD_FOLDER');
    expect(livery.exportLivery(null, 'A20N_CCA').error).toBe('NO_GAME_ROOT');
    expect(livery.copyExportedZip(path.join(gameRoot, 'missing.zip'), path.join(gameRoot, 'o.zip')).error).toBe('ZIP_MISSING');
    expect(livery.loadLiveryZip(path.join(gameRoot, 'missing.zip')).error).toBe('ZIP_MISSING');
    const notZip = path.join(gameRoot, 'plain.txt');
    fs.writeFileSync(notZip, 'hello');
    expect(livery.loadLiveryZip(notZip).error).toBe('BAD_ZIP');
  });

  it('rejects zips without a manifest', () => {
    const { createZip } = require('../../src/utils/zipUtils');
    const zipPath = path.join(gameRoot, 'empty.zip');
    createZip([{ name: 'readme.txt', data: Buffer.from('hi') }], zipPath);
    expect(livery.loadLiveryZip(zipPath).error).toBe('BAD_ZIP');
  });
});
