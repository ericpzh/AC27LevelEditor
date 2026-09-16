import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LiveryCanvas from '../../../src/components/LiveryScreen/LiveryCanvas';
import CreateTab from '../../../src/components/LiveryScreen/CreateTab';
import Modal from '../../../src/components/common/Modal';
import Toast from '../../../src/components/common/Toast';
import { useAppStore } from '../../../src/store/appStore';
import { mockIpcInvoke } from '../../setup';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { setLang } from '../../../src/utils/i18n';

// ── Canvas stubs (jsdom has no 2d context) ───────────────────
let ctxs = [];
function makeCtx() {
  return {
    save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(),
    fillRect: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    fill: vi.fn(), rect: vi.fn(), ellipse: vi.fn(), arc: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(), putImageData: vi.fn(), translate: vi.fn(), rotate: vi.fn(),
    getImageData: vi.fn((x, y, w, h) => ({
      data: new Uint8ClampedArray(Math.max(4, w * h * 4)),
      width: w, height: h,
    })),
  };
}

class MockImage {
  constructor() { this._src = ''; this.onload = null; this.onerror = null; }
  set src(v) {
    this._src = v;
    setTimeout(() => {
      this.naturalWidth = 100; this.naturalHeight = 50;
      this.width = 100; this.height = 50;
      if (this.onload) this.onload();
    }, 0);
  }
  get src() { return this._src; }
}

const FAKE_SAVE = 'data:image/png;base64,SAVE2048';

let getCtxSpy;
let toDataSpy;
let rectSpy;

beforeEach(() => {
  setLang('en');
  useAppStore.setState(useAppStore.getInitialState());
  CreateTab.prefill = null;
  ctxs = [];
  getCtxSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    const c = makeCtx();
    ctxs.push(c);
    return c;
  });
  toDataSpy = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(FAKE_SAVE);
  rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 512, height: 512, right: 512, bottom: 512, x: 0, y: 0, toJSON() {},
  });
  vi.stubGlobal('Image', MockImage);
  mockIpcInvoke.mockImplementation(() => Promise.resolve({}));
});

afterEach(() => {
  getCtxSpy.mockRestore();
  toDataSpy.mockRestore();
  rectSpy.mockRestore();
  vi.unstubAllGlobals();
});

function renderCanvas(props = {}) {
  return render(
    <I18nProvider>
      <LiveryCanvas {...props} />
      <Modal />
      <Toast />
    </I18nProvider>
  );
}

function mainCanvas() {
  return document.querySelector('.livery-canvas-wrap canvas');
}

describe('LiveryCanvas tools', () => {
  it('switches the active tool one at a time', async () => {
    const user = userEvent.setup();
    renderCanvas();
    const brushBtn = screen.getByText('Brush').closest('button');
    expect(brushBtn.className).toContain('tool-active');
    await user.click(screen.getByText('Eraser').closest('button'));
    expect(screen.getByText('Eraser').closest('button').className).toContain('tool-active');
    expect(brushBtn.className).not.toContain('tool-active');
    await user.click(screen.getByText('Text').closest('button'));
    expect(screen.getByText('Text').closest('button').className).toContain('tool-active');
  });

  it('a brush stroke changes pixels (ctx.stroke called)', async () => {
    renderCanvas();
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 120, clientY: 120, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    const main = ctxs[0];
    expect(main.getImageData).toHaveBeenCalled(); // undo snapshot
    expect(main.stroke).toHaveBeenCalled();
    expect(main.lineTo).toHaveBeenCalled();
  });

  it('text commit flattens to raster (fillText called)', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByText('Text').closest('button'));
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    const input = screen.getByPlaceholderText('Type text, Enter to commit…');
    await user.type(input, 'hello');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(ctxs[0].fillText).toHaveBeenCalledWith('hello', expect.any(Number), expect.any(Number));
  });

  it('sticker import + commit flattens (drawImage called)', async () => {
    const user = userEvent.setup();
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      return Promise.resolve({});
    });
    renderCanvas();
    await user.click(screen.getByText('Sticker').closest('button'));
    await user.click(screen.getByText('Import Sticker'));
    await waitFor(() => {
      expect(screen.getByText('Place Sticker')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Place Sticker'));
    const draws = ctxs[0].drawImage.mock.calls;
    expect(draws.length).toBeGreaterThan(0);
    const last = draws[draws.length - 1];
    // commit draws (img, -w/2, -h/2, w, h)
    expect(last).toHaveLength(5);
  });
});

describe('paint save payload', () => {
  it('save calls createLivery with a 2048 PNG data-URL', async () => {
    const user = userEvent.setup();
    CreateTab.prefill = {
      folder: 'A20N_CCA', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo',
      imageDataUrl: 'data:image/png;base64,BASE',
    };
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'create-livery') return Promise.resolve({ success: true, folder: 'A20N_CCA' });
      return Promise.resolve({ success: true, mine: [], reference: [] });
    });
    render(
      <I18nProvider>
        <CreateTab onCreated={() => {}} />
        <Modal />
        <Toast />
      </I18nProvider>
    );
    // Paint mode is default with a prefill; airline/aircraft prefilled.
    const saveBtn = await screen.findByText('Create Livery', { selector: 'button' });
    await waitFor(() => expect(saveBtn.closest('button').disabled).toBe(false));
    await user.click(saveBtn.closest('button'));
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('create-livery', expect.objectContaining({
        airline: 'CCA',
        targetPlaneId: 'AIRBUS A-320neo',
        shortCode: 'A20N',
      }));
    });
    const payload = mockIpcInvoke.mock.calls.find(c => c[0] === 'create-livery')[1];
    expect(payload.imageDataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });
});
