// @vitest-environment node

/**
 * Tests for electron/steam-workshop.js — Steam Workshop livery publish with
 * an injected fake steamworks client (no Steam, no native module required).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const steamWorkshop = require('../../electron/steam-workshop');
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
  return buf;
}

const png2048 = () => 'data:image/png;base64,' + pngBuffer(2048, 2048).toString('base64');

// Fake steamworks client. `shape: 'legacy'` returns the client from init();
// `shape: 'modern'` returns void and exposes namespaces on the module.
function makeFakeLib(opts = {}) {
  const calls = { init: [], createItem: [], updateItem: [], getItem: [] };
  const client = {
    apps: {
      isSubscribedApp: (appId) => {
        if (opts.subscribedApps && String(appId) in opts.subscribedApps) {
          return opts.subscribedApps[String(appId)];
        }
        if (opts.subscribed !== undefined) return opts.subscribed;
        return true;
      },
    },
    localplayer: {
      getName: () => (opts.playerName !== undefined ? opts.playerName : 'Tester'),
    },
    workshop: {
      createItem: async (appId) => {
        calls.createItem.push(appId);
        if (opts.createResult !== undefined) {
          if (opts.createResult instanceof Error) throw opts.createResult;
          return opts.createResult;
        }
        return { itemId: BigInt(123456789), needsToAcceptAgreement: false };
      },
      updateItemWithCallback: (itemId, details, appId, onSuccess, onError, onProgress) => {
        calls.updateItem.push({ itemId, details, appId });
        if (opts.progressEvents && onProgress) {
          for (const p of opts.progressEvents) onProgress(p);
        }
        if (opts.updateError) onError(opts.updateError);
        else onSuccess(opts.updateResult || { itemId, needsToAcceptAgreement: false });
      },
      getItem: async (itemId, cfg) => {
        calls.getItem.push({ itemId, cfg });
        if (opts.getItemError) throw opts.getItemError;
        return opts.getItemResult !== undefined ? opts.getItemResult : null;
      },
    },
  };
  const lib = {
    init: (appId) => {
      calls.init.push(appId);
      if (opts.initError) throw opts.initError;
      if (opts.initThrowCodes && String(appId) in opts.initThrowCodes) {
        const spec = opts.initThrowCodes[String(appId)];
        const err = new Error(spec.message || 'native failed');
        err.code = spec.code || 'GenericFailure';
        throw err;
      }
      if (opts.initThrowsFor && opts.initThrowsFor.map(Number).includes(Number(appId))) {
        throw new Error('ConnectToGlobalUser failed.');
      }
      return opts.shape === 'modern' ? undefined : client;
    },
  };
  if (opts.shape === 'modern') {
    lib.apps = client.apps;
    lib.localplayer = client.localplayer;
    lib.workshop = client.workshop;
  }
  return { lib, calls, client };
}

let gameRoot;
let tmpDirs = [];

function tmpGameRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
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

beforeEach(() => {
  gameRoot = tmpGameRoot();
  steamWorkshop._resetSteamworksForTests();
});

afterEach(() => {
  steamWorkshop._resetSteamworksForTests();
  livery._resetNativeImageForTests();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

describe('isAvailable', () => {
  it('reports STEAM_UNAVAILABLE without the native module', () => {
    steamWorkshop._setSteamworksForTests(null);
    expect(steamWorkshop.isAvailable()).toEqual({
      available: false, appId: '4004140', reason: 'STEAM_UNAVAILABLE',
    });
  });

  it('reports STEAM_UNAVAILABLE when init throws (Steam not running)', () => {
    steamWorkshop._setSteamworksForTests(makeFakeLib({ initError: new Error('no steam') }).lib);
    const res = steamWorkshop.isAvailable();
    expect(res.available).toBe(false);
    expect(res.reason).toBe('STEAM_UNAVAILABLE');
  });

  it('reports NO_LICENSE when the account does not own the Playtest app', () => {
    steamWorkshop._setSteamworksForTests(makeFakeLib({ subscribed: false }).lib);
    expect(steamWorkshop.isAvailable()).toEqual({
      available: false, appId: '4004140', reason: 'NO_LICENSE',
    });
  });

  it('targets the Playtest app constant for both client generations', () => {
    for (const shape of ['legacy', 'modern']) {
      steamWorkshop._resetSteamworksForTests();
      steamWorkshop._setSteamworksForTests(makeFakeLib({ shape }).lib);
      expect(steamWorkshop.isAvailable()).toEqual({ available: true, appId: '4004140' });
    }
  });

  it('inits the Playtest app exactly once — never the shipping game app', () => {
    const { lib, calls } = makeFakeLib();
    steamWorkshop._setSteamworksForTests(lib);
    expect(steamWorkshop.isAvailable()).toEqual({ available: true, appId: '4004140' });
    expect(calls.init).toEqual([4004140]);
  });

  it('publishes to the Playtest app', async () => {
    const { lib, calls } = makeFakeLib();
    steamWorkshop._setSteamworksForTests(lib);
    seedLivery(gameRoot);
    const res = await steamWorkshop.publishLivery(gameRoot, 'A20N_CCA', { title: 't' });
    expect(res.publishedFileId).toBe('123456789');
    expect(calls.createItem).toEqual([4004140]);
    const sidecar = steamWorkshop.readSidecar(path.join(livery.ownPackDir(gameRoot), 'A20N_CCA'));
    expect(sidecar.appId).toBe('4004140');
  });

  it('reports STEAM_UNAVAILABLE when target init throws (no cross-app probe)', () => {
    // Target init throws (app not owned / Steam down). No Spacewar/480
    // fallback is attempted — single init call only.
    const { lib, calls } = makeFakeLib({
      initThrowsFor: [4004140],
    });
    steamWorkshop._setSteamworksForTests(lib);
    expect(steamWorkshop.isAvailable()).toEqual({
      available: false, appId: '4004140', reason: 'STEAM_UNAVAILABLE',
    });
    expect(calls.init).toEqual([4004140]);
  });

  it('reports STEAM_UNAVAILABLE when Steam itself is down', () => {
    steamWorkshop._setSteamworksForTests({ init: () => { throw new Error('no steam'); } });
    expect(steamWorkshop.isAvailable()).toEqual({
      available: false, appId: '4004140', reason: 'STEAM_UNAVAILABLE',
    });
  });

  it('sanitizes foreign napi codes instead of leaking them', () => {
    steamWorkshop._setSteamworksForTests(makeFakeLib({
      initThrowCodes: { 99999: { code: 'GenericFailure', message: 'ConnectToGlobalUser failed.' } },
    }).lib);
    expect(steamWorkshop.isAvailable()).toEqual({ available: true, appId: '4004140' });
    try {
      steamWorkshop._getClient('99999');
      expect.unreachable();
    } catch (err) {
      expect(err.code).toBe('STEAM_UNAVAILABLE');
      expect(err.message).toContain('GenericFailure');
    }
  });

  it('toPublicError keeps the foreign code in the detail', () => {
    expect(steamWorkshop.toPublicError({ code: 'GenericFailure', message: 'boom' })).toEqual({
      error: 'UPLOAD_FAILED', detail: 'GenericFailure: boom',
    });
    expect(steamWorkshop.toPublicError({ code: 'NO_LICENSE', message: 'x' })).toEqual({
      error: 'NO_LICENSE', detail: 'x',
    });
  });
});

describe('sidecar + id parsing', () => {
  it('round-trips the sidecar', () => {
    const dir = seedLivery(gameRoot);
    const data = { appId: '3328490', publishedFileId: '123', title: 'T', visibility: 0, tags: ['Livery'] };
    expect(steamWorkshop.writeSidecar(dir, data)).toBe(true);
    expect(steamWorkshop.readSidecar(dir)).toEqual(data);
  });

  it('returns null for a missing or corrupt sidecar', () => {
    const dir = seedLivery(gameRoot);
    expect(steamWorkshop.readSidecar(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, '.workshop.json'), '{nope', 'utf-8');
    expect(steamWorkshop.readSidecar(dir)).toBeNull();
  });

  it('parses bare ids and Steam URLs', () => {
    expect(steamWorkshop.parseWorkshopId('1234567890')).toBe('1234567890');
    expect(steamWorkshop.parseWorkshopId('https://steamcommunity.com/sharedfiles/filedetails/?id=1234567890')).toBe('1234567890');
    expect(steamWorkshop.parseWorkshopId('https://steamcommunity.com/sharedfiles/filedetails/1234567890')).toBe('1234567890');
    expect(steamWorkshop.parseWorkshopId('not an id')).toBeNull();
    expect(steamWorkshop.parseWorkshopId('')).toBeNull();
  });

  it('builds the item URL', () => {
    expect(steamWorkshop.workshopItemUrl('123')).toBe('https://steamcommunity.com/sharedfiles/filedetails/?id=123');
  });
});

describe('readPublishInfo', () => {
  it('rejects without game root / folder / manifest', async () => {
    steamWorkshop._setSteamworksForTests(makeFakeLib().lib);
    expect(await steamWorkshop.readPublishInfo(null, 'X')).toEqual({ success: false, error: 'NO_GAME_ROOT' });
    expect(await steamWorkshop.readPublishInfo(gameRoot, 'missing')).toEqual({ success: false, error: 'BAD_FOLDER' });
    const dir = path.join(livery.ownPackDir(gameRoot), 'broken');
    fs.mkdirSync(dir, { recursive: true });
    expect(await steamWorkshop.readPublishInfo(gameRoot, 'broken')).toEqual({ success: false, error: 'NO_MANIFEST' });
  });

  it('falls back to manifest defaults when Steam is unavailable', async () => {
    steamWorkshop._setSteamworksForTests(null);
    seedLivery(gameRoot);
    const info = await steamWorkshop.readPublishInfo(gameRoot, 'A20N_CCA');
    expect(info.success).toBe(true);
    expect(info.available).toBe(false);
    expect(info.reason).toBe('STEAM_UNAVAILABLE');
    // No stored title: the renderer composes the localized default from the
    // airline + aircraft type fields below.
    expect(info.title).toBe('');
    expect(info.airline).toBe('CCA');
    expect(info.targetPlaneId).toBe('AIRBUS A-320neo');
    expect(info.description).toContain('AIRBUS A-320neo');
    expect(info.description).not.toContain('A20N CCA Default Livery');
    expect(info.visibility).toBe(2);
    expect(info.tags).toEqual(['Livery']);
    expect(info.publishedFileId).toBeNull();
    expect(info.previewDataUrl).toMatch(/^data:image\/(png|jpeg);base64,/);
  });

  it('prefers sidecar values over manifest defaults', async () => {
    // The item still exists on Steam (empty metadata) so the sidecar values win.
    steamWorkshop._setSteamworksForTests(makeFakeLib({ getItemResult: {} }).lib);
    const dir = seedLivery(gameRoot);
    steamWorkshop.writeSidecar(dir, {
      appId: '3328490', publishedFileId: '999', title: 'Sidecar title',
      description: 'Sidecar desc', visibility: 0, tags: ['Livery', 'Airbus'],
    });
    const info = await steamWorkshop.readPublishInfo(gameRoot, 'A20N_CCA');
    expect(info.title).toBe('Sidecar title');
    expect(info.visibility).toBe(0);
    expect(info.tags).toEqual(['Livery', 'Airbus']);
    expect(info.url).toBe('https://steamcommunity.com/sharedfiles/filedetails/?id=999');
  });

  it('prefers live Steam metadata over the sidecar', async () => {
    const { lib, calls } = makeFakeLib({
      getItemResult: {
        title: 'Live title', description: 'Live desc', visibility: 1,
        tags: ['Livery', 'Live'], url: 'https://steamcommunity.com/sharedfiles/filedetails/?id=999',
      },
    });
    steamWorkshop._setSteamworksForTests(lib);
    const dir = seedLivery(gameRoot);
    steamWorkshop.writeSidecar(dir, {
      appId: '3328490', publishedFileId: '999', title: 'Sidecar title',
      description: 'Sidecar desc', visibility: 0, tags: ['Livery'],
    });
    const info = await steamWorkshop.readPublishInfo(gameRoot, 'A20N_CCA');
    expect(calls.getItem).toHaveLength(1);
    expect(info.title).toBe('Live title');
    expect(info.description).toBe('Live desc');
    expect(info.visibility).toBe(1);
    expect(info.tags).toEqual(['Livery', 'Live']);
  });

  it('keeps sidecar values when the live lookup fails', async () => {
    steamWorkshop._setSteamworksForTests(makeFakeLib({ getItemError: new Error('gone') }).lib);
    const dir = seedLivery(gameRoot);
    steamWorkshop.writeSidecar(dir, { appId: '3328490', publishedFileId: '999', title: 'Sidecar title' });
    const info = await steamWorkshop.readPublishInfo(gameRoot, 'A20N_CCA');
    expect(info.success).toBe(true);
    expect(info.title).toBe('Sidecar title');
  });

  it('forgets a recorded id whose item was deleted on the Workshop', async () => {
    steamWorkshop._setSteamworksForTests(makeFakeLib({ getItemResult: null }).lib);
    const dir = seedLivery(gameRoot);
    steamWorkshop.writeSidecar(dir, { appId: '3328490', publishedFileId: '999', title: 'Sidecar title' });
    const info = await steamWorkshop.readPublishInfo(gameRoot, 'A20N_CCA');
    expect(info.success).toBe(true);
    expect(info.publishedFileId).toBeNull();
    expect(info.url).toBeNull();
    // Other sidecar values still prefill so the dialog opens normally.
    expect(info.title).toBe('Sidecar title');
  });
});

describe('publishLivery', () => {
  it('creates a new item on first upload, then updates it', async () => {
    const { lib, calls } = makeFakeLib();
    steamWorkshop._setSteamworksForTests(lib);
    seedLivery(gameRoot);
    const seen = [];
    const res = await steamWorkshop.publishLivery(gameRoot, 'A20N_CCA', {
      title: 'My livery', description: 'desc', visibility: 0, tags: ['Airbus'], changeNote: '',
    }, (p) => seen.push(p));
    expect(res).toEqual({
      publishedFileId: '123456789',
      url: 'https://steamcommunity.com/sharedfiles/filedetails/?id=123456789',
    });
    expect(calls.createItem).toEqual([4004140]);
    expect(calls.updateItem).toHaveLength(1);
    const up = calls.updateItem[0];
    expect(String(up.itemId)).toBe('123456789');
    expect(up.appId).toBe(4004140);
    expect(up.details.title).toBe('My livery');
    expect(up.details.tags).toEqual(['Livery', 'Airbus']);
    expect(up.details.visibility).toBe(0);
    expect(fs.existsSync(up.details.contentPath)).toBe(false); // temp cleaned
    expect(fs.existsSync(up.details.previewPath)).toBe(false); // generated preview cleaned
    const sidecar = steamWorkshop.readSidecar(path.join(livery.ownPackDir(gameRoot), 'A20N_CCA'));
    expect(sidecar.publishedFileId).toBe('123456789');
    expect(sidecar.title).toBe('My livery');
    expect(sidecar.lastUploadedAt).toBeTruthy();
  });

  it('updates the same item on a second publish without creating', async () => {
    const { lib, calls } = makeFakeLib({ getItemResult: { publishedFileId: BigInt(555) } });
    steamWorkshop._setSteamworksForTests(lib);
    const dir = seedLivery(gameRoot);
    steamWorkshop.writeSidecar(dir, { appId: '3328490', publishedFileId: '555' });
    const res = await steamWorkshop.publishLivery(gameRoot, 'A20N_CCA', { title: 'v2' });
    expect(res.publishedFileId).toBe('555');
    expect(calls.createItem).toHaveLength(0);
    expect(String(calls.updateItem[0].itemId)).toBe('555');
  });

  it('republishes as a NEW item when the recorded item was deleted on the Workshop', async () => {
    const { lib, calls } = makeFakeLib({ getItemResult: null });
    steamWorkshop._setSteamworksForTests(lib);
    const dir = seedLivery(gameRoot);
    steamWorkshop.writeSidecar(dir, { appId: '3328490', publishedFileId: '555' });
    const res = await steamWorkshop.publishLivery(gameRoot, 'A20N_CCA', { title: 'v2' });
    // The stale id is verified away, a fresh item is created and recorded.
    expect(calls.getItem).toHaveLength(1);
    expect(calls.createItem).toHaveLength(1);
    expect(res.publishedFileId).toBe('123456789');
    expect(steamWorkshop.readSidecar(dir).publishedFileId).toBe('123456789');
  });

  it('creates a replacement when the update fails because the item is gone', async () => {
    const { lib, calls, client } = makeFakeLib();
    // First existence check (pre-flight) says present; after the update fails a
    // second check says gone, so a replacement is created and re-uploaded.
    let checks = 0;
    client.workshop.getItem = async (itemId) => {
      calls.getItem.push({ itemId });
      return checks++ === 0 ? { publishedFileId: itemId } : null;
    };
    let updates = 0;
    client.workshop.updateItemWithCallback = (itemId, details, appId, onSuccess, onError) => {
      calls.updateItem.push({ itemId, details, appId });
      if (updates++ === 0) onError({ code: 'GenericFailure', message: 'a file was not found' });
      else onSuccess({ itemId, needsToAcceptAgreement: false });
    };
    steamWorkshop._setSteamworksForTests(lib);
    const dir = seedLivery(gameRoot);
    steamWorkshop.writeSidecar(dir, { appId: '3328490', publishedFileId: '555' });
    const res = await steamWorkshop.publishLivery(gameRoot, 'A20N_CCA', { title: 'v2' });
    expect(calls.createItem).toHaveLength(1);
    expect(res.publishedFileId).toBe('123456789');
    expect(steamWorkshop.readSidecar(dir).publishedFileId).toBe('123456789');
  });

  it('ignores linkItemId — association comes only from the recorded sidecar', async () => {
    const { lib, calls } = makeFakeLib();
    steamWorkshop._setSteamworksForTests(lib);
    seedLivery(gameRoot);
    const res = await steamWorkshop.publishLivery(gameRoot, 'A20N_CCA', {
      title: 't', linkItemId: 'https://steamcommunity.com/sharedfiles/filedetails/?id=777',
    });
    // A never-uploaded livery creates a fresh item; a pasted id is ignored.
    expect(calls.createItem).toHaveLength(1);
    expect(res.publishedFileId).toBe('123456789');
  });

  it('maps errors to codes', async () => {
    seedLivery(gameRoot);
    // No Steam.
    steamWorkshop._setSteamworksForTests(null);
    await expect(steamWorkshop.publishLivery(gameRoot, 'A20N_CCA', { title: 't' }))
      .rejects.toMatchObject({ code: 'STEAM_UNAVAILABLE' });
    // Empty title.
    steamWorkshop._resetSteamworksForTests();
    steamWorkshop._setSteamworksForTests(makeFakeLib().lib);
    await expect(steamWorkshop.publishLivery(gameRoot, 'A20N_CCA', { title: '  ' }))
      .rejects.toMatchObject({ code: 'BAD_TITLE' });
    // No license.
    steamWorkshop._resetSteamworksForTests();
    steamWorkshop._setSteamworksForTests(makeFakeLib({ subscribed: false }).lib);
    await expect(steamWorkshop.publishLivery(gameRoot, 'A20N_CCA', { title: 't' }))
      .rejects.toMatchObject({ code: 'NO_LICENSE' });
    // Create failure.
    steamWorkshop._resetSteamworksForTests();
    steamWorkshop._setSteamworksForTests(makeFakeLib({ createResult: new Error('denied') }).lib);
    await expect(steamWorkshop.publishLivery(gameRoot, 'A20N_CCA', { title: 't' }))
      .rejects.toMatchObject({ code: 'CREATE_FAILED' });
    // Workshop legal agreement.
    steamWorkshop._resetSteamworksForTests();
    steamWorkshop._setSteamworksForTests(
      makeFakeLib({ createResult: { itemId: BigInt(1), needsToAcceptAgreement: true } }).lib,
    );
    await expect(steamWorkshop.publishLivery(gameRoot, 'A20N_CCA', { title: 't' }))
      .rejects.toMatchObject({ code: 'STEAM_AGREEMENT' });
    // Update failure.
    steamWorkshop._resetSteamworksForTests();
    steamWorkshop._setSteamworksForTests(makeFakeLib({ updateError: new Error('quota') }).lib);
    await expect(steamWorkshop.publishLivery(gameRoot, 'A20N_CCA', { title: 't' }))
      .rejects.toMatchObject({ code: 'UPLOAD_FAILED' });
  });

  it("maps Steam's preview limit error to PREVIEW_LIMIT", async () => {
    const { lib, calls } = makeFakeLib({
      getItemResult: { publishedFileId: BigInt(555) },
      updateError: { code: 'GenericFailure', message: 'limit exceeded' },
    });
    steamWorkshop._setSteamworksForTests(lib);
    const dir = seedLivery(gameRoot);
    steamWorkshop.writeSidecar(dir, { appId: '4004140', publishedFileId: '555' });
    await expect(steamWorkshop.publishLivery(gameRoot, 'A20N_CCA', { title: 't' }))
      .rejects.toMatchObject({ code: 'PREVIEW_LIMIT' });
    // The item exists, so no replacement is created.
    expect(calls.createItem).toHaveLength(0);
    expect(steamWorkshop.toPublicError({ code: 'PREVIEW_LIMIT', message: 'limit exceeded' }))
      .toEqual({ error: 'PREVIEW_LIMIT', detail: 'limit exceeded' });
  });

  it('forwards upload progress to the callback', async () => {
    const { lib } = makeFakeLib({
      progressEvents: [{ status: 3, progress: BigInt(5), total: BigInt(10) }],
    });
    steamWorkshop._setSteamworksForTests(lib);
    seedLivery(gameRoot);
    const seen = [];
    await steamWorkshop.publishLivery(gameRoot, 'A20N_CCA', { title: 't' }, (p) => seen.push(p));
    expect(seen).toEqual([{ status: 3, progress: 5, total: 10 }]);
  });

  it('uses a caller-supplied preview and leaves it on disk', async () => {
    const { lib, calls } = makeFakeLib();
    steamWorkshop._setSteamworksForTests(lib);
    seedLivery(gameRoot);
    const custom = path.join(gameRoot, 'custom.jpg');
    fs.writeFileSync(custom, pngBuffer(64, 64));
    await steamWorkshop.publishLivery(gameRoot, 'A20N_CCA', { title: 't', previewPath: custom });
    expect(calls.updateItem[0].details.previewPath).toBe(custom);
    expect(fs.existsSync(custom)).toBe(true);
  });

  it('saves the preview image in the livery folder and reuses it next upload', async () => {
    const { lib, calls } = makeFakeLib();
    steamWorkshop._setSteamworksForTests(lib);
    const dir = seedLivery(gameRoot);
    const custom = path.join(gameRoot, 'custom.png');
    fs.writeFileSync(custom, pngBuffer(64, 64));
    await steamWorkshop.publishLivery(gameRoot, 'A20N_CCA', { title: 't', previewPath: custom });

    // The image used for the item is remembered in the livery folder + sidecar.
    const savedName = steamWorkshop.readSidecar(dir).previewFile;
    expect(savedName).toBe('.workshop-preview.png');
    const savedPath = path.join(dir, savedName);
    expect(fs.readFileSync(savedPath)).toEqual(fs.readFileSync(custom));

    // The caller's file disappears; the next upload still uses the saved image.
    fs.rmSync(custom);
    await steamWorkshop.publishLivery(gameRoot, 'A20N_CCA', { title: 't2' });
    expect(calls.updateItem[1].details.previewPath).toBe(savedPath);
    expect(fs.existsSync(savedPath)).toBe(true);
  });

  it('shrinks an over-limit preview before submit and remembers the shrunk image', async () => {
    const { lib, calls } = makeFakeLib();
    steamWorkshop._setSteamworksForTests(lib);
    const dir = seedLivery(gameRoot);

    // Fake nativeImage so ensurePreviewUnderLimit re-encodes (Node has none).
    const fakeImg = {
      isEmpty: () => false,
      getSize: () => ({ width: 2048, height: 2048 }),
      resize: () => fakeImg,
      toJPEG: () => Buffer.alloc(600 * 1024),
    };
    livery._setNativeImageForTests({ createFromBuffer: () => fakeImg });

    // A caller-supplied preview that exceeds Steam's 1 MiB cap.
    const oversized = path.join(gameRoot, 'huge.png');
    fs.writeFileSync(oversized, Buffer.alloc(2 * 1024 * 1024));

    await steamWorkshop.publishLivery(gameRoot, 'A20N_CCA', { title: 't', previewPath: oversized });

    // The SHRUNK temp file (not the caller's path) is what reaches Steam.
    const sent = calls.updateItem[0].details.previewPath;
    expect(sent).not.toBe(oversized);
    expect(sent).toContain('ac27-livery-ws-preview');
    expect(path.extname(sent)).toBe('.jpg');
    // The caller's file is left untouched on disk.
    expect(fs.existsSync(oversized)).toBe(true);
    // The shrink temp is cleaned up in the finally.
    expect(fs.existsSync(sent)).toBe(false);
    // The sidecar remembers the shrunk image for the next upload.
    expect(steamWorkshop.readSidecar(dir).previewFile).toBe('.workshop-preview.jpg');
  });

  it('prefills the saved preview image in readPublishInfo', async () => {
    steamWorkshop._setSteamworksForTests(makeFakeLib({ getItemResult: null }).lib);
    const dir = seedLivery(gameRoot);
    fs.writeFileSync(path.join(dir, '.workshop-preview.png'), pngBuffer(64, 64));
    const info = await steamWorkshop.readPublishInfo(gameRoot, 'A20N_CCA');
    expect(info.previewDataUrl).toMatch(/^data:image\/png;base64,/);
  });
});
