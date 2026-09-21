// @vitest-environment node

/**
 * Tests for the short-lived Steam Workshop worker transport:
 *   • electron/steam-workshop-core.js  — Steam client wrapper (fake lib)
 *   • electron/steam-workshop-bridge.js — spawn / RPC / teardown driver
 *   • electron/steam-workshop-worker.js — plain-node JSON-line child
 *
 * The point of the worker is that SteamAPI never runs in the long-lived main
 * process: the helper exits (and Steam drops the "running" status) once the
 * upload finishes. These tests drive the real child over stdio with a fake
 * steamworks module.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const core = require('../../electron/steam-workshop-core');
const bridge = require('../../electron/steam-workshop-bridge');

const ROOT = path.join(__dirname, '..', '..');

// Minimal fake steamworks module the worker can `require` by path.
function writeFakeLib(dir, opts = {}) {
  const src = `
let client = {
  apps: { isSubscribedApp: () => ${opts.subscribed === false ? 'false' : 'true'} },
  localplayer: { getName: () => 'Tester' },
  workshop: {
    getItem: async () => ${opts.itemExists === false ? 'null' : '({ itemId: 1n })'},
    createItem: async () => ({ itemId: 42n, needsToAcceptAgreement: false }),
    updateItemWithCallback: (id, details, app, onSuccess, onError, onProgress) => {
      if (onProgress) onProgress({ status: 3, progress: 5n, total: 10n });
      ${opts.updateError
        ? 'onError({ code: "GenericFailure", message: ' + JSON.stringify(opts.updateError) + ' });'
        : 'onSuccess({ itemId: id, needsToAcceptAgreement: false });'}
    },
  },
};
module.exports = { init: () => client };
`;
  const p = path.join(dir, 'fake-steamworks.js');
  fs.writeFileSync(p, src, 'utf-8');
  return p;
}

let tmpDirs = [];
let savedPaths = null;

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-worker-'));
  tmpDirs.push(d);
  return d;
}

function useFakeLib(fakePath) {
  savedPaths = { script: bridge._scriptPath, lib: bridge._libPath };
  bridge._scriptPath = () => path.join(ROOT, 'electron', 'steam-workshop-worker.js');
  bridge._libPath = () => fakePath;
  bridge.appId = '4004140';
}

afterEach(() => {
  try { bridge.dispose(); } catch (_) {}
  if (savedPaths) {
    bridge._scriptPath = savedPaths.script;
    bridge._libPath = savedPaths.lib;
    savedPaths = null;
  }
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

describe('steam-workshop-core', () => {
  function fakeClient(over = {}) {
    return {
      apps: { isSubscribedApp: () => over.subscribed !== false },
      localplayer: { getName: () => 'Tester' },
      workshop: {
        getItem: async () => (over.item === undefined ? null : over.item),
        createItem: async () => over.createResult || { itemId: 7n, needsToAcceptAgreement: false },
        updateItemWithCallback: (id, details, app, onSuccess, onError, onProgress) => {
          if (over.progress && onProgress) onProgress(over.progress);
          if (over.updateError) onError(over.updateError);
          else onSuccess({ itemId: id });
        },
      },
    };
  }

  it('initClient folds init failures into STEAM_UNAVAILABLE', () => {
    const lib = { init: () => { throw new Error('no steam'); } };
    try {
      core.initClient(lib, 4004140);
      expect.unreachable();
    } catch (err) {
      expect(err.code).toBe('STEAM_UNAVAILABLE');
    }
  });

  it('initClient rejects an unowned app with NO_LICENSE', () => {
    const lib = { init: () => fakeClient({ subscribed: false }) };
    try {
      core.initClient(lib, 4004140);
      expect.unreachable();
    } catch (err) {
      expect(err.code).toBe('NO_LICENSE');
    }
  });

  it('createItem stringifies the item id', async () => {
    const res = await core.createItem(fakeClient(), 4004140);
    expect(res).toEqual({ itemId: '7', needsToAcceptAgreement: false });
  });

  it('uploadError maps Steam preview-limit to PREVIEW_LIMIT', async () => {
    const err = await core.submitUpdate(
      fakeClient({ updateError: { code: 'GenericFailure', message: 'limit exceeded' } }),
      '1', {}, 4004140, () => {},
    ).catch((e) => e);
    expect(err.code).toBe('PREVIEW_LIMIT');
  });

  it('normalizeItem is BigInt-safe and fills the url', () => {
    const item = core.normalizeItem({ title: 't', tags: ['Livery'], visibility: 1 }, '99');
    expect(item).toEqual({
      title: 't',
      description: '',
      visibility: 1,
      tags: ['Livery'],
      url: 'https://steamcommunity.com/sharedfiles/filedetails/?id=99',
      previewUrl: null,
    });
  });
});

describe('steam-workshop-bridge (real child)', () => {
  it('runs availability/create/update over the worker and exits on release', async () => {
    const dir = tmpDir();
    useFakeLib(writeFakeLib(dir));

    expect(await bridge.availability()).toEqual({
      available: true, appId: '4004140', author: 'Tester',
    });
    expect(await bridge.missing('555')).toBe(false);
    expect(await bridge.createItem()).toEqual({ itemId: '42', needsToAcceptAgreement: false });

    const seen = [];
    const res = await bridge.updateItem('42', { title: 't' }, (p) => seen.push(p));
    expect(res.itemId).toBe('42');
    expect(seen).toEqual([{ status: 3, progress: 5, total: 10 }]);

    expect(bridge.child).toBeTruthy();
    bridge.release();
    // The child must exit so Steam drops the "running" status.
    await waitFor(() => !bridge.child, 4000);
    expect(bridge.child).toBeNull();
  });

  it('reports Steam-unavailable when the app is not owned', async () => {
    const dir = tmpDir();
    useFakeLib(writeFakeLib(dir, { subscribed: false }));
    const gate = await bridge.availability();
    expect(gate.available).toBe(false);
    expect(gate.reason).toBe('NO_LICENSE');
    bridge.dispose();
  });

  it('surfaces worker errors as coded errors', async () => {
    const dir = tmpDir();
    useFakeLib(writeFakeLib(dir, { updateError: 'quota exceeded' }));
    const err = await bridge.updateItem('1', {}).catch((e) => e);
    expect(err.code).toBe('UPLOAD_FAILED');
    expect(err.message).toContain('quota exceeded');
    bridge.dispose();
  });
});

async function waitFor(pred, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for condition');
}
