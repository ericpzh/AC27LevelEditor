import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileToDataUrl, normalizeToTexture } from '../../src/utils/liveryImage';
import { TEXTURE_SIZE } from '../../src/utils/constants/livery';

// ── Image stub: controllable natural size + failure mode ─────
let imageSize = { w: 100, h: 50 };
let failImage = false;

class MockImage {
  constructor() { this.onload = null; this.onerror = null; this._src = ''; }
  set src(v) {
    this._src = v;
    setTimeout(() => {
      if (failImage || v === 'bad') { if (this.onerror) this.onerror(); return; }
      this.naturalWidth = imageSize.w;
      this.naturalHeight = imageSize.h;
      this.width = imageSize.w;
      this.height = imageSize.h;
      if (this.onload) this.onload();
    }, 0);
  }
  get src() { return this._src; }
}

function makeCtx() {
  return {
    fillStyle: '',
    imageSmoothingEnabled: false,
    imageSmoothingQuality: '',
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  };
}

let ctx;
let getCtxSpy;
let toDataSpy;

beforeEach(() => {
  imageSize = { w: 100, h: 50 };
  failImage = false;
  vi.stubGlobal('Image', MockImage);
  ctx = makeCtx();
  getCtxSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx);
  toDataSpy = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,OUT');
});

afterEach(() => {
  getCtxSpy.mockRestore();
  toDataSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe('fileToDataUrl', () => {
  it('resolves a File to a data-URL', async () => {
    const file = new File(['hello'], 'a.png', { type: 'image/png' });
    const url = await fileToDataUrl(file);
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('rejects with READ_FAILED when the reader errors', async () => {
    class FailingReader {
      readAsDataURL() { setTimeout(() => this.onerror && this.onerror(new Error('nope')), 0); }
    }
    vi.stubGlobal('FileReader', FailingReader);
    await expect(fileToDataUrl(new File(['x'], 'x.png'))).rejects.toThrow('READ_FAILED');
  });
});

describe('normalizeToTexture', () => {
  it('shrinks a large image to fit 2048 and centers it', async () => {
    imageSize = { w: 4096, h: 2048 };
    const out = await normalizeToTexture('data:image/png;base64,BIG');
    expect(out).toBe('data:image/png;base64,OUT');
    expect(ctx.fillStyle).toBe('#ffffff');
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
    // scale 0.5: 2048×1024, centred vertically at y=512.
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 512, 2048, 1024);
    expect(ctx.imageSmoothingEnabled).toBe(true);
    expect(ctx.imageSmoothingQuality).toBe('high');
  });

  it('never upscales a smaller image, only centers it', async () => {
    imageSize = { w: 100, h: 50 };
    await normalizeToTexture('data:image/png;base64,SMALL');
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 974, 999, 100, 50);
  });

  it('honors a custom fill color', async () => {
    await normalizeToTexture('data:image/png;base64,SMALL', 'transparent');
    expect(ctx.fillStyle).toBe('transparent');
  });

  it('rejects BAD_IMAGE when the image fails to load', async () => {
    failImage = true;
    await expect(normalizeToTexture('bad')).rejects.toThrow('BAD_IMAGE');
  });

  it('rejects BAD_IMAGE when the image has no dimensions', async () => {
    imageSize = { w: 0, h: 0 };
    await expect(normalizeToTexture('data:image/png;base64,ZERO')).rejects.toThrow('BAD_IMAGE');
  });
});
