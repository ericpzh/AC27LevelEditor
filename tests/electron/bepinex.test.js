// @vitest-environment node

/**
 * Tests for electron/bepinex.js — BepInEx download/install/uninstall logic.
 *
 * Mock strategy: bepinex.js is CommonJS (like cloud-llm.js). We use
 * require.cache priming for the 'electron' package, and vi.spyOn on
 * the loaded module's exports to control behavior. File-system tests
 * use real temp directories.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Module from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import { PassThrough } from 'stream';

// ── Prime electron mock in require cache before module loads ──
const mockApp = { getPath: vi.fn(() => os.tmpdir()) };

function primeCache() {
  require.cache[require.resolve('electron')] = {
    id: require.resolve('electron'),
    filename: require.resolve('electron'),
    loaded: true,
    exports: { app: mockApp },
  };
}

function clearCache() {
  delete require.cache[require.resolve('electron')];
  delete require.cache[require.resolve('../../electron/bepinex')];
}

beforeEach(() => {
  clearCache();
  mockApp.getPath.mockReturnValue(os.tmpdir());
  primeCache();
});

afterEach(() => {
  clearCache();
});

function getBepInEx() {
  return require('../../electron/bepinex');
}

// ── Helpers ──────────────────────────────────────────────────

let tmpDirs = [];

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bep-test-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
  tmpDirs = [];
});

function touch(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, 'test', 'utf-8');
}

function mkdir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

// ══════════════════════════════════════════════════════════════
//  checkStatus
// ══════════════════════════════════════════════════════════════

describe('checkStatus', () => {
  it('returns installed:true when all 4 items exist', () => {
    const gameRoot = tmpDir();
    mkdir(path.join(gameRoot, 'BepInEx'));
    mkdir(path.join(gameRoot, 'dotnet'));
    touch(path.join(gameRoot, 'doorstop_config.ini'));
    touch(path.join(gameRoot, 'winhttp.dll'));

    const { checkStatus } = getBepInEx();
    const result = checkStatus(gameRoot);
    expect(result.installed).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('returns installed:false with missing list when some items absent', () => {
    const gameRoot = tmpDir();
    mkdir(path.join(gameRoot, 'BepInEx'));
    // dotnet, doorstop_config.ini, winhttp.dll missing

    const { checkStatus } = getBepInEx();
    const result = checkStatus(gameRoot);
    expect(result.installed).toBe(false);
    expect(result.missing).toContain('dotnet');
    expect(result.missing).toContain('doorstop_config.ini');
    expect(result.missing).toContain('winhttp.dll');
  });

  it('returns installed:false when nothing exists', () => {
    const gameRoot = tmpDir();
    const { checkStatus } = getBepInEx();
    const result = checkStatus(gameRoot);
    expect(result.installed).toBe(false);
    expect(result.missing.length).toBe(4);
  });

  it('handles null/undefined gameRoot', () => {
    const { checkStatus } = getBepInEx();
    const result = checkStatus(null);
    expect(result.installed).toBe(false);
    expect(result.missing.length).toBe(4);
  });
});

// ══════════════════════════════════════════════════════════════
//  findDownloadUrl
// ══════════════════════════════════════════════════════════════

describe('findDownloadUrl', () => {
  it('extracts URL and version from builds page HTML', async () => {
    const bep = getBepInEx();
    const mockBody = '<html><body><a href="/projects/bepinex_be/687/artifacts/BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.725.zip">dl</a></body></html>';
    vi.spyOn(bep, '_httpsGet').mockResolvedValue({ statusCode: 200, headers: {}, body: mockBody });

    const result = await bep.findDownloadUrl();
    expect(result.url).toContain('BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.725.zip');
    expect(result.version).toBe('6.0.0-be.725');
  });

  it('throws BEPINEX_ARTIFACT_NOT_FOUND when no link matches', async () => {
    const bep = getBepInEx();
    vi.spyOn(bep, '_httpsGet').mockResolvedValue({ statusCode: 200, headers: {}, body: '<html>No artifacts</html>' });

    await expect(bep.findDownloadUrl()).rejects.toThrow('BEPINEX_ARTIFACT_NOT_FOUND');
  });

  it('throws on HTTP error status', async () => {
    const bep = getBepInEx();
    vi.spyOn(bep, '_httpsGet').mockRejectedValue(new Error('BEPINEX_HTTP_404'));

    await expect(bep.findDownloadUrl()).rejects.toThrow('BEPINEX_HTTP_404');
  });
});

// ══════════════════════════════════════════════════════════════
//  downloadZip
// ══════════════════════════════════════════════════════════════

describe('downloadZip', () => {
  let httpsGetSpy;

  afterEach(() => {
    httpsGetSpy?.mockRestore();
    httpsGetSpy = null;
  });

  /** Mock https.get to simulate a download response stream. */
  function mockHttpsResponse(statusCode, headers, chunks) {
    const response = new PassThrough();
    response.statusCode = statusCode;
    response.headers = { ...headers };

    const mockReq = { on: vi.fn().mockReturnThis(), destroy: vi.fn() };
    httpsGetSpy = vi.spyOn(https, 'get').mockImplementation((url, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; opts = undefined; }
      cb(response); // synchronous — lets downloadZip register data/end listeners
      if (chunks && chunks.length > 0) {
        for (const chunk of chunks) response.write(chunk);
        response.end();
      }
      return mockReq;
    });

    return { response, mockReq };
  }

  it('downloads file to disk with correct content and reports 0→100% progress', async () => {
    const dir = tmpDir();
    const destPath = path.join(dir, 'bep.zip');

    const content = Buffer.alloc(1000, 'X');
    mockHttpsResponse(200, { 'content-length': '1000' }, [content]);

    const bep = getBepInEx();
    const progressCb = vi.fn();
    const result = await bep.downloadZip('https://example.com/bep.zip', destPath, progressCb);

    expect(result).toBe(destPath);
    expect(fs.existsSync(destPath)).toBe(true);
    const onDisk = fs.readFileSync(destPath);
    expect(onDisk.length).toBe(1000);
    // All content should be 'X'
    expect(onDisk.every(b => b === 0x58)).toBe(true);
    // Progress reached 100%
    expect(progressCb).toHaveBeenCalled();
    expect(progressCb).toHaveBeenLastCalledWith(100);
    // Was called at least once with some value
    expect(progressCb.mock.calls[0][0]).toBeGreaterThanOrEqual(0);
  });

  it('reports incremental progress for multi-chunk downloads', async () => {
    const dir = tmpDir();
    const destPath = path.join(dir, 'bep.zip');

    const { response, mockReq } = mockHttpsResponse(200, { 'content-length': '100' }, []);
    // Replace the mock to send 3 chunks manually with intermediate progress
    httpsGetSpy.mockImplementation((url, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; opts = undefined; }
      cb(response);
      response.write(Buffer.alloc(20, 'A'));
      response.write(Buffer.alloc(30, 'B'));
      response.write(Buffer.alloc(50, 'C'));
      response.end();
      return mockReq;
    });

    const bep = getBepInEx();
    const progressCb = vi.fn();
    await bep.downloadZip('https://example.com/bep.zip', destPath, progressCb);

    // Should have reported progress after each chunk: 20%, 50%, 100%
    expect(progressCb.mock.calls.map(c => c[0])).toEqual([20, 50, 100]);
    expect(fs.existsSync(destPath)).toBe(true);
    expect(fs.statSync(destPath).size).toBe(100);
  });

  it('rejects with BEPINEX_DOWNLOAD_HTTP_404 on 404 status', async () => {
    const dir = tmpDir();
    const destPath = path.join(dir, 'bep.zip');

    mockHttpsResponse(404, {}, [Buffer.alloc(10)]);

    const bep = getBepInEx();
    await expect(
      bep.downloadZip('https://example.com/bep.zip', destPath, vi.fn())
    ).rejects.toThrow('BEPINEX_DOWNLOAD_HTTP_404');

    // File should be cleaned up on error
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it('rejects on request error', async () => {
    const dir = tmpDir();
    const destPath = path.join(dir, 'bep.zip');

    const { mockReq } = mockHttpsResponse(200, {}, []);
    httpsGetSpy.mockImplementation((url, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; opts = undefined; }
      // Need headers/statusCode so the response callback doesn't crash on res.headers
      const res = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
      cb(res);
      // Trigger error asynchronously so req.on('error') is registered first
      setImmediate(() => {
        const errCb = mockReq.on.mock.calls.find(c => c[0] === 'error')?.[1];
        if (errCb) errCb(new Error('ECONNREFUSED'));
      });
      return mockReq;
    });

    const bep = getBepInEx();
    await expect(
      bep.downloadZip('https://example.com/bep.zip', destPath, vi.fn())
    ).rejects.toThrow('ECONNREFUSED');

    expect(fs.existsSync(destPath)).toBe(false);
  });

  it('rejects with BEPINEX_DOWNLOAD_TIMEOUT on timeout', async () => {
    const dir = tmpDir();
    const destPath = path.join(dir, 'bep.zip');

    const { mockReq } = mockHttpsResponse(200, {}, []);
    httpsGetSpy.mockImplementation((url, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; opts = undefined; }
      const res = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
      cb(res);
      // Trigger timeout asynchronously so req.on('timeout') is registered first
      setImmediate(() => {
        const timeoutCb = mockReq.on.mock.calls.find(c => c[0] === 'timeout')?.[1];
        if (timeoutCb) timeoutCb();
      });
      return mockReq;
    });

    const bep = getBepInEx();
    await expect(
      bep.downloadZip('https://example.com/bep.zip', destPath, vi.fn())
    ).rejects.toThrow('BEPINEX_DOWNLOAD_TIMEOUT');

    expect(fs.existsSync(destPath)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
//  extractZip
// ══════════════════════════════════════════════════════════════

describe('extractZip', () => {
  it('throws BEPINEX_WINDOWS_ONLY on non-Windows', async () => {
    const bep = getBepInEx();
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    await expect(bep.extractZip('/tmp/bep.zip', '/tmp/extract')).rejects.toThrow('BEPINEX_WINDOWS_ONLY');
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });
});

// ══════════════════════════════════════════════════════════════
//  installFiles
// ══════════════════════════════════════════════════════════════

describe('installFiles', () => {
  it('copies 4 items from subdirectory to game root', () => {
    const extractDir = tmpDir();
    const gameRoot = tmpDir();

    // Create ZIP-like structure: extractDir/BepInEx_6.0.0/BepInEx/, dotnet/, doorstop, winhttp
    const subDir = path.join(extractDir, 'BepInEx-Unity.IL2CPP-win-x64-6.0.0');
    mkdir(path.join(subDir, 'BepInEx'));
    touch(path.join(subDir, 'BepInEx', 'core', 'BepInEx.dll'));
    mkdir(path.join(subDir, 'dotnet'));
    touch(path.join(subDir, 'dotnet', 'System.dll'));
    touch(path.join(subDir, 'doorstop_config.ini'));
    touch(path.join(subDir, 'winhttp.dll'));

    const { installFiles } = getBepInEx();
    installFiles(extractDir, gameRoot);

    expect(fs.existsSync(path.join(gameRoot, 'BepInEx', 'core', 'BepInEx.dll'))).toBe(true);
    expect(fs.existsSync(path.join(gameRoot, 'dotnet', 'System.dll'))).toBe(true);
    expect(fs.existsSync(path.join(gameRoot, 'doorstop_config.ini'))).toBe(true);
    expect(fs.existsSync(path.join(gameRoot, 'winhttp.dll'))).toBe(true);
  });

  it('skips missing items gracefully', () => {
    const extractDir = tmpDir();
    const gameRoot = tmpDir();

    const subDir = path.join(extractDir, 'BepInEx_6.0.0');
    mkdir(path.join(subDir, 'BepInEx'));
    touch(path.join(subDir, 'BepInEx', 'core', 'BepInEx.dll'));
    // dotnet/ intentionally missing
    touch(path.join(subDir, 'doorstop_config.ini'));
    touch(path.join(subDir, 'winhttp.dll'));

    const { installFiles } = getBepInEx();
    installFiles(extractDir, gameRoot);

    expect(fs.existsSync(path.join(gameRoot, 'BepInEx'))).toBe(true);
    expect(fs.existsSync(path.join(gameRoot, 'dotnet'))).toBe(false); // skipped
    expect(fs.existsSync(path.join(gameRoot, 'doorstop_config.ini'))).toBe(true);
  });

  it('works without subdirectory (flat extraction)', () => {
    const extractDir = tmpDir();
    const gameRoot = tmpDir();

    // Flat structure — no wrapping folder
    mkdir(path.join(extractDir, 'BepInEx'));
    touch(path.join(extractDir, 'BepInEx', 'core', 'BepInEx.dll'));
    mkdir(path.join(extractDir, 'dotnet'));
    touch(path.join(extractDir, 'doorstop_config.ini'));
    touch(path.join(extractDir, 'winhttp.dll'));

    const { installFiles } = getBepInEx();
    installFiles(extractDir, gameRoot);

    expect(fs.existsSync(path.join(gameRoot, 'BepInEx', 'core', 'BepInEx.dll'))).toBe(true);
    expect(fs.existsSync(path.join(gameRoot, 'dotnet'))).toBe(true);
    expect(fs.existsSync(path.join(gameRoot, 'doorstop_config.ini'))).toBe(true);
    expect(fs.existsSync(path.join(gameRoot, 'winhttp.dll'))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
//  removeFiles
// ══════════════════════════════════════════════════════════════

describe('removeFiles', () => {
  it('removes all existing items', () => {
    const gameRoot = tmpDir();
    mkdir(path.join(gameRoot, 'BepInEx'));
    touch(path.join(gameRoot, 'BepInEx', 'dummy.txt'));
    mkdir(path.join(gameRoot, 'dotnet'));
    touch(path.join(gameRoot, 'doorstop_config.ini'));
    touch(path.join(gameRoot, 'winhttp.dll'));

    const { removeFiles } = getBepInEx();
    const result = removeFiles(gameRoot);

    expect(result.removed).toEqual(['BepInEx', 'dotnet', 'doorstop_config.ini', 'winhttp.dll']);
    expect(result.errors).toEqual([]);
    expect(fs.existsSync(path.join(gameRoot, 'BepInEx'))).toBe(false);
    expect(fs.existsSync(path.join(gameRoot, 'dotnet'))).toBe(false);
    expect(fs.existsSync(path.join(gameRoot, 'doorstop_config.ini'))).toBe(false);
    expect(fs.existsSync(path.join(gameRoot, 'winhttp.dll'))).toBe(false);
  });

  it('only removes items that exist', () => {
    const gameRoot = tmpDir();
    mkdir(path.join(gameRoot, 'BepInEx'));
    touch(path.join(gameRoot, 'doorstop_config.ini'));
    // dotnet/ and winhttp.dll don't exist

    const { removeFiles } = getBepInEx();
    const result = removeFiles(gameRoot);

    expect(result.removed).toEqual(['BepInEx', 'doorstop_config.ini']);
    expect(fs.existsSync(path.join(gameRoot, 'BepInEx'))).toBe(false);
  });

  it('handles non-existent items gracefully', () => {
    const gameRoot = tmpDir();
    // No BepInEx items exist at all
    const { removeFiles } = getBepInEx();
    const result = removeFiles(gameRoot);
    expect(result.removed).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════
//  installLatest (orchestrator)
// ══════════════════════════════════════════════════════════════

describe('installLatest', () => {
  it('runs full pipeline and returns success with version', async () => {
    const bep = getBepInEx();
    const gameRoot = tmpDir();

    // Mock all sub-functions
    vi.spyOn(bep, 'findDownloadUrl').mockResolvedValue({ url: 'https://example.com/bep.zip', version: '6.0.0-test' });
    vi.spyOn(bep, 'downloadZip').mockResolvedValue('/tmp/bep.zip');
    vi.spyOn(bep, 'extractZip').mockResolvedValue(undefined);
    vi.spyOn(bep, 'installFiles').mockImplementation(() => {});

    const progressEvents = [];
    const result = await bep.installLatest(gameRoot, (data) => {
      progressEvents.push(data);
    });

    expect(result.success).toBe(true);
    expect(result.version).toBe('6.0.0-test');
    expect(progressEvents.length).toBeGreaterThanOrEqual(4);

    // Verify progress range
    const percents = progressEvents.map((e) => e.percent);
    expect(percents[0]).toBeGreaterThanOrEqual(0);
    expect(percents[percents.length - 1]).toBe(100);
  });

  it('returns error on failure', async () => {
    const bep = getBepInEx();
    const gameRoot = tmpDir();

    vi.spyOn(bep, 'findDownloadUrl').mockRejectedValue(new Error('BEPINEX_HTTP_404'));

    const result = await bep.installLatest(gameRoot, () => {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('BEPINEX_HTTP_404');
  });

  it('covers download progress normalization (5-85%)', async () => {
    const bep = getBepInEx();
    const gameRoot = tmpDir();

    vi.spyOn(bep, 'findDownloadUrl').mockResolvedValue({ url: 'https://example.com/bep.zip', version: '1.0.0' });
    vi.spyOn(bep, 'downloadZip').mockImplementation(async (url, dest, onProgress) => {
      onProgress(0);
      onProgress(50);
      onProgress(100);
      return dest;
    });
    vi.spyOn(bep, 'extractZip').mockResolvedValue(undefined);
    vi.spyOn(bep, 'installFiles').mockImplementation(() => {});

    const progressEvents = [];
    await bep.installLatest(gameRoot, (data) => progressEvents.push(data));

    const downloadEvents = progressEvents.filter((e) => e.message === 'bepinex_downloading');
    expect(downloadEvents.length).toBeGreaterThan(0);
    // First download event should be around 5%
    expect(downloadEvents[0].percent).toBeGreaterThanOrEqual(5);
    expect(downloadEvents[0].percent).toBeLessThanOrEqual(10);
  });
});
