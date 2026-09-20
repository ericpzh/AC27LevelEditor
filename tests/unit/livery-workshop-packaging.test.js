// @vitest-environment node

/**
 * Tests for the Workshop content packaging in electron/livery.js —
 * buildWorkshopContent / buildWorkshopPreview (plan.md §4, M3).
 * No Electron required: the preview falls back to raw bytes in node.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const livery = require('../../electron/livery');

function pngBuffer(w, h) {
  const buf = Buffer.alloc(33);
  buf.writeUInt8(0x89, 0); buf.writeUInt8(0x50, 1); buf.writeUInt8(0x4E, 2); buf.writeUInt8(0x47, 3);
  buf.writeUInt8(0x0D, 4); buf.writeUInt8(0x0A, 5); buf.writeUInt8(0x1A, 6); buf.writeUInt8(0x0A, 7);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12);
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

const png2048 = () => 'data:image/png;base64,' + pngBuffer(2048, 2048).toString('base64');

let gameRoot;
let tmpDirs = [];

function tmpGameRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'livery-ws-pack-'));
  tmpDirs.push(d);
  return d;
}

function seedLivery(root, folder = 'A20N_CCA') {
  const res = livery.createLivery(root, {
    imageDataUrl: png2048(), airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo', folder,
  });
  expect(res.success).toBe(true);
  return path.join(livery.ownPackDir(root), folder);
}

beforeEach(() => { gameRoot = tmpGameRoot(); });
afterEach(() => {
  livery._resetNativeImageForTests();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

describe('workshopModName', () => {
  it('derives a stable unique modName from the folder', () => {
    expect(livery.workshopModName('A20N_CCA')).toBe('AC27_a20n_cca');
    expect(livery.workshopModName('My Cool Livery!')).toBe('AC27_my_cool_livery');
    expect(livery.workshopModName('')).toBe('AC27_livery');
  });
});

describe('buildWorkshopContent', () => {
  it('throws coded errors for bad inputs', () => {
    expect(() => livery.buildWorkshopContent(null, 'X')).toThrowError(expect.objectContaining({ code: 'NO_GAME_ROOT' }));
    expect(() => livery.buildWorkshopContent(gameRoot, 'missing')).toThrowError(expect.objectContaining({ code: 'BAD_FOLDER' }));
    const dir = path.join(livery.ownPackDir(gameRoot), 'broken');
    fs.mkdirSync(dir, { recursive: true });
    expect(() => livery.buildWorkshopContent(gameRoot, 'broken')).toThrowError(expect.objectContaining({ code: 'NO_MANIFEST' }));
    const noimg = path.join(livery.ownPackDir(gameRoot), 'noimg');
    fs.mkdirSync(noimg, { recursive: true });
    fs.writeFileSync(path.join(noimg, 'aircraft_livery_manifest.json'), JSON.stringify({ id: 'x' }));
    expect(() => livery.buildWorkshopContent(gameRoot, 'noimg')).toThrowError(expect.objectContaining({ code: 'IMAGE_MISSING' }));
  });

  it('ships the ENTIRE livery folder verbatim (only the sidecar excluded) + mod_info', () => {
    const srcDir = seedLivery(gameRoot);
    // The editor's local bookkeeping is never mod content. Everything else in
    // the folder — extra files and subdirectories — travels as-is.
    fs.writeFileSync(path.join(srcDir, '.workshop.json'), JSON.stringify({ publishedFileId: '1' }));
    fs.writeFileSync(path.join(srcDir, '.workshop-preview.png'), pngBuffer(64, 64));
    fs.writeFileSync(path.join(srcDir, 'notes.txt'), 'hello');
    fs.mkdirSync(path.join(srcDir, 'extras'));
    fs.writeFileSync(path.join(srcDir, 'extras', 'readme.md'), 'extra asset');
    const srcManifest = fs.readFileSync(path.join(srcDir, 'aircraft_livery_manifest.json'));
    const srcBase = fs.readFileSync(path.join(srcDir, 'base.png'));

    const { dir, cleanup } = livery.buildWorkshopContent(gameRoot, 'A20N_CCA');
    try {
      expect(fs.existsSync(dir)).toBe(true);
      const entries = fs.readdirSync(dir).sort();
      expect(entries).toEqual(['aircraft_livery_manifest.json', 'base.png', 'extras', 'mod_info.json', 'notes.txt']);
      expect(fs.existsSync(path.join(dir, '.workshop.json'))).toBe(false);
      expect(fs.existsSync(path.join(dir, '.workshop-preview.png'))).toBe(false);
      expect(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf-8')).toBe('hello');
      expect(fs.readFileSync(path.join(dir, 'extras', 'readme.md'), 'utf-8')).toBe('extra asset');
      expect(fs.readFileSync(path.join(dir, 'aircraft_livery_manifest.json'))).toEqual(srcManifest);
      expect(fs.readFileSync(path.join(dir, 'base.png'))).toEqual(srcBase);
      const modInfo = JSON.parse(fs.readFileSync(path.join(dir, 'mod_info.json'), 'utf-8'));
      expect(modInfo.modName).toBe('AC27_a20n_cca');
    } finally {
      cleanup();
    }
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('does not count the saved preview as a texture', () => {
    const dir = path.join(livery.ownPackDir(gameRoot), 'previewonly');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'aircraft_livery_manifest.json'), JSON.stringify({ id: 'x' }));
    fs.writeFileSync(path.join(dir, '.workshop-preview.png'), pngBuffer(64, 64));
    expect(() => livery.buildWorkshopContent(gameRoot, 'previewonly'))
      .toThrowError(expect.objectContaining({ code: 'IMAGE_MISSING' }));
  });

  it('packs every texture of a multi-part livery', () => {
    const multi = {
      images: [
        { partName: 'Fuselage', imageDataUrl: png2048() },
        { partName: 'Wing', imageDataUrl: png2048() },
      ],
      airline: 'CCA', targetPlaneId: 'AIRBUS A-380-800', folder: 'A388_CCA',
    };
    // A388 is not in the short-code table and has no built-in dir here, so
    // seed the folder manually with two textures + a two-part manifest.
    const dir = path.join(livery.ownPackDir(gameRoot), 'A388_CCA');
    fs.mkdirSync(dir, { recursive: true });
    const manifest = livery.buildManifest({
      folder: 'A388_CCA', shortCode: 'A388', airline: 'CCA',
      targetPlaneId: 'AIRBUS A-380-800',
      parts: multi.images.map(im => ({ partName: im.partName, fileName: `base_${im.partName}.png` })),
    });
    fs.writeFileSync(path.join(dir, 'aircraft_livery_manifest.json'), JSON.stringify(manifest));
    for (const im of multi.images) {
      fs.writeFileSync(path.join(dir, `base_${im.partName}.png`), Buffer.from(im.imageDataUrl.split(',')[1], 'base64'));
    }
    const built = livery.buildWorkshopContent(gameRoot, 'A388_CCA');
    try {
      const entries = fs.readdirSync(built.dir).sort();
      expect(entries).toEqual(['aircraft_livery_manifest.json', 'base_Fuselage.png', 'base_Wing.png', 'mod_info.json']);
    } finally {
      built.cleanup();
    }
  });
});

describe('buildWorkshopPreview', () => {
  it('throws coded errors for bad inputs', () => {
    expect(() => livery.buildWorkshopPreview(null, 'X')).toThrowError(expect.objectContaining({ code: 'NO_GAME_ROOT' }));
    expect(() => livery.buildWorkshopPreview(gameRoot, 'missing')).toThrowError(expect.objectContaining({ code: 'BAD_FOLDER' }));
    const dir = path.join(livery.ownPackDir(gameRoot), 'empty');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'aircraft_livery_manifest.json'), JSON.stringify({ id: 'x', parts: [] }));
    expect(() => livery.buildWorkshopPreview(gameRoot, 'empty')).toThrowError(expect.objectContaining({ code: 'NO_PREVIEW' }));
  });

  it('writes a preview file and cleans it up', () => {
    seedLivery(gameRoot);
    const { path: previewPath, cleanup } = livery.buildWorkshopPreview(gameRoot, 'A20N_CCA');
    try {
      expect(fs.existsSync(previewPath)).toBe(true);
      expect(fs.statSync(previewPath).size).toBeGreaterThan(0);
      // Node fallback (no Electron nativeImage): raw texture bytes.
      expect(['.png', '.jpg']).toContain(path.extname(previewPath));
    } finally {
      cleanup();
    }
    expect(fs.existsSync(path.dirname(previewPath))).toBe(false);
  });

  it('renders a resized JPEG when nativeImage is available', () => {
    seedLivery(gameRoot);
    const resizes = [];
    const qualities = [];
    const fakeImg = {
      isEmpty: () => false,
      getSize: () => ({ width: 2048, height: 2048 }),
      resize: (opts) => { resizes.push(opts); return fakeImg; },
      toJPEG: (q) => { qualities.push(q); return Buffer.from('fake-jpeg-bytes'); },
    };
    livery._setNativeImageForTests({ createFromBuffer: () => fakeImg });

    const { path: previewPath, cleanup } = livery.buildWorkshopPreview(gameRoot, 'A20N_CCA', 1024);
    try {
      expect(path.extname(previewPath)).toBe('.jpg');
      expect(fs.readFileSync(previewPath, 'utf-8')).toBe('fake-jpeg-bytes');
      expect(resizes).toEqual([{ width: 1024, quality: 'best' }]);
      expect(qualities).toEqual([85]);
    } finally {
      cleanup();
    }
    expect(fs.existsSync(previewPath)).toBe(false);
  });
});

describe('ensurePreviewUnderLimit', () => {
  afterEach(() => livery._resetNativeImageForTests());

  it('leaves a sub-1MiB file untouched', () => {
    const p = path.join(gameRoot, 'small.jpg');
    fs.writeFileSync(p, Buffer.alloc(1024));
    const res = livery.ensurePreviewUnderLimit(p);
    expect(res.path).toBe(p);
    expect(res.cleanup).toBeNull();
  });

  it('re-encodes an over-limit image below the cap and cleans up', () => {
    const fakeImg = {
      isEmpty: () => false,
      getSize: () => ({ width: 2000, height: 1000 }),
      resize: () => fakeImg,
      toJPEG: () => Buffer.alloc(600 * 1024),
    };
    livery._setNativeImageForTests({ createFromBuffer: () => fakeImg });
    const p = path.join(gameRoot, 'big.png');
    fs.writeFileSync(p, Buffer.alloc(2 * 1024 * 1024));
    const res = livery.ensurePreviewUnderLimit(p);
    try {
      expect(res.path).not.toBe(p);
      expect(fs.statSync(res.path).size).toBeLessThan(livery.WORKSHOP_PREVIEW_MAX_BYTES);
    } finally {
      if (res.cleanup) res.cleanup();
    }
    expect(fs.existsSync(res.path)).toBe(false);
  });

  it('returns the original when the image cannot be decoded', () => {
    livery._setNativeImageForTests(null);
    const p = path.join(gameRoot, 'big2.png');
    fs.writeFileSync(p, Buffer.alloc(2 * 1024 * 1024));
    const res = livery.ensurePreviewUnderLimit(p);
    expect(res.path).toBe(p);
    expect(res.cleanup).toBeNull();
  });
});
